/**
 * The standalone restart agent: process entry, command line, and the
 * long-lived `serve` mode the host plugin spawns.
 *
 * `serve` owns the loopback control port and supervises every restart. The
 * other subcommands are the manual path — useful precisely when the harness
 * cannot start at all and therefore cannot ask for its own rollback.
 * @module dsh-restart/agent/main
 */

import { spawn } from 'node:child_process'
import { appendFileSync, realpathSync, statSync, truncateSync } from 'node:fs'
import type { Server } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentInfo, RestartReport, RestartRequest } from '../protocol.ts'
import { STATE_VERSION } from '../protocol.ts'
import {
  ensureDir, isFile, listDir, nowIso, readJson, writeJsonAtomic,
} from '../fsx.ts'
import { resolveStateDir, instancePaths, statePaths } from '../paths.ts'
import {
  SPAWN_COMMAND, agentAlive, callRestart, detectHarnessAncestor, ensureAgent, ensureToken,
  fetchStatus, postShutdown, readAgentInfo,
} from '../agent-client.ts'
import { readBaselineManifest } from '../snapshot.ts'
import { isAlive } from './process-control.ts'
import { createAgentServer } from './server.ts'
import { Supervisor } from './supervisor.ts'

/** Version reported by the agent and required in its health document. */
export const AGENT_VERSION = '0.1.0'

/** Default loopback control port. */
const DEFAULT_PORT = 3099

/** Default idle window before an unsupervised agent exits. */
const DEFAULT_IDLE_MS = 30 * 60 * 1_000

/** Default readiness budget for one boot attempt. */
const DEFAULT_READY_TIMEOUT_MS = 180_000

/** Default grace granted to the outgoing process. */
const DEFAULT_STOP_GRACE_MS = 20_000

/** How long a started process must stay healthy to count as up. */
const DEFAULT_SETTLE_MS = 2_500

/** Trailing log characters copied into a report. */
const DEFAULT_LOG_TAIL_CHARS = 6_000

/** Rotate the agent's own log at this size. */
const AGENT_LOG_LIMIT_BYTES = 2 << 20

/** Parsed command line. */
interface ParsedArgs {
  command: 'serve' | 'status' | 'restart' | 'rollback' | 'stop' | 'help'
  port: number
  host: string
  stateDir: string | undefined
  idleMs: number
  readyTimeoutMs: number
  stopGraceMs: number
  settleMs: number
  reason: string
  requestedBy: string
  json: boolean
}

const HELP = `dsh-restart — out-of-process restart supervisor for DeepSeek Harness

Usage:
  dsh-restart serve [--port 3099] [--host 127.0.0.1] [--idle-ms 1800000]
  dsh-restart status [--json]
  dsh-restart restart [--reason "why"] [--json]
  dsh-restart rollback [--reason "why"] [--json]
  dsh-restart stop

Environment:
  DSH_RESTART_STATE_DIR   state directory (default: $DSH_HOME/dsh-restart)
  DSH_RESTART_PORT        default control port (default: 3099)

The agent restarts dsh with the exact launch specification the running
harness recorded, waits for the plugin's committed-startup callback, and —
when the new process dies or never comes up — restores the last known-good
configuration snapshot and tries once more. Every outcome is written to
<state>/reports/ and read by the next boot.
`

