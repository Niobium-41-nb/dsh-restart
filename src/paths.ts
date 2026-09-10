/**
 * Path resolution for the restart supervisor's state directory.
 *
 * Resolution mirrors the harness's own `$DSH_HOME` rules closely enough to
 * share one directory between the plugin and the standalone agent, without
 * importing `@deepseek-ai/dsh-home-paths` (see `protocol.ts` for why).
 * @module dsh-restart/paths
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ENV_STATE_DIR } from './protocol.ts'

/** Expand a leading `~` the way the harness's own path helpers do. */
export function expandHomePath(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2))
  return input
}

/**
 * Resolve the DeepSeek Harness home.
 * @param env - environment to read (`DSH_HOME` wins when non-empty).
 * @returns the absolute harness home path.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolve(expandHomePath(fromEnv))
  return join(homedir(), '.dsh')
}

/**
 * Resolve the directory holding every restart artifact (state, baselines,
 * attempt logs, reports).
 * @param env - environment to read (`DSH_RESTART_STATE_DIR` wins when non-empty).
 * @returns the absolute state directory path.
 */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env[ENV_STATE_DIR]
  if (custom !== undefined && custom.trim().length > 0) return resolve(expandHomePath(custom))
  return join(resolveDshHome(env), 'dsh-restart')
}

/** Every path inside the state directory, derived from one root. */
export interface StatePaths {
  root: string
  agentInfo: string
  token: string
  reports: string
  logs: string
  /** Directory holding one subdirectory per harness instance. */
  instances: string
}

/**
 * Per-instance paths.
 *
 * The control agent is a machine-level singleton (one port, one supervisor),
 * but every harness surface that mounts the plugin keeps its own launch
 * specification, tracked-file list, and rollback baseline. Two profiles can
 * therefore run at once — a Web GUI and a TUI, say — without one instance's
 * restart relaunching the other's command line or rolling back the other's
 * configuration.
 */
export interface InstancePaths {
  /** Stable key derived from the instance's profile directory. */
  key: string
  dir: string
  launchSpec: string
  trackedFiles: string
  lastGood: string
}

/**
 * Derive the state layout from a state directory.
 * @param root - the state directory (see {@link resolveStateDir}).
 * @returns the shared files and directories the plugin and agent use.
 */
export function statePaths(root: string): StatePaths {
  return {
    root,
    agentInfo: join(root, 'agent.json'),
    token: join(root, 'token'),
    reports: join(root, 'reports'),
    logs: join(root, 'logs'),
    instances: join(root, 'instances'),
  }
}

/**
 * Resolve one instance's storage.
 * @param root - the state directory.
 * @param key - instance key (see {@link instanceKey}).
 * @returns the instance's directories and files.
 */
export function instancePaths(root: string, key: string): InstancePaths {
  const dir = join(root, 'instances', key)
  return {
    key,
    dir,
    launchSpec: join(dir, 'launch.json'),
    trackedFiles: join(dir, 'tracked-files.json'),
    lastGood: join(dir, 'last-good'),
  }
}

/**
 * Derive an instance key from a profile directory.
 * @param profileDir - absolute profile directory, when known.
 * @returns a short stable key that is safe as a directory name.
 */
export function instanceKey(profileDir: string | undefined): string {
  if (profileDir === undefined || profileDir.length === 0) return 'default'
  const normalized = process.platform === 'win32' ? resolve(profileDir).toLowerCase() : resolve(profileDir)
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12)
}
