/**
 * The restart state machine.
 *
 * One restart is: stop the current harness → start it again with the exact
 * launch specification the previous boot recorded → wait for proof of a
 * committed startup → on failure, restore the last known-good configuration
 * baseline and try once more → write a report the next boot will read.
 *
 * Two independent health signals are accepted, in this order:
 * 1. the plugin's own `appReady` callback (`POST /ready`), which is the only
 *    one that proves the whole plugin tree mounted;
 * 2. a fallback HTTP probe of the surface's loopback URL, used when the
 *    plugin is disabled or was removed by the very change under test.
 * @module dsh-restart/agent/supervisor
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  ENV_AGENT_TOKEN, ENV_AGENT_URL, ENV_ATTEMPT, ENV_STATE_DIR, STATE_VERSION,
  type AgentInfo, type AgentStatus, type AttemptOutcome, type AttemptResult, type LaunchSpec,
  type RestartReport, type RestartRequest, type RollbackRecord, type TrackedFiles,
} from '../protocol.ts'
import {
  ensureDir, listDir, makeId, nowIso, readJson, readTail, sleep, writeJsonAtomic,
} from '../fsx.ts'
import type { StatePaths, InstancePaths } from '../paths.ts'
import { instancePaths } from '../paths.ts'
import { readBaselineManifest, restoreBaseline } from '../snapshot.ts'
import { isAlive, probeHttp, stopProcess } from './process-control.ts'

/** How many reports stay on disk. */
const REPORT_HISTORY_LIMIT = 30

/** One registered harness surface. */
interface InstanceRecord {
  key: string
  paths: InstancePaths
  launch: LaunchSpec
}

/** Supervisor dependencies resolved once at agent startup. */
export interface SupervisorOptions {
  paths: StatePaths
  agentInfo: AgentInfo
  token: string
  log: (line: string) => void
  /** Readiness budget per boot attempt. */
  readyTimeoutMs: number
  /** Grace granted to the previous process before it is force-killed. */
  stopGraceMs: number
  /** How long a started process must stay healthy before it counts as up. */
  settleMs: number
  /** Trailing log characters copied into a report. */
  maxLogTailChars: number
}

/** A readiness signal recorded for one attempt. */
interface ReadySignal {
  ready: boolean
  signalledAt?: number
  url?: string
}

/** Result of a restart request. */
export type RestartOutcome =
  | { ok: true; report: RestartReport }
  | { ok: false; error: string }

/** One boot attempt's arguments. */
interface AttemptArgs {
  id: string
  attempt: number
  launch: LaunchSpec
  request: RestartRequest
  readyTimeoutMs: number
  stopGraceMs: number
  usedRollback: boolean
}

/** Whether an attempt result means "the harness is running". */
function isSuccess(result: AttemptResult): boolean {
  return result === 'ready' || result === 'ready-unconfirmed'
}

/**
 * Human phrasing for a failed attempt, used in report headlines.
 * @param outcome - the recorded attempt.
 * @returns a clause such as `the process exited with code 1`.
 */
function describeAttempt(outcome: AttemptOutcome): string {
  switch (outcome.result) {
    case 'exited':
      return `the process exited with code ${outcome.exitCode ?? 'unknown'}`
        + `${outcome.signal === null || outcome.signal === undefined ? '' : ` (signal ${outcome.signal})`}`
    case 'timeout':
      return `the process never reported a committed startup within ${outcome.durationMs} ms`
    case 'spawn-error':
      return `the process could not be started: ${outcome.note ?? 'unknown error'}`
    default:
      return `the process reported ${outcome.result}`
  }
}

/** The out-of-process supervisor. One instance per agent process. */
export class Supervisor {
  private busy = false
  private current: { id: string; phase: string; startedAt: string } | undefined
  private child: ChildProcess | undefined
  private readonly readySignals = new Map<string, ReadySignal>()

  constructor(private readonly options: SupervisorOptions) {}

