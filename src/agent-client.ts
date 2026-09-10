/**
 * Client side of the restart agent: discovery, spawning, and the HTTP calls
 * the host plugin makes.
 *
 * Shared by the plugin bundle and the CLI bundle, so it must stay free of
 * `@deepseek-ai/*` imports.
 * @module dsh-restart/agent-client
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo, AgentStatus, RestartReport, RestartRequest } from './protocol.ts'
import { ENV_STATE_DIR } from './protocol.ts'
import { ensureDir, readJson, sleep, writeTextAtomic } from './fsx.ts'
import type { StatePaths } from './paths.ts'
import { isAlive, probeHttp } from './agent/process-control.ts'

/** Control token length in bytes. */
const TOKEN_BYTES = 32

/**
 * Internal command that spawns a detached agent and exits immediately.
 *
 * Running it through a short-lived launcher is what reparents the real agent
 * away from the harness process tree.
 */
export const SPAWN_COMMAND = '__spawn-detached'

/**
 * Whether an ancestor command line belongs to a running DeepSeek Harness.
 *
 * Both spellings matter: the launcher itself, and the per-command runner the
 * harness uses for shell tools (`subprocess-local`), which is what actually
 * appears in the chain when a command is run from inside a session.
 */
const HARNESS_ANCESTOR = /apps[\\/]cli[\\/]src[\\/]bin\.ts|subprocess-local|deepseek-harness[\\/]apps[\\/]cli/

/**
 * Describe the running harness session this process was started from, if any.
 *
 * This is a safety check, not a curiosity. The harness runs every shell
 * command inside a Windows Job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,
 * and Job membership is inherited by ordinary descendants. An agent started
 * from inside a session therefore dies with the harness — including in the
 * middle of a restart it is performing, which leaves the harness stopped and
 * needs a manual start. An agent started from a plain terminal has no such
 * ancestor and is safe.
 * @param startPid - process to begin the walk from (defaults to this one).
 * @param maxDepth - ancestor levels to inspect.
 * @returns a short description of the harness ancestor, or `undefined`.
 */