/**
 * Parse the agent command line.
 * @param argv - arguments after the executable.
 * @returns the resolved invocation.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const envPort = Number(process.env.DSH_RESTART_PORT ?? '')
  const args: ParsedArgs = {
    command: 'serve',
    port: Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_PORT,
    host: '127.0.0.1',
    stateDir: undefined,
    idleMs: DEFAULT_IDLE_MS,
    readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
    stopGraceMs: DEFAULT_STOP_GRACE_MS,
    settleMs: DEFAULT_SETTLE_MS,
    reason: 'manual restart requested from the command line',
    requestedBy: 'cli',
    json: false,
  }
  const queue = [...argv]
  const first = queue[0]
  if (first !== undefined && !first.startsWith('-')) {
    const command = queue.shift() as ParsedArgs['command']
    if (!['serve', 'status', 'restart', 'rollback', 'stop', 'help'].includes(command)) {
      throw new Error(`unknown command ${JSON.stringify(command)}`)
    }
    args.command = command
  }
  while (queue.length > 0) {
    const flag = queue.shift() as string
    const value = (): string => {
      const next = queue.shift()
      if (next === undefined) throw new Error(`${flag} needs a value`)
      return next
    }
    switch (flag) {
      case '--port': args.port = Number(value()); break
      case '--host': args.host = value(); break
      case '--state-dir': args.stateDir = value(); break
      case '--idle-ms': args.idleMs = Number(value()); break
      case '--ready-timeout-ms': args.readyTimeoutMs = Number(value()); break
      case '--stop-grace-ms': args.stopGraceMs = Number(value()); break
      case '--settle-ms': args.settleMs = Number(value()); break
      case '--reason': args.reason = value(); break
      case '--requested-by': args.requestedBy = value(); break
      case '--json': args.json = true; break
      case '--help':
      case '-h': args.command = 'help'; break
      default: throw new Error(`unknown flag ${JSON.stringify(flag)}`)
    }
  }
  return args
}

/** Bind a server, walking the port upward when the requested one is taken. */
async function listenWithFallback(server: Server, host: string, port: number): Promise<number> {
  for (let offset = 0; offset <= 10; offset += 1) {
    const candidate = port + offset
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(candidate, host)
      })
      return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE' || offset === 10) throw error
    }
  }
  throw new Error('unreachable')
}

/** Append one line to the agent's own log file, rotating it when it grows. */
function makeLogger(logFile: string): (line: string) => void {
  ensureDir(dirname(logFile))
  try {
    if (isFile(logFile) && statSync(logFile).size > AGENT_LOG_LIMIT_BYTES) truncateSync(logFile, 0)
  } catch {
    // A log that cannot be rotated must not stop the agent.
  }
  return (line: string): void => {
    const text = `[${nowIso()}] ${line}\n`
    try {
      appendFileSync(logFile, text)
    } catch {
      // Logging is best effort.
    }
    process.stderr.write(`[dsh-restart] ${line}\n`)
  }
}