  /** Whether a restart is currently running. */
  get isBusy(): boolean {
    return this.busy
  }

  /** The phase line reported by `GET /status`, when a restart is running. */
  get phase(): { id: string; phase: string; startedAt: string } | undefined {
    return this.current
  }

  /**
   * Record a readiness callback from a booted harness.
   * @param attempt - the attempt identity the harness was started with.
   * @param url - optional endpoint the harness reports as answering.
   * @returns true when the attempt is the one currently being supervised.
   */
  markReady(attempt: string, url?: string): boolean {
    const signal = this.readySignals.get(attempt)
    if (signal === undefined) return false
    signal.ready = true
    if (signal.signalledAt === undefined) signal.signalledAt = Date.now()
    if (url !== undefined) signal.url = url
    this.options.log(`attempt ${attempt} reported a committed startup`)
    return true
  }

  /** Current agent status, including the last report and baseline summary. */
  status(): AgentStatus {
    const instances = this.listInstances()
    const resolved = this.resolveInstance({})
    const launch = resolved?.launch
    const tracked = resolved === undefined
      ? undefined
      : readJson<TrackedFiles>(resolved.paths.trackedFiles)
    const manifest = resolved === undefined
      ? undefined
      : readBaselineManifest(resolved.paths.lastGood)
    const reports = this.listReports()
    const status: AgentStatus = {
      version: STATE_VERSION,
      agent: this.options.agentInfo,
      busy: this.busy,
      trackedFiles: tracked?.files ?? [],
      instances: instances.map(record => ({
        key: record.key,
        pid: record.launch.pid,
        cwd: record.launch.cwd,
        startedAt: record.launch.startedAt,
        alive: isAlive(record.launch.pid),
      })),
    }
    if (resolved !== undefined) status.instance = resolved.key
    if (this.current !== undefined) status.current = this.current
    if (launch !== undefined) {
      status.trackedPid = launch.pid
      status.trackedPidAlive = isAlive(launch.pid)
    }
    if (manifest !== undefined) {
      status.lastGood = {
        createdAt: manifest.createdAt,
        source: manifest.source,
        files: manifest.entries.length,
      }
    }
    const latest = reports[0]
    if (latest !== undefined) status.lastReport = latest
    return status
  }

  /**
   * Run one restart to completion and persist its report.
   * @param request - reason, origin, and per-call overrides.
   * @returns the written report, or a refusal when a restart is already running.
   */
  async restart(request: RestartRequest): Promise<RestartOutcome> {
    if (this.busy) return { ok: false, error: 'a restart is already in progress' }
    this.busy = true
    const id = makeId('restart')
    this.current = { id, phase: 'preparing', startedAt: nowIso() }
    this.options.log(`restart ${id}: ${request.reason} (requested by ${request.requestedBy})`)
    try {
      const report = await this.run(id, request)
      this.writeReport(report)
      return { ok: true, report }
    } catch (error) {
      const report = this.failureReport(id, request, error)
      this.writeReport(report)
      return { ok: true, report }
    } finally {
      this.busy = false
      this.current = undefined
      this.child = undefined
    }
  }

  private failureReport(id: string, request: RestartRequest, error: unknown): RestartReport {
    return {
      version: STATE_VERSION,
      id,
      createdAt: nowIso(),
      status: 'failed',
      headline: `Restart failed before any process was started: ${error instanceof Error ? error.message : String(error)}`,
      reason: request.reason,
      requestedBy: request.requestedBy,
      fromPid: request.pid ?? null,
      attempts: [],
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }
  }

