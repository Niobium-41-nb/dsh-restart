/**
 * The resurrection watchdog: the last line of defence for a graceful restart.
 *
 * A tool- or service-triggered restart has two halves. The plugin asks the
 * control agent for one, then the plugin exits so the agent can start the
 * replacement. If the agent dies in between — the incident this whole plugin
 * exists because of — nothing starts the replacement and the harness simply
 * stays down.
 *
 * The plugin therefore arms this process immediately before asking the launcher
 * to exit. It waits for the outgoing pid to disappear, checks whether somebody
 * else started a replacement, and only then starts one itself from the recorded
 * launch specification. It is spawned through the same two-stage launcher the
 * control agent uses, so a `taskkill /T` aimed at the dying harness cannot take
 * it down with the tree it is watching.
 *
 * What it deliberately does NOT cover: a restart the agent performs by force
 * (`taskkill /T /F`), because there the plugin is already dead and never gets to
 * arm anything, and a crash of the harness itself, where no restart was ever
 * requested. Both leave the report and the lamp as the only signals.
 *
 * Bundled with NO `@deepseek-ai/*` imports, like the agent: it has to run while
 * the harness tree is in whatever state the failed restart left it.
 * @module dsh-restart/watchdog
 */

import { spawn } from 'node:child_process'
import { appendFileSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentStatus, LaunchSpec } from './protocol.ts'
import { ENV_WATCHDOG } from './protocol.ts'
import { SPAWN_COMMAND, fetchStatus, readAgentInfo } from './agent-client.ts'
import { ensureDir, isFile, makeId, nowIso, readJson, sleep } from './fsx.ts'
import { instancePaths, resolveStateDir, statePaths, type StatePaths } from './paths.ts'
import { readLatestReport, rewriteReport } from './reports.ts'
import { isAlive } from './agent/process-control.ts'

/** Version reported in the watchdog's own log lines. */
export const WATCHDOG_VERSION = '0.1.0'

/** Default window to wait for somebody else to bring the harness back. */
const DEFAULT_WAIT_MS = 120_000

/** Default poll interval. */
const DEFAULT_POLL_MS = 1_000

/**
 * Default window the control agent must stay unreachable before this process
 * takes over.
 *
 * Being unable to *ask* the agent is not evidence that it is dead: it may be
 * mid-spawn with its control port briefly unresponsive. A reloading agent
 * answers within a second, so requiring a silence this long removes the race
 * while still being far quicker than a user would start the harness by hand.
 */
const DEFAULT_SILENCE_MS = 10_000

/** Parsed command line. */
export interface WatchdogArgs {
  stateDir: string
  /** Instance key whose launch specification is being watched. */
  instance: string
  /** PID of the process that is on its way out. */
  pid: number
  waitMs: number
  pollMs: number
  silenceMs: number
  /** Why the restart was requested; carried into the finalized report. */
  reason: string
}

const HELP = `dsh-restart watchdog — internal safety net for a graceful restart

Usage:
  watchdog --state-dir <dir> --instance <key> --pid <pid> [options]

Options:
  --wait-ms <ms>      how long to wait for a replacement (default ${String(DEFAULT_WAIT_MS)})
  --poll-ms <ms>      poll interval (default ${String(DEFAULT_POLL_MS)})
  --silence-ms <ms>   how long the agent must stay unreachable before taking
                      over (default ${String(DEFAULT_SILENCE_MS)})
  --reason <text>     restart reason, recorded in the finalized report

This process is started by the dsh-restart plugin and is not meant to be run by
hand. It relaunches the harness itself only when the outgoing process is gone,
no replacement is alive, and the control agent is provably not working on one.
`

/**
 * Parse the watchdog command line.
 * @param argv - arguments after the executable.
 * @returns the resolved invocation.
 */
export function parseArgs(argv: readonly string[]): WatchdogArgs {
  const args: WatchdogArgs = {
    stateDir: resolveStateDir(),
    instance: '',
    pid: 0,
    waitMs: DEFAULT_WAIT_MS,
    pollMs: DEFAULT_POLL_MS,
    silenceMs: DEFAULT_SILENCE_MS,
    reason: 'restart requested through the supervisor',
  }
  const queue = [...argv]
  while (queue.length > 0) {
    const flag = queue.shift()
    const value = queue.shift()
    switch (flag) {
      case '--state-dir': args.stateDir = value ?? args.stateDir; break
      case '--instance': args.instance = value ?? ''; break
      case '--pid': args.pid = Number(value ?? '0'); break
      case '--wait-ms': args.waitMs = Number(value ?? '0'); break
      case '--poll-ms': args.pollMs = Number(value ?? '0'); break
      case '--silence-ms': args.silenceMs = Number(value ?? '0'); break
      case '--reason': args.reason = value ?? args.reason; break
      case 'help':
      case '--help': throw new Error('help')
      default: throw new Error(`unknown argument ${JSON.stringify(flag ?? '')}`)
    }
  }
  if (args.instance === '') throw new Error('--instance is required')
  if (!Number.isInteger(args.pid) || args.pid <= 0) throw new Error('--pid must be a positive integer')
  if (!Number.isFinite(args.waitMs) || args.waitMs <= 0) throw new Error('--wait-ms must be a positive number')
  if (!Number.isFinite(args.pollMs) || args.pollMs <= 0) throw new Error('--poll-ms must be a positive number')
  if (!Number.isFinite(args.silenceMs) || args.silenceMs < 0) throw new Error('--silence-ms must not be negative')
  return args
}

