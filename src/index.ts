/**
 * dsh-restart — the host half.
 *
 * Registers the model-callable restart tools, keeps the out-of-process control
 * agent alive, maintains the last known-good configuration baseline, and hands
 * the previous restart's failure report to the model on the next boot.
 *
 * The heavy lifting (stopping the process, relaunching it, rolling back a bad
 * boot) happens in the agent, because this plugin dies with the tree it is
 * trying to replace.
 * @module dsh-restart
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  AgentInfo, AgentStatus, AttemptOutcome, LaunchSpec, RestartReport, TrackedFiles,
} from './protocol.ts'
import { ENV_AGENT_TOKEN, ENV_AGENT_URL, ENV_ATTEMPT, STATE_VERSION } from './protocol.ts'
import { ensureDir, listDir, makeId, nowIso, readJson, writeJsonAtomic } from './fsx.ts'
import { expandHomePath, resolveDshHome, resolveStateDir, instanceKey, instancePaths, statePaths, type InstancePaths, type StatePaths } from './paths.ts'
import {
  callRestart, ensureAgent, ensureToken, fetchStatus, postReady, readAgentInfo,
} from './agent-client.ts'
import { expandTrackedPaths, readBaselineManifest, takeBaseline } from './snapshot.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-restart'

/** The base bundle's tool registry is the only service this plugin requires. */
export const inject = ['tools']

/** Version reported in state files. */
export const PLUGIN_VERSION = '0.1.0'

/** Prompt section carrying a restart report; placed after the harness-source block. */
const REPORT_SECTION = 'dsh-restart:report'

/** Order slot for {@link REPORT_SECTION}. */
const REPORT_SECTION_ORDER = 10_050

/** How many undelivered reports are surfaced at once. */
const MAX_DELIVERED_REPORTS = 3

/**
 * Budget for asking a *known* agent for its status during boot reconciliation.
 *
 * Larger than the 1.5s liveness probe used elsewhere on purpose: that probe is
 * issued at the busiest moment of the process (every module is still being
 * compiled), see {@link closeAbandonedReport}.
 */
const RECONCILE_STATUS_TIMEOUT_MS = 5_000

/** How many times boot reconciliation retries the question before giving up. */
const RECONCILE_ATTEMPTS = 3

/**
 * Structural view of the system-prompt service.
 *
 * Declared locally on purpose: an out-of-tree plugin should not have to track
 * the private `@deepseek-ai/dsh-*` type surface, and a renamed method must not
 * turn into a build failure for the user.
 */
interface SystemPromptLike {
  section(section: { name: string; order: number; text: string }): () => void
}

/** Structural view of the Web server's route registry. */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Structural view of one `agent/status` payload.
 *
 * Declared locally for the same reason as everything else here: this plugin
 * must not break when an internal package is renamed.
 */
interface AgentStatusPayload {
  agent?: {
    id?: unknown
    session?: { id?: unknown }
    parentAgent?: unknown
    options?: { origin?: unknown }
  }
  status?: unknown
}

/**
 * The event surface, typed loosely on purpose.
 *
 * `ctx.on('agent/status', …)` is otherwise checked against the harness's own
 * `Agent`/`AgentOptions` types, which would tie this plugin to internal
 * packages it deliberately does not depend on.
 */
interface LooseEvents {
  on(name: string, listener: (payload: AgentStatusPayload) => void): unknown
}

/** The launcher's committed-startup signal. */
interface AppReadyLike {
  onReady(listener: () => void): () => void
}

/** The launcher's bounded exit request. */
type AppExitLike = (code: number) => void