  private async run(id: string, request: RestartRequest): Promise<RestartReport> {
    const instance = this.resolveInstance(request)
    const launch = instance?.launch
    const readyTimeoutMs = request.readyTimeoutMs ?? this.options.readyTimeoutMs
    const stopGraceMs = request.stopGraceMs ?? this.options.stopGraceMs
    const rollbackOnFailure = request.rollbackOnFailure ?? true
    const base: RestartReport = {
      version: STATE_VERSION,
      id,
      createdAt: nowIso(),
      status: 'ok',
      headline: '',
      reason: request.reason,
      requestedBy: request.requestedBy,
      fromPid: request.pid ?? launch?.pid ?? null,
      attempts: [],
    }
    if (launch !== undefined) base.cwd = launch.cwd
    if (instance === undefined || launch === undefined) {
      return {
        ...base,
        status: 'failed',
        headline: 'Restart failed: no harness instance has registered a launch specification, '
          + 'so there is nothing to start again.',
        error: `expected a launch specification under ${join(this.options.paths.instances, '<instance>', 'launch.json')}`,
      }
    }

    let rollback: RollbackRecord = { performed: false, restored: [], removed: [], failures: [] }
    if (request.rollbackNow === true) {
      rollback = this.applyRollback(instance, 'explicit rollback requested before the restart')
    }

    this.writeProvisional(
      base, [], rollback,
      `Restart in progress: ${request.reason}`
      + `${rollback.performed ? ' (configuration rolled back first)' : ''}.`,
    )
    const first = await this.runAttempt({
      id, attempt: 1, launch, request, readyTimeoutMs, stopGraceMs, usedRollback: rollback.performed,
    })
    base.attempts.push(first)
    if (isSuccess(first.result)) {
      return {
        ...base,
        status: rollback.performed ? 'rolled-back' : 'ok',
        headline: rollback.performed
          ? `Configuration rolled back and DeepSeek Harness restarted as pid ${String(first.pid ?? 0)}.`
          : `DeepSeek Harness restarted as pid ${String(first.pid ?? 0)}.`,
        ...(rollback.performed ? { rollback } : {}),
      }
    }

    const failureClause = describeAttempt(first)
    if (!rollbackOnFailure) {
      return {
        ...base,
        status: 'failed',
        headline: `DeepSeek Harness failed to restart (${failureClause}); automatic rollback is disabled.`,
      }
    }
    const manifest = readBaselineManifest(instance.paths.lastGood)
    if (manifest === undefined || manifest.entries.length === 0) {
      return {
        ...base,
        status: 'failed',
        headline: `DeepSeek Harness failed to restart (${failureClause}) and no last known-good snapshot exists, so there was nothing to roll back to.`,
      }
    }

    rollback = this.applyRollback(instance, `boot attempt 1 failed: ${failureClause}`, manifest)
    this.writeProvisional(
      base, [first], rollback,
      `The first boot failed (${failureClause}). The configuration was rolled back `
      + `(${String(rollback.restored.length)} restored, ${String(rollback.removed.length)} removed) `
      + 'and DeepSeek Harness is starting again now.',
    )
    const second = await this.runAttempt({
      id, attempt: 2, launch, request, readyTimeoutMs, stopGraceMs, usedRollback: true,
    })
    base.attempts.push(second)
    if (isSuccess(second.result)) {
      return {
        ...base,
        status: 'rolled-back',
        rollback,
        headline: `The first boot failed (${failureClause}); the configuration was rolled back `
          + `(${String(rollback.restored.length)} restored, ${String(rollback.removed.length)} removed) `
          + `and DeepSeek Harness restarted as pid ${String(second.pid ?? 0)}.`,
      }
    }
    return {
      ...base,
      status: 'failed',
      rollback,
      headline: `DeepSeek Harness is NOT running: the first boot failed (${failureClause}) and the `
        + `rolled-back configuration failed too (${describeAttempt(second)}).`,
      ...(second.note === undefined ? {} : { error: second.note }),
    }
  }

