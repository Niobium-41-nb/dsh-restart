/**
 * Wire and on-disk types shared by the dsh-restart host plugin and its
 * standalone restart agent.
 *
 * This module (and everything it is bundled with) is deliberately free of
 * `@deepseek-ai/*` imports: the agent has to start and finish a rollback while
 * the harness tree itself is broken, so it may only rely on node builtins.
 * @module dsh-restart/protocol
 */

/** On-disk schema version for every state file this plugin writes. */
export const STATE_VERSION = 1

/** Environment variable naming the control agent's loopback base URL. */
export const ENV_AGENT_URL = 'DSH_RESTART_AGENT'
/** Environment variable carrying the bearer token a boot must present back to the agent. */
export const ENV_AGENT_TOKEN = 'DSH_RESTART_TOKEN'
/** Environment variable carrying the attempt identity the agent is waiting on. */
export const ENV_ATTEMPT = 'DSH_RESTART_ATTEMPT'
/**
 * Environment variable the resurrection watchdog stamps on the process it starts.
 *
 * It answers the same question {@link ENV_ATTEMPT} answers for the agent — "did
 * somebody start this harness, or did it come up on its own?" — for the case
 * where the agent died mid-restart and the watchdog had to finish the job. Boot
 * reconciliation must not call a process abandoned when this is set.
 */
export const ENV_WATCHDOG = 'DSH_RESTART_WATCHDOG'
/** Environment variable overriding the state directory (defaults under `$DSH_HOME`). */
export const ENV_STATE_DIR = 'DSH_RESTART_STATE_DIR'

/** Everything the agent needs to relaunch the harness exactly as it was launched. */
export interface LaunchSpec {
  version: number
  /** PID of the process this spec describes. */
  pid: number
  /** Identity of this boot, regenerated every time the plugin applies. */
  launchId: string
  startedAt: string
  /** Working directory the harness was launched from. */
  cwd: string
  /** Absolute node executable path (`process.execPath`). */
  execPath: string
  /** Loader flags such as `--import tsx/esm` (`process.execArgv`). */
  execArgv: string[]
  /** Script and inner arguments (`process.argv.slice(1)`). */
  argv: string[]
  /** Environment captured at plugin apply time; empty when capture is disabled. */
  env: Record<string, string>
  /** Loopback URL whose answer proves the HTTP surface is up, when known. */
  healthUrl?: string
  /** Absolute profile directory this boot was composed from. */
  profileDir?: string
  /**
   * Whether a Web surface was mounted in this boot.
   *
   * Recorded at the committed-startup signal, once every service exists. A
   * relaunch reads it to decide that `--no-open` belongs on the command line —
   * including a relaunch started from the command line, which has no plugin to
   * ask.
   */
  webSurface?: boolean
  /** Installed `@deepseek-ai/deepseek-harness` version, when discoverable. */
  dshVersion?: string
  /** Version of this plugin. */
  pluginVersion?: string
}

/** Identity and endpoint of the running control agent. */
export interface AgentInfo {
  version: number
  pid: number
  /**
   * The agent's parent pid at startup. It is normally a short-lived launcher
   * that has already exited, which is how the agent stays outside the
   * harness's process tree.
   */
  ppid?: number
  host: string
  port: number
  startedAt: string
  agentVersion: string
  stateDir: string
  /**
   * The agent's working directory at startup.
   *
   * Recorded because it must NOT be inside the plugin's own package: a
   * long-lived process holds a handle on its working directory on Windows,
   * and one parked in `node_modules/dsh-restart` makes the next
   * `pnpm add` fail with EPERM.
   */
  cwd?: string
  /** Base URL, as clients should address it. */
  url: string
}

/** A restart request as accepted by `POST /restart`. */
export interface RestartRequest {
  reason: string
  /** Free-form origin label: `tool`, `service`, `cli`, … */
  requestedBy: string
  /**
   * Instance key selecting which harness surface to restart (see
   * `instanceKey` in `paths.ts`). Omitted requests fall back to the most
   * recently registered instance.
   */
  instance?: string
  /** PID asking for the restart; defaults to the tracked launch spec's PID. */
  pid?: number
  /**
   * Arguments appended to the recorded command line for this relaunch only.
   *
   * Used for facts that are true of a *supervised* relaunch but not of the
   * invocation that recorded the launch spec — a restarted Web surface must
   * not pop a second browser tab, so it is relaunched with `--no-open`.
   */
  appendArgs?: string[]
  /** Restore the last known-good baseline *before* the first boot attempt. */
  rollbackNow?: boolean
  /** Roll back and retry once when the first boot attempt fails. Defaults to true. */
  rollbackOnFailure?: boolean
  /** Readiness budget for each attempt, in milliseconds. */
  readyTimeoutMs?: number
  /** Grace allowed for the previous process to exit on its own. */
  stopGraceMs?: number
}