/** Plugin configuration. */
export interface Config {
  /** Master switch; `false` registers nothing and starts no agent. */
  enabled: boolean
  /** Loopback port the control agent prefers (it walks upward when taken). */
  port: number
  /** Loopback host the control agent binds. */
  host: string
  /** Start the control agent on boot; `false` leaves restarts unavailable until one is started by hand. */
  autoStartAgent: boolean
  /** Readiness budget for one boot attempt, in milliseconds. */
  readyTimeoutMs: number
  /** Grace granted to the outgoing process before it is force-killed. */
  stopGraceMs: number
  /** Delay between accepting a restart and asking the launcher to exit. */
  exitDelayMs: number
  /**
   * How long to let the in-flight turn finish before exiting anyway.
   *
   * The restart is normally requested *from inside a turn* — the model calls
   * the tool and still has its closing message to write. Exiting on a timer
   * killed that message, which is why a restart looked like a dropped
   * conversation. The launcher is asked to exit once no root agent is running,
   * or when this budget runs out.
   */
  exitWaitForIdleMs: number
  /** Roll back to the last known-good snapshot when the new boot fails. */
  rollbackOnFailure: boolean
  /** Extra absolute (or `~`-relative) configuration files to track and roll back. */
  trackedPaths: string[]
  /** Extra directories whose files are tracked (one level deep, `node_modules` skipped). */
  trackedDirectories: string[]
  /** Capture the full environment in the launch specification. */
  captureEnvironment: boolean
  /** Surface undelivered reports on the next boot. */
  deliverReports: boolean
  /** Also surface them through a system-prompt section. */
  promptSection: boolean
  /** Expose `GET /api/dsh-restart/status` on the Web surface when one is mounted. */
  exposeWebRoute: boolean
  /** Idle window after which an unsupervised agent exits. */
  idleExitMs: number
  /** Extra command-line arguments for the agent process. */
  agentArgs: string[]
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  port: z.natural().default(3099),
  host: z.string().default('127.0.0.1'),
  autoStartAgent: z.boolean().default(true),
  readyTimeoutMs: z.natural().default(180_000),
  stopGraceMs: z.natural().default(20_000),
  exitDelayMs: z.natural().default(1_200),
  exitWaitForIdleMs: z.natural().default(180_000),
  rollbackOnFailure: z.boolean().default(true),
  trackedPaths: z.array(String).default([]),
  trackedDirectories: z.array(String).default([]),
  captureEnvironment: z.boolean().default(true),
  deliverReports: z.boolean().default(true),
  promptSection: z.boolean().default(true),
  exposeWebRoute: z.boolean().default(true),
  idleExitMs: z.natural().default(1_800_000),
  agentArgs: z.array(String).default([]),
})

/** The defaults, so a direct instantiation cannot read `undefined` for a knob. */
export const DEFAULTS: Config = {
  enabled: true,
  port: 3099,
  host: '127.0.0.1',
  autoStartAgent: true,
  readyTimeoutMs: 180_000,
  stopGraceMs: 20_000,
  exitDelayMs: 1_200,
  exitWaitForIdleMs: 180_000,
  rollbackOnFailure: true,
  trackedPaths: [],
  trackedDirectories: [],
  captureEnvironment: true,
  deliverReports: true,
  promptSection: true,
  exposeWebRoute: true,
  idleExitMs: 1_800_000,
  agentArgs: [],
}

/**
 * Merge a partial configuration over the defaults.
 * @param config - raw configuration, possibly partial.
 * @returns a complete configuration.
 */
export function resolveConfig(config: Partial<Config> | undefined): Config {
  const source = config ?? {}
  return {
    ...DEFAULTS,
    ...source,
    trackedPaths: source.trackedPaths ?? DEFAULTS.trackedPaths,
    trackedDirectories: source.trackedDirectories ?? DEFAULTS.trackedDirectories,
    agentArgs: source.agentArgs ?? DEFAULTS.agentArgs,
  }
}

/** Imperative surface other plugins can inject instead of calling the tool. */
export interface DshRestartService {
  /** Ask for a restart; resolves once the control agent accepted it. */
  request(options?: { reason?: string; rollback?: boolean; requestedBy?: string }): Promise<{
    accepted: boolean
    message: string
  }>
  /** Resolve the live control agent, starting one when configured to. */
  ensureAgent(): Promise<AgentInfo | undefined>
  /** Read the agent's status document, or `undefined` when it is not running. */
  status(): Promise<AgentStatus | undefined>
  /** The state directory shared with the agent. */
  readonly stateDir: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Restart control surface provided by `dsh-restart`. */
    dshRestart?: DshRestartService
  }
}

/** Absolute path of the bundled agent entry, next to this module. */
function agentEntry(): string {
  return fileURLToPath(new URL('./agent.js', import.meta.url))
}

/** Read the mounted profile directory from the Loader's base URL. */
function profileDirOf(ctx: Context): string | undefined {
  const baseUrl = (ctx as { baseUrl?: unknown }).baseUrl
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return undefined
  try {
    return fileURLToPath(baseUrl)
  } catch {
    return undefined
  }
}

/**
 * The configuration files a restart should be able to roll back: the profile's
 * own composition surface plus the machine-level patch layer.
 */
function defaultTrackedFiles(profileDir: string | undefined, home: string): string[] {
  const files: string[] = []
  if (profileDir !== undefined) {
    for (const name of ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      files.push(join(profileDir, name))
    }
  }
  files.push(join(home, 'cordis.patch.yml'))
  return files
}