/** Run the long-lived control agent. */
async function serve(args: ParsedArgs): Promise<number> {
  const paths = statePaths(args.stateDir ?? resolveStateDir())
  ensureDir(paths.root)
  ensureDir(paths.reports)
  ensureDir(paths.logs)
  const log = makeLogger(join(paths.logs, 'agent.log'))
  const token = ensureToken(paths)

  // Mutated after bind; the server and supervisor share this object by
  // reference so the real port reaches every reader.
  const agentInfo: AgentInfo = {
    version: STATE_VERSION,
    pid: process.pid,
    ppid: process.ppid,
    host: args.host,
    port: args.port,
    url: `http://${args.host}:${args.port}`,
    startedAt: nowIso(),
    agentVersion: AGENT_VERSION,
    stateDir: paths.root,
    cwd: process.cwd(),
  }

  let shuttingDown = false
  let idleTimer: ReturnType<typeof setInterval> | undefined
  let handle: ReturnType<typeof createAgentServer> | undefined
  const supervisor = new Supervisor({
    paths,
    agentInfo,
    token,
    log,
    readyTimeoutMs: args.readyTimeoutMs,
    stopGraceMs: args.stopGraceMs,
    settleMs: args.settleMs,
    maxLogTailChars: DEFAULT_LOG_TAIL_CHARS,
  })

  const stop = async (code: number): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    if (idleTimer !== undefined) clearInterval(idleTimer)
    try {
      await handle?.close()
    } catch {
      // Closing an already-closed server is not an outcome.
    }
    const recorded = readAgentInfo(paths)
    if (recorded?.pid === process.pid) writeJsonAtomic(paths.agentInfo, { ...recorded, stoppedAt: nowIso() })
    process.exit(code)
  }

  handle = createAgentServer({
    supervisor,
    agentInfo,
    token,
    log,
    onShutdown: () => { setTimeout(() => { void stop(0) }, 50) },
  })

  let port: number
  try {
    port = await listenWithFallback(handle.server, args.host, args.port)
  } catch (error) {
    log(`failed to bind ${args.host}:${String(args.port)}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  agentInfo.port = port
  agentInfo.url = `http://${args.host}:${String(port)}`
  writeJsonAtomic(paths.agentInfo, agentInfo, 0o600)
  log(`control agent listening on ${agentInfo.url} (pid ${String(process.pid)})`)

  // Idle exit keeps a per-machine process from outliving its purpose, while
  // never racing a restart that is still in flight.
  let idleSince = Date.now()
  idleTimer = setInterval(() => {
    if (supervisor.isBusy) {
      idleSince = Date.now()
      return
    }
    const status = supervisor.status()
    if (status.trackedPidAlive === true) {
      idleSince = Date.now()
      return
    }
    if (Date.now() - idleSince < args.idleMs) return
    log(`idle for ${String(args.idleMs)} ms with no supervised harness; exiting`)
    void stop(0)
  }, 15_000)
  idleTimer.unref()

  process.on('SIGTERM', () => { void stop(0) })
  process.on('SIGINT', () => { void stop(0) })
  return await new Promise<number>(() => {})
}

/** Print local state when no agent is answering. */
function printLocalState(paths: ReturnType<typeof statePaths>, args: ParsedArgs): void {
  const instances = listDir(paths.instances).map(key => {
    const instance = instancePaths(paths.root, key)
    return {
      key,
      launch: readJson<{ pid?: number; cwd?: string; argv?: string[]; startedAt?: string }>(instance.launchSpec),
      baseline: readBaselineManifest(instance.lastGood),
      alive: isAlive(readJson<{ pid?: number }>(instance.launchSpec)?.pid ?? 0),
    }
  })
  const reports = listDir(paths.reports).filter(name => name.endsWith('.json')).sort().reverse()
  const latest = reports[0] === undefined
    ? undefined
    : readJson<RestartReport>(join(paths.reports, reports[0]))
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ root: paths.root, instances, latestReport: latest }, null, 2)}\n`)
    return
  }
  process.stdout.write('dsh-restart: no control agent is running\n')
  process.stdout.write(`  state dir   : ${paths.root}\n`)
  if (instances.length === 0) process.stdout.write('  instances   : none registered\n')
  for (const instance of instances) {
    process.stdout.write(
      `  instance    : ${instance.key} pid ${String(instance.launch?.pid ?? 0)} `
      + `alive=${String(instance.alive)} cwd ${instance.launch?.cwd ?? '?'}\n`,
    )
    process.stdout.write(
      `                last-good ${instance.baseline === undefined
        ? 'none'
        : `${instance.baseline.createdAt} (${String(instance.baseline.entries.length)} files)`}\n`,
    )
  }
  process.stdout.write(`  last report : ${latest === undefined ? 'none' : `[${latest.status}] ${latest.headline}`}\n`)
}

/** Start (or reuse) a control agent and hand it a restart request. */
/** Whether a control agent is already answering for this state directory. */
async function hasLiveAgent(paths: ReturnType<typeof statePaths>): Promise<boolean> {
  const info = readAgentInfo(paths)
  return info !== undefined && await agentAlive(info)
}

async function requestRestartFromCli(
  args: ParsedArgs,
  request: RestartRequest,
): Promise<number> {
  const paths = statePaths(args.stateDir ?? resolveStateDir())
  ensureDir(paths.root)
  const token = ensureToken(paths)
  const log = makeLogger(join(paths.logs, 'cli.log'))

  // Warn before spawning, and only when a new agent is actually needed: an
  // agent that is already running was started by a harness process or by an
  // earlier terminal session, so it carries no session Job and is safe to
  // reuse.
  if (!await hasLiveAgent(paths)) {
    const ancestor = detectHarnessAncestor()
    if (ancestor !== undefined) {
      process.stderr.write(
        'dsh-restart: WARNING - this command is running inside a DeepSeek Harness session\n'
        + `             (${ancestor})\n`
        + '  The harness runs every shell command inside a Windows Job with kill-on-close, and a\n'
        + '  newly started control agent inherits it. If the restart has to force-kill the\n'
        + '  harness, that Job is torn down and the agent dies with it - mid-restart, leaving\n'
        + '  the harness stopped until something starts it again.\n'
        + `  Recorded launch command: ${paths.instances}\\<instance>\\launch.json\n`
        + '  Safer: run this from a plain terminal window, or start the harness yourself after\n'
        + '  the restart.\n',
      )
    }
  }

  const info = await ensureAgent({
    paths,
    entry: process.argv[1] ?? join(process.cwd(), 'agent.js'),
    host: args.host,
    port: args.port,
    idleMs: args.idleMs,
    log,
  })
  if (info === undefined) {
    process.stderr.write('dsh-restart: the control agent could not be started\n')
    return 1
  }
  const result = await callRestart({ info, token }, request, true)
  if (!result.accepted) {
    process.stderr.write(`dsh-restart: ${result.error}\n`)
    return 1
  }
  const report = result.report
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else if (report !== undefined) {
    process.stdout.write(`${report.status}: ${report.headline}\n`)
  }
  return report?.status === 'failed' ? 1 : 0
}

/**
 * Run the agent command line.
 * @param argv - arguments after the executable.
 * @returns the process exit code.
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  // Internal two-stage launcher: spawn the requested command detached, then
  // exit at once so the real agent is reparented out of the caller's process
  // tree (see SPAWN_COMMAND in agent-client.ts).
  if (argv[0] === SPAWN_COMMAND) {
    return spawnDetachedAndExit(argv.slice(1))
  }
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`dsh-restart: ${error instanceof Error ? error.message : String(error)}\n`)
    process.stderr.write(HELP)
    return 2
  }
  const paths = statePaths(args.stateDir ?? resolveStateDir())

  switch (args.command) {
    case 'help':
      process.stdout.write(HELP)
      return 0
    case 'serve':
      return await serve(args)
    case 'status': {
      const info = readAgentInfo(paths)
      if (info !== undefined && await agentAlive(info)) {
        const token = ensureToken(paths)
        const status = await fetchStatus({ info, token })
        if (status !== undefined) {
          if (args.json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
          else {
            process.stdout.write(`control agent ${info.url} (pid ${String(info.pid)}) busy=${String(status.busy)}\n`)
            if (status.current !== undefined) process.stdout.write(`  phase       : ${status.current.phase}\n`)
            process.stdout.write(`  tracked pid : ${String(status.trackedPid ?? 0)} alive=${String(status.trackedPidAlive ?? false)}\n`)
            process.stdout.write(`  last-good   : ${status.lastGood === undefined ? 'none' : `${status.lastGood.createdAt} (${String(status.lastGood.files)} files)`}\n`)
            process.stdout.write(`  last report : ${status.lastReport === undefined ? 'none' : `[${status.lastReport.status}] ${status.lastReport.headline}`}\n`)
          }
          return 0
        }
      }
      printLocalState(paths, args)
      return 0
    }
    case 'restart':
      return await requestRestartFromCli(args, {
        reason: args.reason,
        requestedBy: args.requestedBy,
        rollbackOnFailure: true,
      })
    case 'rollback':
      return await requestRestartFromCli(args, {
        reason: args.reason,
        requestedBy: args.requestedBy,
        rollbackNow: true,
        rollbackOnFailure: true,
      })
    case 'stop': {
      const info = readAgentInfo(paths)
      if (info === undefined || !await agentAlive(info)) {
        process.stdout.write('dsh-restart: no control agent is running\n')
        return 0
      }
      await postShutdown({ info, token: ensureToken(paths) })
      process.stdout.write(`dsh-restart: asked ${info.url} to stop\n`)
      return 0
    }
    default:
      process.stdout.write(HELP)
      return 2
  }
}

/**
 * Spawn the requested agent invocation detached, then exit immediately.
 *
 * The child outlives this launcher and is therefore no longer a descendant of
 * whoever called us — which is what lets the harness be force-killed with
 * `taskkill /T` without taking its own supervisor down.
 * @param argv - the command line for the detached child.
 * @returns always 0; spawning is fire-and-forget.
 */
function spawnDetachedAndExit(argv: readonly string[]): number {
  const entry = process.argv[1]
  if (entry === undefined || argv.length === 0) {
    process.stderr.write('dsh-restart: the internal launcher needs an entry point\n')
    return 2
  }
  const child = spawn(process.execPath, [entry, ...argv], {
    // Never the caller's directory: on Windows a process holds a handle on its
    // working directory, and an agent parked inside the plugin's own package
    // makes the next `pnpm add` fail with EPERM. The home directory always
    // exists and belongs to no package.
    cwd: homedir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  })
  child.unref()
  return 0
}

/**
 * Whether this module is the process entry point.
 *
 * `import.meta.main` is not available on every supported node, and the agent
 * is spawned as a bare file (`node …/lib/agent.js serve`), so the check is
 * explicit and realpath-based.
 * @returns true when argv[1] resolves to this module.
 */
function invokedAsScript(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const invoked = realpathSync(resolve(entry))
    return process.platform === 'win32'
      ? self.toLowerCase() === invoked.toLowerCase()
      : self === invoked
  } catch {
    return false
  }
}

if (invokedAsScript()) {
  runCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (error: unknown) => {
      process.stderr.write(`dsh-restart: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