/** What the loop decided to do this tick. */
export type WatchdogVerdict = 'replacement-up' | 'wait' | 'take-over'

/** One observation of the world the watchdog acts on. */
export interface WatchdogObservation {
  /** PID recorded in the launch specification, if one is readable. */
  trackedPid: number | undefined
  /** Whether the outgoing process is still running. */
  outgoingAlive: boolean
  /** Whether the recorded track is a live process distinct from the outgoing one. */
  replacementAlive: boolean
  /** Control-agent status, or undefined when it did not answer. */
  agent: AgentStatus | undefined
  /** Milliseconds the agent has been unreachable, or undefined while it answers. */
  agentSilentMs: number | undefined
  /** Silence the agent must accumulate before this process takes over. */
  silenceMs: number
}

/**
 * Decide what one observation means.
 *
 * Kept separate from the loop because every branch here is a way to get it
 * wrong: starting a second harness while one is on its way up is far worse than
 * waiting a few more seconds.
 *
 * @param observation - what the last tick saw.
 * @returns the verdict for this tick.
 */
export function verdictOf(observation: WatchdogObservation): WatchdogVerdict {
  // Somebody started a replacement — the agent, a CLI restart, or the user by
  // hand. Whoever it was, the harness is coming back and this process is done.
  if (observation.replacementAlive) return 'replacement-up'
  // The outgoing process has not left yet; nothing to do until it does.
  if (observation.outgoingAlive) return 'wait'
  // The agent is working on this restart: it is the one that will spawn.
  if (observation.agent !== undefined && observation.agent.busy === true) return 'wait'
  // An answering, idle agent with a dead harness means the restart it accepted
  // is not running any more either — the same hole, one boot later.
  if (observation.agent !== undefined) return 'take-over'
  // No answer at all: only silence long enough to rule out a mid-spawn agent
  // justifies stepping in.
  const silentFor = observation.agentSilentMs ?? 0
  return silentFor >= observation.silenceMs ? 'take-over' : 'wait'
}

/** Where the watchdog writes its lines. */
function logPath(paths: StatePaths): string {
  return join(paths.logs, 'watchdog.log')
}

/** Append one line to the watchdog log; never throws. */
function appendLog(paths: StatePaths, line: string): void {
  try {
    ensureDir(paths.logs)
    appendFileSync(logPath(paths), `[${nowIso()}] ${line}\n`)
  } catch {
    // Diagnostics are best-effort by design: the relaunch matters, the log does not.
  }
}

/** Ask the control agent for its status; `undefined` when it does not answer. */
async function askAgent(paths: StatePaths): Promise<AgentStatus | undefined> {
  const info = readAgentInfo(paths)
  if (info === undefined || !isAlive(info.pid)) return undefined
  let token: string
  try {
    token = readFileSync(paths.token, 'utf8').trim()
  } catch {
    return undefined
  }
  return await fetchStatus({ info, token, timeoutMs: 2_000 })
}

/**
 * Start the harness from the recorded launch specification.
 * @param options - state layout, instance key, outgoing pid, and a logger.
 * @returns the spawned pid, or undefined when nothing could be started.
 */