/** Render one attempt as a compact report block. */
function attemptLines(outcome: AttemptOutcome): string[] {
  const lines = [
    `- attempt ${String(outcome.attempt)}${outcome.usedRollback ? ' (rolled-back configuration)' : ''}: `
    + `${outcome.result} after ${String(outcome.durationMs)} ms`
    + `${outcome.exitCode === undefined || outcome.exitCode === null ? '' : `, exit code ${String(outcome.exitCode)}`}`,
  ]
  if (outcome.note !== undefined) lines.push(`  note: ${outcome.note}`)
  if (outcome.logTail.trim().length > 0) {
    lines.push('  log tail:')
    for (const line of outcome.logTail.trimEnd().split('\n').slice(-40)) lines.push(`    ${line}`)
  }
  return lines
}

/** Build the model-facing text for one report. */
function reportText(report: RestartReport): string {
  const lines = [
    `### Restart ${report.id} — ${report.status}`,
    report.headline,
    `Requested by ${report.requestedBy} at ${report.createdAt}.`,
    `Reason: ${report.reason}`,
  ]
  if (report.status === 'in-progress') {
    lines.push(
      'This record was written before the process you are running was started: you ARE the restarted '
      + 'instance. The outcome of the boot that produced you is not in this record.',
    )
  }
  if (report.error !== undefined) lines.push(`Error: ${report.error}`)
  if (report.rollback?.performed === true) {
    lines.push(
      `Rolled back to the snapshot taken at ${report.rollback.baselineCreatedAt ?? 'unknown time'} `
      + `(${String(report.rollback.restored.length)} restored, ${String(report.rollback.removed.length)} removed).`,
    )
    for (const path of report.rollback.restored) lines.push(`  restored: ${path}`)
    for (const path of report.rollback.removed) lines.push(`  removed: ${path}`)
    for (const failure of report.rollback.failures) lines.push(`  FAILED: ${failure.path}: ${failure.error}`)
  }
  lines.push('Attempts:')
  for (const attempt of report.attempts) lines.push(...attemptLines(attempt))
  return lines.join('\n')
}