  /** Restore an instance's baseline and describe what changed. */
  private applyRollback(
    instance: InstanceRecord,
    reason: string,
    manifest = readBaselineManifest(instance.paths.lastGood),
  ): RollbackRecord {
    if (manifest === undefined || manifest.entries.length === 0) {
      return {
        performed: false,
        reason: `${reason} (no snapshot available)`,
        restored: [],
        removed: [],
        failures: [],
      }
    }
    this.options.log(`rolling back configuration to the snapshot taken at ${manifest.createdAt}`)
    const outcome = restoreBaseline(instance.paths.lastGood, manifest)
    this.options.log(
      `rollback restored ${String(outcome.restored.length)} file(s), removed `
      + `${String(outcome.removed.length)}, failed ${String(outcome.failures.length)}`,
    )
    return {
      performed: true,
      reason,
      baselineDir: instance.paths.lastGood,
      baselineCreatedAt: manifest.createdAt,
      restored: outcome.restored,
      removed: outcome.removed,
      failures: outcome.failures,
    }
  }

  private async runAttempt(args: AttemptArgs): Promise<AttemptOutcome> {
    const { id, attempt, launch, request, readyTimeoutMs, stopGraceMs, usedRollback } = args
    const startedAtIso = nowIso()
    const startedAt = Date.now()
    const logFile = join(this.options.paths.logs, `${id}-attempt${String(attempt)}.log`)
    ensureDir(this.options.paths.logs)

    this.setPhase(`attempt ${attempt}: stopping the previous process`)
    await this.stopPrevious(request, launch, stopGraceMs)

    const attemptId = `${id}#${String(attempt)}`
    this.readySignals.set(attemptId, { ready: false })

    this.setPhase(`attempt ${attempt}: starting dsh`)
    const environment = this.childEnvironment(launch, attemptId)
    // The relaunch args are the recorded command line plus the arguments a
    // supervised boot needs. A restarted Web surface must not pop a second
    // browser tab, so `--no-open` is appended — either because the requester
    // asked for it, or, when nobody asked (a restart started from the command
    // line has no plugin to ask), because the boot that recorded the launch
    // spec had a Web surface mounted.
    const appendArgs = request.appendArgs ?? (
      launch.webSurface === true && !launch.argv.includes('--no-open') ? ['--no-open'] : []
    )
    const invocation = [...launch.execArgv, ...launch.argv, ...appendArgs]
    this.options.log(`attempt ${attempt}: ${launch.execPath} ${invocation.join(' ')} (cwd ${launch.cwd})`)

    let spawnError: Error | undefined
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let child: ChildProcess
    const logFd = openSync(logFile, 'a')
    try {
      child = spawn(launch.execPath, invocation, {
        cwd: launch.cwd,
        env: environment,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      })
    } catch (error) {
      closeSync(logFd)
      return this.finishAttempt({
        attempt, startedAt, startedAtIso, logFile, usedRollback, pid: undefined,
        result: 'spawn-error',
        note: error instanceof Error ? error.message : String(error),
      })
    }
    closeSync(logFd)
    this.child = child
    child.once('error', (error) => { spawnError = error })
    child.once('exit', (code, signal) => { exit = { code, signal } })
    this.options.log(`attempt ${attempt}: started pid ${String(child.pid ?? 0)}`)

    const outcome = await this.awaitReady({
      attemptId,
      startedAt,
      readyTimeoutMs,
      ...(launch.healthUrl === undefined ? {} : { healthUrl: launch.healthUrl }),
      getExit: () => exit,
      getSpawnError: () => spawnError,
    })

    // A slow boot can signal readiness just after the deadline; treat that as
    // success rather than rolling back a tree that did come up.
    const lateReady = this.readySignals.get(attemptId)?.ready === true
    const result: AttemptResult = !isSuccess(outcome.result) && lateReady ? 'ready' : outcome.result
    return this.finishAttempt({
      attempt,
      startedAt,
      startedAtIso,
      logFile,
      usedRollback,
      pid: child.pid,
      result,
      ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      ...(outcome.signal === undefined ? {} : { signal: outcome.signal }),
      ...(outcome.note === undefined
        ? {}
        : { note: result === outcome.result ? outcome.note : `${outcome.note} (readiness arrived late)` }),
    })
  }