function relaunch(options: {
  paths: StatePaths
  instance: string
  pid: number
  reason: string
  log: (line: string) => void
}): number | undefined {
  const { paths, instance, pid, log } = options
  const spec = readJson<LaunchSpec>(instancePaths(paths.root, instance).launchSpec)
  if (spec === undefined) {
    log('no launch specification is readable, so there is nothing to start again')
    return undefined
  }
  if (!isFile(spec.execPath)) {
    log(`the recorded interpreter ${spec.execPath} is missing; refusing to guess`)
    return undefined
  }
  const argv = [...spec.execArgv, ...spec.argv]
  // Same rule the agent follows: a supervised Web relaunch must not open a
  // second browser tab, and the flag is only ever added for a Web surface.
  if (spec.webSurface === true && !argv.includes('--no-open')) argv.push('--no-open')
  const outputFile = join(paths.logs, `${makeId('watchdog-relaunch')}.log`)
  ensureDir(paths.logs)
  let child
  try {
    const fd = openSync(outputFile, 'a')
    child = spawn(spec.execPath, argv, {
      cwd: spec.cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      // The captured environment when there is one, so the restart really is
      // "the same command line in the same world"; otherwise whatever this
      // process inherited. Either way the stamp below marks who started it.
      env: {
        ...(Object.keys(spec.env ?? {}).length > 0 ? spec.env : process.env),
        [ENV_WATCHDOG]: String(pid),
      },
    })
  } catch (error) {
    log(`could not start ${spec.execPath}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  child.unref()
  log(`relaunched ${spec.execPath} ${argv.join(' ')} (cwd ${spec.cwd}) as pid ${String(child.pid ?? 0)} `
    + `for "${options.reason}"; its output goes to ${outputFile}`)
  finalizeReport(paths, log, child.pid, spec)
  return child.pid
}

/**
 * Give the report of the dead agent a terminal state.
 *
 * Only a record still marked `in-progress` is touched — anything else belongs to
 * somebody who was still alive to finish it — and `deliveredAt` is carried over,
 * so closing it here can never re-deliver it to the model.
 *
 * @param paths - state layout.
 * @param log - diagnostic sink.
 * @param spawnedPid - the replacement this process started, when it did.
 * @param spec - the launch specification that was used.
 */
function finalizeReport(
  paths: StatePaths,
  log: (line: string) => void,
  spawnedPid: number | undefined,
  spec: LaunchSpec,
): void {
  const latest = readLatestReport(paths)
  if (latest === undefined || latest.status !== 'in-progress') return
  try {
    rewriteReport(paths, latest, {
      status: 'ok',
      headline: spawnedPid === undefined
        ? 'The control agent stopped mid-restart; DeepSeek Harness was started again by the watchdog.'
        : `The control agent stopped mid-restart; the watchdog started DeepSeek Harness again as pid ${String(spawnedPid)}.`,
      error: `recovered by the watchdog at ${nowIso()}: the outgoing process (pid ${String(spec.pid)}) exited, `
        + 'no replacement appeared and no restart was running',
    })
    log(`closed the report of the interrupted restart ${latest.id}`)
  } catch (error) {
    log(`could not close report ${latest.id}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Run the watchdog until it either hands over or gives up.
 * @param args - resolved command line.
 * @returns the process exit code (0 when a harness is up or was started).
 */
export async function runWatchdog(args: WatchdogArgs): Promise<number> {
  const paths = statePaths(args.stateDir)
  const log = (line: string): void => { appendLog(paths, line) }
  const deadline = Date.now() + args.waitMs
  let silentSince: number | undefined
  log(`armed v${WATCHDOG_VERSION}: watching pid ${String(args.pid)} of instance ${args.instance} `
    + `for up to ${String(args.waitMs)} ms (reason: ${args.reason})`)

  while (Date.now() < deadline) {
    await sleep(args.pollMs)
    const spec = readJson<LaunchSpec>(instancePaths(paths.root, args.instance).launchSpec)
    const trackedPid = spec?.pid
    const outgoingAlive = isAlive(args.pid)
    const agent = await askAgent(paths)
    if (agent === undefined) silentSince ??= Date.now()
    else silentSince = undefined
    const observation: WatchdogObservation = {
      trackedPid,
      outgoingAlive,
      replacementAlive: trackedPid !== undefined && trackedPid !== args.pid && isAlive(trackedPid),
      agent,
      agentSilentMs: silentSince === undefined ? undefined : Date.now() - silentSince,
      silenceMs: args.silenceMs,
    }
    const verdict = verdictOf(observation)
    if (verdict === 'replacement-up') {
      log(`pid ${String(trackedPid)} is running: a replacement is already up, nothing to do`)
      return 0
    }
    if (verdict === 'wait') continue
    log(`taking over: outgoing pid ${String(args.pid)} is gone, no replacement is alive, and `
      + (agent === undefined
        ? `the control agent has been unreachable for ${String(observation.agentSilentMs ?? 0)} ms`
        : 'the control agent reports no restart in progress'))
    const spawned = relaunch({ paths, instance: args.instance, pid: args.pid, reason: args.reason, log })
    return spawned === undefined ? 1 : 0
  }

  log(`gave up after ${String(args.waitMs)} ms without seeing a replacement or a reason to start one`)
  return 1
}

/**
 * Spawn the requested watchdog invocation detached, then exit immediately.
 *
 * Mirrors the agent's internal launcher (`__spawn-detached`): the child is
 * reparented out of the dying harness's process tree, which is what keeps a
 * `taskkill /T /F` on that tree from killing the thing that is supposed to
 * resurrect it.
 *
 * @param argv - the command line for the detached child.
 * @returns always 0; spawning is fire-and-forget.
 */
function spawnDetachedAndExit(argv: readonly string[]): number {
  const entry = process.argv[1]
  if (entry === undefined || argv.length === 0) {
    process.stderr.write('dsh-restart watchdog: the internal launcher needs an entry point\n')
    return 2
  }
  const child = spawn(process.execPath, [entry, ...argv], {
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
 * Run the watchdog command line.
 * @param argv - arguments after the executable.
 * @returns the process exit code.
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  if (argv[0] === SPAWN_COMMAND) return spawnDetachedAndExit(argv.slice(1))
  if (argv[0] === 'help' || argv[0] === '--help') {
    process.stdout.write(HELP)
    return 0
  }
  let args: WatchdogArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`dsh-restart watchdog: ${message === 'help' ? HELP : `${message}\n${HELP}`}\n`)
    return 2
  }
  return await runWatchdog(args)
}

/**
 * Whether this module is the process entry point.
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
      process.stderr.write(`dsh-restart watchdog: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