/** Result classification of one boot attempt. */
export type AttemptResult = 'ready' | 'ready-unconfirmed' | 'exited' | 'timeout' | 'spawn-error'

/** One boot attempt, as recorded in the report. */
export interface AttemptOutcome {
  attempt: number
  pid?: number
  startedAt: string
  finishedAt: string
  durationMs: number
  result: AttemptResult
  exitCode?: number | null
  signal?: string | null
  /** Whether this attempt ran on a rolled-back configuration. */
  usedRollback: boolean
  logFile: string
  logTail: string
  note?: string
}

/** What a rollback restored, removed, or failed to touch. */
export interface RollbackRecord {
  performed: boolean
  reason?: string
  baselineDir?: string
  baselineCreatedAt?: string
  restored: string[]
  removed: string[]
  failures: { path: string; error: string }[]
}

/**
 * Terminal status of a restart.
 *
 * `in-progress` is written *before* a process is spawned so the process that
 * is about to boot can read what it is booting into — including the failure
 * and rollback that preceded it. It is replaced by a terminal status once the
 * attempt settles.
 */
export type ReportStatus = 'ok' | 'rolled-back' | 'failed' | 'in-progress'

/** The durable record of one restart, read by the next boot. */
export interface RestartReport {
  version: number
  id: string
  createdAt: string
  status: ReportStatus
  /** One-line summary suitable for a terminal line or a prompt section. */
  headline: string
  reason: string
  requestedBy: string
  fromPid: number | null
  cwd?: string
  attempts: AttemptOutcome[]
  rollback?: RollbackRecord
  /** Populated when the restart could not even be attempted. */
  error?: string
  /** Set by the plugin once the report has been surfaced to the model. */
  deliveredAt?: string
}

/**
 * One session's request to be woken again after the restart it asked for.
 *
 * A restart is the only operation that ends a turn *and* the process running
 * it, so the conversation stops there: the model writes its closing message,
 * the tree goes down, and nothing in the new process knows a task was in
 * flight. The model then waits for the human to say "go on" — which is the
 * whole reason this record exists.
 *
 * It is written by the process that is about to die (the requesting session is
 * only knowable there) and claimed by the process that boots in its place.
 * Claiming is recorded *before* the session is woken: an intent must never be
 * able to resume twice, however the boot ends.
 */
export interface ResumeIntent {
  version: number
  /** Session whose turn was cut off by the restart. */
  sessionId: string
  /** Working directory of the requesting process, for diagnostics. */
  cwd?: string
  /**
   * The reason the model gave when it asked for the restart.
   *
   * Untrusted, model-authored text: it is quoted as data in the resume
   * framing, never interpolated into it as instructions.
   */
  reason: string
  requestedAt: string
  /** PID of the process that requested the restart. */
  fromPid: number
  /** Instance key the request belonged to; a boot ignores another instance's intent. */
  instance: string
  /**
   * Agent preset the requesting session ran under, when it could be read.
   *
   * The resumed agent is mounted with the same preset, so waking a session
   * does not silently swap its tools and system prompt for the defaults.
   */
  agentPreset?: string
  /** Set by the boot that claimed this intent (see the type comment). */
  consumedAt?: string
  /** How the claim ended, for diagnostics. */
  outcome?: string
}

/** A single tracked file inside a baseline snapshot. */
export interface BaselineEntry {
  /** Absolute path the entry restores to. */
  path: string
  /** False when the file did not exist at snapshot time (restore removes it). */
  existed: boolean
  sha256: string
  size: number
  /** File name inside the snapshot's `files/` directory; absent when `existed` is false. */
  stored?: string
}

/** The manifest describing one baseline snapshot. */
export interface BaselineManifest {
  version: number
  createdAt: string
  /** What produced the snapshot, for the report. */
  source: string
  entries: BaselineEntry[]
}

/** The set of files the agent snapshots and rolls back. */
export interface TrackedFiles {
  version: number
  updatedAt: string
  files: string[]
}

/** Agent status as returned by `GET /status`. */
export interface AgentStatus {
  version: number
  agent: AgentInfo
  busy: boolean
  current?: { id: string; phase: string; startedAt: string }
  /** Instance the agent would restart by default. */
  instance?: string
  /** Every instance that has registered a launch specification. */
  instances?: { key: string; pid: number; cwd: string; startedAt: string; alive: boolean }[]
  /** PID currently tracked as the live harness, when one is known. */
  trackedPid?: number
  trackedPidAlive?: boolean
  lastGood?: { createdAt: string; source: string; files: number }
  trackedFiles: string[]
  lastReport?: RestartReport
}

/** Successful acknowledgement of `POST /restart`. */
export interface RestartAccepted {
  accepted: true
  id: string
  message: string
}

/** Failure envelope shared by every endpoint. */
export interface ApiError {
  accepted: false
  error: string
}