  /** Stop whatever harness process is still around before a new attempt. */
  private async stopPrevious(
    request: RestartRequest,
    launch: LaunchSpec,
    stopGraceMs: number,
  ): Promise<void> {
    // A leftover child from a failed attempt is unhealthy by definition: give
    // it almost no grace, because it may be holding the surface's port.
    const leftover = this.child
    if (leftover?.pid !== undefined && isAlive(leftover.pid)) {
      this.options.log(`stopping the previous attempt's process ${leftover.pid}`)
      await stopProcess(leftover.pid, 1_500, this.options.log)
    }
    const tracked = request.pid ?? launch.pid
    if (isAlive(tracked)) {
      this.options.log(`waiting up to ${stopGraceMs} ms for pid ${tracked} to shut down`)
      await stopProcess(tracked, stopGraceMs, this.options.log)
    }
  }

  private childEnvironment(launch: LaunchSpec, attemptId: string): Record<string, string> {
    const captured = Object.keys(launch.env).length > 0
      ? launch.env
      : Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      )
    const environment: Record<string, string> = { ...captured }
    // Never inherit a stale handshake: this attempt's identity is the only one
    // the supervisor will accept.
    delete environment[ENV_ATTEMPT]
    delete environment[ENV_AGENT_URL]
    delete environment[ENV_AGENT_TOKEN]
    environment[ENV_AGENT_URL] = this.options.agentInfo.url
    environment[ENV_AGENT_TOKEN] = this.options.token
    environment[ENV_ATTEMPT] = attemptId
    environment[ENV_STATE_DIR] = this.options.paths.root
    return environment
  }

  /** Wait for a readiness signal, a fallback health probe, an exit, or the deadline. */
  private async awaitReady(args: {
    attemptId: string
    startedAt: number
    readyTimeoutMs: number
    healthUrl?: string
    getExit: () => { code: number | null; signal: NodeJS.Signals | null } | undefined
    getSpawnError: () => Error | undefined
  }): Promise<{ result: AttemptResult; exitCode?: number | null; signal?: NodeJS.Signals | null; note?: string }> {
    const deadline = args.startedAt + args.readyTimeoutMs
    let healthOkAt: number | undefined
    while (true) {
      const spawnError = args.getSpawnError()
      if (spawnError !== undefined) return { result: 'spawn-error', note: spawnError.message }

      const exit = args.getExit()
      if (exit !== undefined) {
        return {
          result: 'exited',
          exitCode: exit.code,
          signal: exit.signal,
          note: `the process exited after ${String(Date.now() - args.startedAt)} ms`,
        }
      }

      const now = Date.now()
      const signal = this.readySignals.get(args.attemptId)
      if (signal?.ready === true && signal.signalledAt !== undefined
        && now - signal.signalledAt >= this.options.settleMs) {
        return { result: 'ready', note: 'the plugin confirmed a committed startup' }
      }

      if (args.healthUrl !== undefined && healthOkAt === undefined && now - args.startedAt > 1_200) {
        if (await probeHttp(args.healthUrl, 900)) healthOkAt = Date.now()
      }
      if (healthOkAt !== undefined && signal?.ready !== true && now - healthOkAt >= this.options.settleMs) {
        return {
          result: 'ready-unconfirmed',
          note: `the HTTP surface answered on ${args.healthUrl ?? ''} and the process stayed alive, `
            + 'but the plugin never reported a committed startup',
        }
      }

      if (now > deadline) {
        if (healthOkAt !== undefined) {
          return { result: 'ready-unconfirmed', note: 'the process is alive but never confirmed startup' }
        }
        return {
          result: 'timeout',
          note: `no readiness signal arrived within ${String(args.readyTimeoutMs)} ms`,
        }
      }
      await sleep(200)
    }
  }

  private finishAttempt(input: {
    attempt: number
    startedAt: number
    startedAtIso: string
    logFile: string
    usedRollback: boolean
    pid: number | undefined
    result: AttemptResult
    exitCode?: number | null
    signal?: NodeJS.Signals | null
    note?: string
  }): AttemptOutcome {
    const outcome: AttemptOutcome = {
      attempt: input.attempt,
      startedAt: input.startedAtIso,
      finishedAt: nowIso(),
      durationMs: Date.now() - input.startedAt,
      result: input.result,
      usedRollback: input.usedRollback,
      logFile: input.logFile,
      logTail: readTail(input.logFile, this.options.maxLogTailChars),
    }
    if (input.pid !== undefined) outcome.pid = input.pid
    if (input.exitCode !== undefined) outcome.exitCode = input.exitCode
    if (input.signal !== undefined) outcome.signal = input.signal
    if (input.note !== undefined) outcome.note = input.note
    this.options.log(`attempt ${input.attempt} finished: ${input.result} in ${String(outcome.durationMs)} ms`)
    return outcome
  }

  private setPhase(phase: string): void {
    if (this.current !== undefined) this.current.phase = phase
  }

  /** Every instance that has registered a launch specification. */
  private listInstances(): InstanceRecord[] {
    return listDir(this.options.paths.instances)
      .map(key => {
        const paths = instancePaths(this.options.paths.root, key)
        const launch = readJson<LaunchSpec>(paths.launchSpec)
        return launch === undefined ? undefined : { key, paths, launch }
      })
      .filter((record): record is InstanceRecord => record !== undefined)
      .sort((left, right) => right.launch.startedAt.localeCompare(left.launch.startedAt))
  }

  /**
   * Resolve which instance a request targets: the named one when it exists,
   * otherwise the most recently started instance that is still alive, and
   * finally the most recently started instance of any kind.
   */
  private resolveInstance(request: Pick<RestartRequest, 'instance'>): InstanceRecord | undefined {
    const instances = this.listInstances()
    if (request.instance !== undefined) {
      const named = instances.find(record => record.key === request.instance)
      if (named !== undefined) return named
    }
    return instances.find(record => isAlive(record.launch.pid)) ?? instances[0]
  }

  private listReports(): RestartReport[] {
    return listDir(this.options.paths.reports)
      .filter(name => name.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, REPORT_HISTORY_LIMIT)
      .map(name => readJson<RestartReport>(join(this.options.paths.reports, name)))
      .filter((report): report is RestartReport => report !== undefined)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  private writeReport(report: RestartReport): void {
    ensureDir(this.options.paths.reports)
    const file = join(this.options.paths.reports, `${report.id}.json`)
    // A provisional report is often replaced after the boot it describes has
    // already read and acknowledged it; carrying the acknowledgement forward
    // keeps the final write from re-delivering the same restart next boot.
    const existing = readJson<RestartReport>(file)
    const deliveredAt = report.deliveredAt ?? existing?.deliveredAt
    writeJsonAtomic(file, deliveredAt === undefined ? report : { ...report, deliveredAt })
    this.pruneReports()
    this.options.log(`report ${report.id}: [${report.status}] ${report.headline}`)
  }

  /**
   * Write the "this is what you are booting into" snapshot.
   *
   * The final report cannot serve that purpose: it is only complete once the
   * new process has already applied its plugins and read the report
   * directory. Writing before every spawn is what lets a booted instance see
   * the failure and rollback that produced it.
   */
  private writeProvisional(
    base: RestartReport,
    attempts: AttemptOutcome[],
    rollback: RollbackRecord,
    headline: string,
  ): void {
    this.writeReport({
      ...base,
      status: 'in-progress',
      headline,
      attempts: [...attempts],
      ...(rollback.performed ? { rollback } : {}),
    })
  }

  private pruneReports(): void {
    const reports = listDir(this.options.paths.reports).filter(name => name.endsWith('.json')).sort()
    for (const stale of reports.slice(0, Math.max(0, reports.length - REPORT_HISTORY_LIMIT))) {
      try {
        unlinkSync(join(this.options.paths.reports, stale))
      } catch {
        // A report that cannot be pruned is not worth failing a restart over.
      }
    }
  }
}