/**
 * Register the restart plugin.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  if (resolved.enabled !== true) {
    process.stderr.write('[dsh-restart] disabled by configuration\n')
    return
  }
  const paths: StatePaths = statePaths(resolveStateDir())
  const home = resolveDshHome()
  const profileDir = profileDirOf(ctx)
  const instance: InstancePaths = instancePaths(paths.root, instanceKey(profileDir))
  ensureDir(paths.root)
  ensureDir(paths.reports)
  ensureDir(paths.logs)
  ensureDir(instance.dir)
  const token = ensureToken(paths)
  const log = (line: string): void => { process.stderr.write(`[dsh-restart] ${line}\n`) }

  const tracked = [
    ...defaultTrackedFiles(profileDir, home),
    ...resolved.trackedPaths.map(entry => resolve(expandHomePath(entry))),
  ]
  const uniqueTracked = [...new Set([
    ...expandTrackedPaths(tracked),
    ...resolved.trackedDirectories.flatMap(
      directory => expandTrackedPaths([resolve(expandHomePath(directory))]),
    ),
  ])]

  // ── launch specification ────────────────────────────────────────────────
  const launchSpec: LaunchSpec = {
    version: STATE_VERSION,
    pid: process.pid,
    launchId: makeId('boot'),
    startedAt: nowIso(),
    cwd: process.cwd(),
    execPath: process.execPath,
    execArgv: [...process.execArgv],
    argv: [...process.argv.slice(1)],
    env: resolved.captureEnvironment
      ? Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      )
      : {},
    pluginVersion: PLUGIN_VERSION,
  }
  if (profileDir !== undefined) launchSpec.profileDir = profileDir

  /**
   * Write -- or re-assert -- this boot's launch specification.
   *
   * Called at apply, again once startup is committed, and once more
   * immediately before a restart is requested. That last call is the one that
   * matters: two instances of the same profile share one instance key, and an
   * instance that boots and then dies (a second instance cannot bind the port
   * the first one holds) clobbers this record on its way down. Re-asserting at
   * the moment of the restart guarantees the record names the process that is
   * actually running -- otherwise the next restart targets a dead pid, starts
   * a second instance, and loses the port race all over again.
   */
  const writeLaunchSpec = (webSurface?: boolean): void => {
    if (webSurface !== undefined) launchSpec.webSurface = webSurface
    launchSpec.pid = process.pid
    writeJsonAtomic(instance.launchSpec, launchSpec)
  }
  writeLaunchSpec()
  writeJsonAtomic(instance.trackedFiles, {
    version: STATE_VERSION,
    updatedAt: nowIso(),
    files: uniqueTracked,
  } satisfies TrackedFiles)
  log(`instance ${instance.key} (${profileDir ?? 'unknown profile'}) tracks ${String(uniqueTracked.length)} file(s)`)

  // ── control agent ───────────────────────────────────────────────────────
  let agent: AgentInfo | undefined
  let agentAttempt: Promise<AgentInfo | undefined> | undefined
  const ensureAgentHandle = async (): Promise<AgentInfo | undefined> => {
    if (agent !== undefined && await fetchStatus({ info: agent, token, timeoutMs: 1_500 }) !== undefined) {
      return agent
    }
    // Boot and a first tool call can race here; one spawn is enough.
    if (agentAttempt !== undefined) return await agentAttempt
    agentAttempt = (async (): Promise<AgentInfo | undefined> => {
      agent = undefined
      const recorded = readAgentInfo(paths)
      if (recorded !== undefined
        && await fetchStatus({ info: recorded, token, timeoutMs: 1_500 }) !== undefined) {
        agent = recorded
        return agent
      }
      if (!resolved.autoStartAgent) {
        log('autoStartAgent is false and no control agent answers; restarts are unavailable')
        return undefined
      }
      agent = await ensureAgent({
        paths,
        entry: agentEntry(),
        host: resolved.host,
        port: resolved.port,
        idleMs: resolved.idleExitMs,
        extraArgs: resolved.agentArgs,
        log,
      })
      if (agent === undefined) log('the control agent could not be started; restarts are unavailable')
      return agent
    })()
    try {
      return await agentAttempt
    } finally {
      agentAttempt = undefined
    }
  }

  // An unhandled rejection here would trip the launcher's fail-loud handler and
  // turn "the supervisor is not running" into a boot failure.
  void ensureAgentHandle().then((info) => {
    if (info !== undefined) log(`control agent ready at ${info.url}`)
  }, (error: unknown) => {
    log(`control agent startup failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  // ── report delivery ─────────────────────────────────────────────────────
  /** Print and publish the reports this boot is responsible for surfacing. */
  const surfaceReports = (reports: readonly RestartReport[]): void => {
    for (const report of reports) {
      process.stderr.write(`[dsh-restart] previous restart ${report.id}: [${report.status}] ${report.headline}\n`)
      for (const attempt of report.attempts) {
        if (attempt.result === 'ready' || attempt.result === 'ready-unconfirmed') continue
        process.stderr.write(`[dsh-restart]   attempt ${String(attempt.attempt)} log: ${attempt.logFile}\n`)
      }
    }
    if (reports.length === 0 || !resolved.promptSection) return
    ctx.inject(['systemPrompt'], (scope) => {
      const systemPrompt = (scope as unknown as { systemPrompt?: SystemPromptLike }).systemPrompt
      if (systemPrompt === undefined) {
        log(`no system-prompt service is mounted; ${String(reports.length)} report(s) stay tool-visible only`)
        return
      }
      systemPrompt.section({
        name: REPORT_SECTION,
        order: REPORT_SECTION_ORDER,
        text: [
          '## DeepSeek Harness restart report',
          '',
          'The out-of-process restart supervisor recorded the following for the boot that produced this process. '
          + 'Treat it as authoritative operational history: any listed file was rolled back, so what is on disk '
          + 'now is the last known-good configuration rather than the failed attempt.',
          '',
          ...reports.map(reportText),
        ].join('\n'),
      })
      log(`surfaced ${String(reports.length)} previous restart report(s) in the system prompt`)
    })
  }

  // A restart that died between recording the request and spawning anything
  // leaves an `in-progress` record that would otherwise be surfaced forever —
  // and `reportText` would tell the model it is the restarted instance, which is
  // the one thing it is not. Reconciliation therefore has to finish BEFORE the
  // reports are read.
  const pending: RestartReport[] = []
  const abandoned = resolved.deliverReports ? abandonedReport(readLatestReport(paths)) : undefined
  const deliverySettled: Promise<void> = abandoned === undefined
    ? ((): Promise<void> => {
      if (resolved.deliverReports) pending.push(...readPendingReports(paths))
      surfaceReports(pending)
      return Promise.resolve()
    })()
    : closeAbandonedReport({
      report: abandoned,
      paths,
      log,
      status: async () => {
        // Retried on purpose. The first probe is issued while the tree is still
        // being compiled, and a probe that loses that race reports "no agent"
        // for an agent that is alive and idle — measured in an isolated profile:
        // with nothing applied before this plugin the boot probe failed on
        // every run, and with one plugin ahead of it, never. The question is
        // only asked when a restart is already suspected of being abandoned, so
        // a few seconds here cost nothing and turn a silent miss into the
        // detection this exists for.
        for (let attempt = 1; attempt <= RECONCILE_ATTEMPTS; attempt += 1) {
          const info = await ensureAgentHandle()
          if (info !== undefined) {
            const status = await fetchStatus({ info, token, timeoutMs: RECONCILE_STATUS_TIMEOUT_MS })
            if (status !== undefined) return status
          }
          if (attempt < RECONCILE_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, 500))
        }
        return undefined
      },
    }).then(() => {
      pending.push(...readPendingReports(paths))
      surfaceReports(pending)
    })

  // ── restart request path ────────────────────────────────────────────────

  /**
   * Root agents that are running right now, by agent id.
   *
   * Only root agents count: a delegated subagent runs inside its parent's
   * turn, so the parent is the thing that has to finish before this process
   * can leave.
   */
  const runningRootAgents = new Set<string>()
  ;(ctx as unknown as LooseEvents).on('agent/status', (payload: AgentStatusPayload) => {
    try {
      const agent = payload?.agent
      const id = agent?.id
      const key = typeof id === 'string' && id.length > 0
        ? id
        : (typeof agent?.session?.id === 'string' ? agent.session.id : '')
      if (key === '') return
      if (payload.status === 'running') {
        const delegated = (agent?.parentAgent !== undefined && agent.parentAgent !== null)
          || agent?.options?.origin === 'subagent'
        if (!delegated) runningRootAgents.add(key)
        return
      }
      runningRootAgents.delete(key)
    } catch (error) {
      log(`agent/status handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  /**
   * Ask the launcher to exit once this turn has finished.
   *
   * The restart is requested from inside a turn, so leaving on a timer would
   * cut off the model's closing message and make the conversation look
   * dropped. Waiting for the turn to end is what lets the reply land before
   * the process is replaced.
   */
  const scheduleExit = (): void => {
    const exit = ctx.get('appExit') as AppExitLike | undefined
    const leave = (): void => {
      log('exiting so the control agent can relaunch this process')
      if (exit !== undefined) exit(0)
      else process.exit(0)
    }
    const deadline = Date.now() + resolved.exitWaitForIdleMs
    const attempt = (): void => {
      if (runningRootAgents.size > 0 && Date.now() < deadline) {
        setTimeout(attempt, 250)
        return
      }
      if (runningRootAgents.size > 0) {
        log(`${String(runningRootAgents.size)} agent(s) still running after `
          + `${String(resolved.exitWaitForIdleMs)} ms; exiting anyway`)
      }
      setTimeout(leave, resolved.exitDelayMs)
    }
    setTimeout(attempt, 150)
  }

  /**
   * Extra arguments for the relaunch.
   *
   * A supervised relaunch of the Web surface must not open a second browser
   * tab: the user is already looking at the GUI they asked to restart, and
   * `--no-open` is the Web app's own switch for exactly that. It is only
   * appended when a Web surface is actually mounted, because the flag would be
   * a usage error for any other surface's command line.
   */
  const webSurfaceMounted = (): boolean => {
    try {
      return ctx.get('webServer') !== undefined || ctx.get('webStartup') !== undefined
    } catch {
      return false
    }
  }

  const relaunchArgs = (): string[] => {
    if (!webSurfaceMounted()) return []
    return launchSpec.argv.includes('--no-open') ? [] : ['--no-open']
  }

  const requestRestart = async (options: {
    reason: string
    rollback?: boolean
    requestedBy?: string
  }): Promise<{ accepted: boolean; message: string }> => {
    const info = await ensureAgentHandle()
    if (info === undefined) {
      return {
        accepted: false,
        message: 'the restart control agent is not running; start it with `dsh-restart serve` '
          + `(state directory ${paths.root}) and retry`,
      }
    }
    // Re-assert the record of who is running before anyone acts on it.
    try {
      writeLaunchSpec(webSurfaceMounted())
    } catch (error) {
      log(`could not re-assert the launch specification: ${error instanceof Error ? error.message : String(error)}`)
    }
    const appendArgs = relaunchArgs()
    const result = await callRestart({ info, token }, {
      reason: options.reason,
      requestedBy: options.requestedBy ?? 'plugin',
      instance: instance.key,
      pid: process.pid,
      rollbackNow: options.rollback === true,
      rollbackOnFailure: resolved.rollbackOnFailure,
      readyTimeoutMs: resolved.readyTimeoutMs,
      stopGraceMs: resolved.stopGraceMs,
      ...(appendArgs.length === 0 ? {} : { appendArgs }),
    }, false)
    if (!result.accepted) return { accepted: false, message: result.error }
    scheduleExit()
    return {
      accepted: true,
      message: `${result.message} This process exits as soon as the current turn finishes `
        + `(at most ${String(Math.round(resolved.exitWaitForIdleMs / 1000))} s), so write your closing `
        + `message now: the control agent at ${info.url} then relaunches the same command line`
        + `${appendArgs.length === 0 ? '' : ` with ${appendArgs.join(' ')}`}, and rolls the configuration `
        + 'back to the last known-good snapshot if the new process fails to start.',
    }
  }

  // ── tools ───────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dsh_restart',
    description:
      'Restart DeepSeek Harness through the out-of-process restart supervisor. Use this after installing or '
      + 'removing a plugin, editing a profile configuration file, or changing anything the running process '
      + 'froze at startup: those changes need a fresh process, and this call arranges one without the user '
      + 'touching a terminal. The supervisor relaunches dsh with the exact command line, working directory, '
      + 'and environment of the current process, then waits for this plugin to confirm a committed startup. '
      + 'If the new process dies or never comes up, the supervisor restores the last known-good configuration '
      + 'snapshot, starts again, and leaves a report the restarted harness reads on boot. This call returns '
      + 'immediately and the harness process exits shortly afterwards, so do not promise follow-up tool calls '
      + 'in the same session.',
    parameters: {
      reason: {
        type: 'string',
        required: true,
        description: 'Why the restart is needed, e.g. "installed dsh-restart into the web profile".',
      },
      mode: {
        type: 'string',
        enum: ['restart', 'rollback'],
        description: '`restart` boots the current configuration; `rollback` restores the last known-good '
          + 'snapshot first, which is how a change that already broke a boot gets undone.',
      },
      rollbackOnFailure: {
        type: 'boolean',
        description: 'Roll back automatically when the new process fails. Defaults to the plugin configuration.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          agentUrl: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String((value as { message?: unknown }).message ?? '') }],
    },
    async execute(args) {
      const result = await requestRestart({
        reason: args.reason,
        rollback: args.mode === 'rollback',
        requestedBy: 'tool',
      })
      return {
        accepted: result.accepted,
        agentUrl: agent?.url ?? '',
        message: result.accepted ? result.message : `Restart not scheduled: ${result.message}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dsh_restart_status',
    description:
      'Report the state of the DeepSeek Harness restart supervisor: whether the control agent runs, which '
      + 'process it tracks, which configuration files the last known-good snapshot covers, and the outcome of '
      + 'the most recent restart including any rollback and the failure log tail. Use this after a restart to '
      + 'see what happened, or before requesting one to confirm a rollback baseline exists.',
    parameters: {
      includeLogTail: {
        type: 'boolean',
        description: 'Include the tail of each failed attempt log. Default true.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: unknown }).summary ?? '') }],
    },
    async execute(args) {
      const info = await ensureAgentHandle()
      if (info === undefined) {
        return {
          summary: `The restart control agent is not running.\n${localStatusText(instance, uniqueTracked)}`,
          report: '',
        }
      }
      const status = await fetchStatus({ info, token, timeoutMs: 5_000 })
      if (status === undefined) {
        return { summary: `The control agent at ${info.url} did not answer.`, report: '' }
      }
      const latest = status.lastReport
      const lines = [
        `Control agent: ${status.agent.url} (pid ${String(status.agent.pid)}), busy=${String(status.busy)}`,
        status.current === undefined ? undefined : `Phase: ${status.current.phase}`,
        `Tracked process: ${String(status.trackedPid ?? 0)} alive=${String(status.trackedPidAlive ?? false)}`,
        `Last known-good snapshot: ${status.lastGood === undefined
          ? 'none yet (no successful boot has been recorded)'
          : `${status.lastGood.createdAt} covering ${String(status.lastGood.files)} file(s)`}`,
        `Tracked files: ${status.trackedFiles.length === 0 ? 'none' : status.trackedFiles.join(', ')}`,
        latest === undefined ? 'Last restart: none recorded' : `Last restart [${latest.status}] ${latest.headline}`,
      ].filter((line): line is string => line !== undefined)
      if (latest !== undefined) {
        lines.push(...latest.attempts.flatMap(attempt =>
          args.includeLogTail === false
            ? attemptLines({ ...attempt, logTail: '' })
            : attemptLines(attempt)))
      }
      return { summary: lines.join('\n'), report: latest === undefined ? '' : reportText(latest) }
    },
  }))

  // ── service ─────────────────────────────────────────────────────────────
  ctx.provide('dshRestart', {
    stateDir: paths.root,
    request: (options = {}) => requestRestart({
      reason: options.reason ?? 'requested by another plugin',
      rollback: options.rollback === true,
      requestedBy: options.requestedBy ?? 'service',
    }),
    ensureAgent: ensureAgentHandle,
    status: async () => {
      const info = await ensureAgentHandle()
      if (info === undefined) return undefined
      return await fetchStatus({ info, token, timeoutMs: 5_000 })
    },
  } satisfies DshRestartService)

  // ── boot completion ─────────────────────────────────────────────────────
  const completeBoot = (): void => {
    // Promote this boot's configuration to the rollback baseline. Only a boot
    // that actually committed startup reaches this point, which is what makes
    // the baseline trustworthy.
    try {
      const manifest = takeBaseline(uniqueTracked, instance.lastGood, `appReady at ${nowIso()}`)
      log(`last known-good baseline refreshed (${String(manifest.entries.length)} file(s))`)
    } catch (error) {
      log(`failed to refresh the last known-good baseline: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Every service exists by now, so the surface question can be answered and
    // recorded: a relaunch — including one started from the command line, with
    // no plugin to ask — reads it to keep `--no-open` on the command line.
    try {
      const webSurface = webSurfaceMounted()
      const changed = launchSpec.webSurface !== webSurface
      writeLaunchSpec(webSurface)
      if (changed) log(`recorded webSurface=${String(webSurface)} in the launch specification`)
    } catch (error) {
      log(`could not record the surface kind: ${error instanceof Error ? error.message : String(error)}`)
    }
    void reportReady(paths, token, log)
    // Reports are marked delivered only once the delivery path has settled: the
    // reconciliation above may still be closing an interrupted record, and a
    // record surfaced after this point must not be surfaced again next boot.
    void deliverySettled.then(() => { markReportsDelivered(paths, pending) })
  }
  const ready = ctx.get('appReady') as AppReadyLike | undefined
  if (ready !== undefined) ready.onReady(completeBoot)
  else log('the launcher provided no appReady signal; the rollback baseline cannot be confirmed')

  // ── web route ───────────────────────────────────────────────────────────
  ctx.inject(['webServer'], (scope) => {
    if (!resolved.exposeWebRoute) return
    const webServer = (scope as unknown as { webServer?: WebServerLike }).webServer
    if (webServer === undefined) return
    try {
      webServer.register({
        kind: 'exact',
        // Plugin-namespaced rather than under `/api`, so the connection
        // plugin's request fence never sees it. The supervisor lamp in the
        // sidebar polls it for the agent URL and the last outcome — a small,
        // deliberately non-sensitive summary, because this route is served
        // without a token like every other plugin route.
        path: '/dsh-restart/status',
        handler: (_request, response) => {
          const latest = readLatestReport(paths)
          const body = JSON.stringify({
            instance: instance.key,
            agent: agent === undefined
              ? null
              : { url: agent.url, pid: agent.pid, startedAt: agent.startedAt },
            lastGood: readBaselineManifest(instance.lastGood)?.createdAt ?? null,
            lastReport: latest === undefined
              ? null
              : { status: latest.status, headline: latest.headline, createdAt: latest.createdAt },
          })
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store',
          })
          response.end(body)
        },
      })
    } catch (error) {
      log(`could not expose the status route: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/** Local status text used when no agent answers. */
function localStatusText(instance: InstancePaths, tracked: readonly string[]): string {
  const launch = readJson<LaunchSpec>(instance.launchSpec)
  const manifest = readBaselineManifest(instance.lastGood)
  return [
    `Instance ${instance.key} (state ${instance.dir})`,
    `Recorded launch: ${launch === undefined
      ? 'missing'
      : `pid ${String(launch.pid)} — ${launch.execPath} ${[...launch.execArgv, ...launch.argv].join(' ')} (cwd ${launch.cwd})`}`,
    `Last known-good snapshot: ${manifest === undefined
      ? 'none'
      : `${manifest.createdAt} covering ${String(manifest.entries.length)} file(s)`}`,
    `Tracked files: ${tracked.join(', ')}`,
  ].join('\n')
}

/** Read undelivered reports, newest first. */
function readPendingReports(paths: StatePaths, limit = MAX_DELIVERED_REPORTS): RestartReport[] {
  return listDir(paths.reports)
    .filter(fileName => fileName.endsWith('.json'))
    .sort()
    .reverse()
    .map(fileName => readJson<RestartReport>(join(paths.reports, fileName)))
    .filter((report): report is RestartReport => report !== undefined && report.deliveredAt === undefined)
    .slice(0, limit)
}

/**
 * Decide whether a report can only describe a restart that never happened.
 *
 * The supervisor writes an `in-progress` record with no attempts *before* it
 * spawns anything, so that signature is expected while a restart is in flight —
 * including on the boot that restart produced. What is not expected is finding
 * it on a boot no agent started: that is the shape left behind when the agent
 * died between recording the request and launching the harness, which leaves
 * DSH stopped and a report that never reaches a terminal state.
 *
 * @param report - the newest report on disk, if any.
 * @returns the report when it is a candidate for reconciliation.
 */
function abandonedReport(report: RestartReport | undefined): RestartReport | undefined {
  if (report === undefined) return undefined
  if (report.status !== 'in-progress') return undefined
  // An empty `attempts` list alone proves nothing: entries are appended when an
  // attempt *settles*, so the boot of a live restart reads exactly this shape.
  if (report.attempts.length > 0) return undefined
  // A process the agent spawned carries the attempt identity in its
  // environment, so having one means the restart was not interrupted before the
  // spawn — it produced this very process.
  if (process.env[ENV_ATTEMPT] !== undefined) return undefined
  return report
}

/** Options for {@link closeAbandonedReport}. */
interface CloseAbandonedOptions {
  report: RestartReport
  paths: StatePaths
  log: (line: string) => void
  /** Ask the control agent for its status, spawning one when necessary. */
  status: () => Promise<AgentStatus | undefined>
}

/**
 * Close a report whose restart was interrupted before it started anything.
 *
 * The record is rewritten as a terminal `failed` one rather than deleted: the
 * file is the only evidence that DSH was left stopped, and it stays undelivered
 * so this boot surfaces it like any other report.
 *
 * Every guard here exists because a false positive would be worse than the bug:
 * a running restart must never be declared dead, so the agent is asked first,
 * and an unreachable agent means "cannot tell" rather than "not running".
 *
 * @param options - the candidate report, the state layout, a logger, and the
 *   callback that reaches the control agent.
 * @returns the closed report, or undefined when it was left alone.
 */
async function closeAbandonedReport(options: CloseAbandonedOptions): Promise<RestartReport | undefined> {
  const { report, paths, log } = options
  const status = await options.status()
  if (status === undefined) {
    log(`restart ${report.id} never reached a terminal state, but the control agent could not be asked `
      + 'whether a restart is running; leaving the record alone')
    return undefined
  }
  if (status.busy) {
    log(`restart ${report.id} has no attempts yet and the control agent is restarting right now; leaving it to the agent`)
    return undefined
  }
  if (status.lastReport !== undefined && status.lastReport.id !== report.id) {
    log(`restart ${report.id} is not the agent's newest report (${status.lastReport.id}); leaving it alone`)
    return undefined
  }
  const closed: RestartReport = {
    ...report,
    status: 'failed',
    headline: 'The previous restart was interrupted before it started any process: the control agent stopped '
      + 'between recording the request and launching DeepSeek Harness, which stayed stopped until it was '
      + 'started again.',
    error: `reconciled at boot: report ${report.id} was still 'in-progress' with no attempts while no restart `
      + 'was running, so no process was ever spawned for it',
  }
  try {
    writeJsonAtomic(join(paths.reports, `${report.id}.json`), closed)
  } catch (error) {
    log(`could not close interrupted restart ${report.id}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  log(`closed interrupted restart ${report.id}: it was left 'in-progress' with no attempts and no restart is running`)
  return closed
}

/** Read the most recent report regardless of delivery state. */
function readLatestReport(paths: StatePaths): RestartReport | undefined {
  const names = listDir(paths.reports).filter(fileName => fileName.endsWith('.json')).sort().reverse()
  const newest = names[0]
  return newest === undefined ? undefined : readJson<RestartReport>(join(paths.reports, newest))
}

/** Mark reports as delivered so the next boot stays quiet about them. */
function markReportsDelivered(paths: StatePaths, reports: readonly RestartReport[]): void {
  for (const report of reports) {
    try {
      writeJsonAtomic(join(paths.reports, `${report.id}.json`), { ...report, deliveredAt: nowIso() })
    } catch {
      // A report that cannot be marked is delivered again; that is tolerable.
    }
  }
}

/** Tell the supervising agent that this boot committed startup. */
async function reportReady(
  paths: StatePaths,
  token: string,
  log: (line: string) => void,
): Promise<void> {
  const attempt = process.env[ENV_ATTEMPT]
  const url = process.env[ENV_AGENT_URL]
  if (attempt === undefined || url === undefined) return
  if (process.env[ENV_AGENT_TOKEN] !== undefined && process.env[ENV_AGENT_TOKEN] !== token) {
    log('ignoring a restart handshake whose token does not match this state directory')
    return
  }
  const info: AgentInfo = {
    version: STATE_VERSION,
    pid: 0,
    host: '127.0.0.1',
    port: 0,
    url,
    startedAt: nowIso(),
    agentVersion: PLUGIN_VERSION,
    stateDir: paths.root,
  }
  const accepted = await postReady({ info, token }, attempt)
  log(accepted
    ? `reported a committed startup for ${attempt}`
    : `the supervising agent did not accept the startup report for ${attempt}`)
}