export function detectHarnessAncestor(startPid = process.pid, maxDepth = 12): string | undefined {
  if (process.platform !== 'win32') return undefined
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!existsSync(powershell)) return undefined
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$p = ${String(startPid)}`,
    '$out = @()',
    `for ($i = 0; $i -lt ${String(maxDepth)} -and $p -and $p -ne 0; $i++) {`,
    '  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p"',
    '  if (-not $proc) { break }',
    '  $cmd = ($proc.CommandLine -replace "`r?`n", " ")',
    '  $out += ($proc.ProcessId.ToString() + "|" + $proc.ParentProcessId.ToString() + "|" + $cmd)',
    '  $p = $proc.ParentProcessId',
    '}',
    '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($out -join "`n")))',
  ].join('\n')
  try {
    const result = spawnSync(powershell, [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined
    const decoded = Buffer.from(result.stdout.trim(), 'base64').toString('utf8')
    for (const line of decoded.split('\n')) {
      const [pid, , command = ''] = line.split('|')
      if (pid === undefined || command === '') continue
      if (HARNESS_ANCESTOR.test(command)) {
        return `pid ${pid.trim()}: ${command.trim().slice(0, 160)}`
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Read (or create) the shared control token.
 * @param paths - state layout.
 * @returns the token, hex encoded.
 */
export function ensureToken(paths: StatePaths): string {
  try {
    const existing = readFileSync(paths.token, 'utf8').trim()
    if (existing.length >= 32) return existing
  } catch {
    // Absent or unreadable: mint a fresh one below.
  }
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  writeTextAtomic(paths.token, `${token}\n`, 0o600)
  return token
}

/**
 * Read the recorded agent identity.
 * @param paths - state layout.
 * @returns the identity, or `undefined` when no agent ever registered.
 */
export function readAgentInfo(paths: StatePaths): AgentInfo | undefined {
  return readJson<AgentInfo>(paths.agentInfo)
}

/**
 * Probe a recorded agent for liveness.
 * @param info - recorded identity.
 * @param timeoutMs - probe budget.
 * @returns true when the recorded process is alive and answering.
 */
export async function agentAlive(info: AgentInfo, timeoutMs = 1_500): Promise<boolean> {
  if (!isAlive(info.pid)) return false
  return probeHttp(`${info.url}/health`, timeoutMs)
}

/** Options for {@link ensureAgent}. */
export interface EnsureAgentOptions {
  paths: StatePaths
  /** Absolute path of the agent bundle entry to spawn. */
  entry: string
  host: string
  port: number
  idleMs: number
  log: (line: string) => void
  /** Extra CLI arguments appended to the `serve` invocation. */
  extraArgs?: readonly string[]
  /** How long to wait for a freshly spawned agent to answer. */
  waitMs?: number
}

/**
 * Make sure a control agent is running, spawning one when necessary.
 * @param options - state layout, entry point, bind settings, and logging.
 * @returns the live agent identity, or `undefined` when it could not be started.
 */
export async function ensureAgent(options: EnsureAgentOptions): Promise<AgentInfo | undefined> {
  const { paths, log } = options
  ensureDir(paths.root)
  ensureToken(paths)
  const existing = readAgentInfo(paths)
  if (existing !== undefined && await agentAlive(existing)) return existing

  const previousPid = existing?.pid
  const startedAfter = Date.now()
  // Two stages on purpose: the direct child is a launcher that exits at once,
  // so the real agent is orphaned instead of becoming a descendant of the
  // harness. That is what keeps the harness's own `taskkill /T /F` (used when
  // it has to be forced down) from taking the supervisor with it.
  const args = [
    options.entry,
    SPAWN_COMMAND,
    'serve',
    '--port', String(options.port),
    '--host', options.host,
    '--idle-ms', String(options.idleMs),
    ...options.extraArgs ?? [],
  ]
  log(`starting the control agent: ${process.execPath} ${args.join(' ')}`)
  const child = spawn(process.execPath, args, {
    // Deliberately NOT the plugin's own directory. On Windows a process's
    // working directory holds a handle on it, and a long-lived agent sitting
    // inside `node_modules/dsh-restart` makes `pnpm add` fail with EPERM the
    // next time the plugin is reinstalled — which is exactly how a profile was
    // left without its restart plugin. The home directory always exists and
    // belongs to no package.
    cwd: homedir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, [ENV_STATE_DIR]: paths.root },
  })
  child.unref()

  const deadline = Date.now() + (options.waitMs ?? 10_000)
  while (Date.now() < deadline) {
    await sleep(250)
    const info = readAgentInfo(paths)
    if (info === undefined) continue
    // The launcher's pid is short-lived by design; identity is carried by the
    // registration timestamp and the pid the agent reports for itself.
    if (info.pid === previousPid && previousPid !== undefined) continue
    if (Date.parse(info.startedAt) < startedAfter - 5_000) continue
    if (await agentAlive(info)) return info
  }
  log(`the control agent did not answer within ${String(options.waitMs ?? 10_000)} ms`)
  return undefined
}

/** Options shared by the agent HTTP calls. */
export interface AgentCallOptions {
  info: AgentInfo
  token: string
  timeoutMs?: number
}

function headers(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

/**
 * Fetch the agent's status document.
 * @param options - endpoint, token, and timeout.
 * @returns the status, or `undefined` when the agent did not answer.
 */
export async function fetchStatus(options: AgentCallOptions): Promise<AgentStatus | undefined> {
  try {
    const response = await fetch(`${options.info.url}/status`, {
      headers: headers(options.token),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    })
    if (!response.ok) return undefined
    return await response.json() as AgentStatus
  } catch {
    return undefined
  }
}

/** Result of asking the agent to restart the harness. */
export type RestartCallResult =
  | { accepted: true; report?: RestartReport; message: string }
  | { accepted: false; error: string }

/**
 * Ask the agent to restart the harness.
 * @param options - endpoint, token, and timeout.
 * @param request - restart reason and per-call overrides.
 * @param wait - true to hold the connection until the restart settles.
 * @returns whether the request was accepted, plus the report when waiting.
 */
export async function callRestart(
  options: AgentCallOptions,
  request: RestartRequest & { wait?: boolean },
  wait: boolean,
): Promise<RestartCallResult> {
  try {
    const response = await fetch(`${options.info.url}/restart`, {
      method: 'POST',
      headers: headers(options.token),
      // A waited restart can legitimately take minutes; an un-waited one only
      // has to reach the agent before this process dies.
      signal: AbortSignal.timeout(wait ? (options.timeoutMs ?? 900_000) : 5_000),
      body: JSON.stringify({ ...request, wait }),
    })
    const body = await response.json() as Record<string, unknown>
    if (!response.ok) {
      return { accepted: false, error: typeof body.error === 'string' ? body.error : `agent answered ${String(response.status)}` }
    }
    if (wait) {
      return {
        accepted: true,
        report: body as unknown as RestartReport,
        message: typeof body.headline === 'string' ? body.headline : 'restart finished',
      }
    }
    return {
      accepted: true,
      message: typeof body.message === 'string' ? body.message : 'restart accepted',
    }
  } catch (error) {
    return { accepted: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Report a committed startup back to the agent supervising this boot.
 * @param options - endpoint, token, and timeout.
 * @param attempt - the attempt identity injected into this process's environment.
 * @param url - optional endpoint the harness confirms as answering.
 * @returns true when the agent accepted the signal.
 */
export async function postReady(
  options: AgentCallOptions,
  attempt: string,
  url?: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${options.info.url}/ready`, {
      method: 'POST',
      headers: headers(options.token),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      body: JSON.stringify({ attempt, ...(url === undefined ? {} : { url }) }),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Ask a running agent to exit.
 * @param options - endpoint, token, and timeout.
 * @returns true when the agent acknowledged.
 */
export async function postShutdown(options: AgentCallOptions): Promise<boolean> {
  try {
    const response = await fetch(`${options.info.url}/shutdown`, {
      method: 'POST',
      headers: headers(options.token),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    })
    return response.ok
  } catch {
    return false
  }
}
