/**
 * The one place that decides what a recorded launch has to be started as again.
 *
 * The control agent and the resurrection watchdog both reach the same
 * conclusion from the same record, and they have to reach it the same way: a
 * watchdog that relaunches a desktop Host's private command line would start a
 * harness no window is attached to, and the incident it exists to fix would
 * become the incident.
 * @module dsh-restart/relaunch
 */

import { homedir } from 'node:os'
import type { LaunchSpec } from './protocol.ts'

/**
 * The environment variable that makes the desktop executable behave as a plain
 * Node interpreter instead of as the application.
 *
 * A Host always carries it, because the application starts it in Node mode.
 * Handing that copy back to the executable is how a restart ends up with no
 * window and exit code 9, so a desktop relaunch drops it.
 */
export const DESKTOP_NODE_MODE_ENV = 'ELECTRON_RUN_AS_NODE'

/** Whether this record describes a harness hosted by the desktop application. */
export function isDesktopLaunch(launch: Pick<LaunchSpec, 'surface'>): boolean {
  return launch.surface === 'desktop'
}

/** The entry point the desktop application spawns its harness Host with. */
const DESKTOP_HOST_ENTRY = /@deepseek-ai[/\\]dsh-desktop-host[/\\]lib[/\\]index\.js$/

/** Whether a command line names the desktop application's Host entry. */
export function isDesktopHostEntry(entry: string | undefined): boolean {
  return entry !== undefined && DESKTOP_HOST_ENTRY.test(entry)
}

/**
 * Whether a record describes a desktop Host, whether or not it says so.
 *
 * `surface` is what a 0.2.0 plugin writes; a record from an older plugin says
 * nothing, and its command line is still the application's private protocol.
 * The entry point alone settles it -- no launcher other than the application
 * starts that file -- because replaying it boots a harness no window is
 * attached to.
 */
export function desktopShapedRecord(launch: Pick<LaunchSpec, 'surface' | 'argv'>): boolean {
  if (launch.surface !== undefined) return launch.surface === 'desktop'
  return isDesktopHostEntry(launch.argv[0])
}

/** What to spawn, and from where, to bring this launch back. */
export interface RelaunchTarget {
  execPath: string
  invocation: string[]
  cwd: string
  /** Whether the thing being started is a window-owning application. */
  desktop: boolean
}

/**
 * The desktop relaunch target: the application itself, bare.
 *
 * The Host's command line is the application's private protocol -- a runtime
 * directory, a profile directory, a package-manager path -- and none of it is a
 * program a supervisor should start on its own terms. The window, the port and
 * the single-instance lock all belong to the application, so the application is
 * what gets launched, with no arguments, from the home directory a launcher
 * would have used.
 *
 * @param launch - the recorded specification.
 * @returns the executable, its (empty) arguments, and the working directory.
 */
export function desktopRelaunchTarget(launch: LaunchSpec): RelaunchTarget {
  return { execPath: launch.execPath, invocation: [], cwd: homedir(), desktop: true }
}

/**
 * Strip the Node-mode marker from an environment the application is about to
 * receive.
 * @param environment - the captured or inherited environment.
 * @returns a copy without {@link DESKTOP_NODE_MODE_ENV}.
 */
export function withoutNodeModeEnv(environment: Record<string, string>): Record<string, string> {
  const { [DESKTOP_NODE_MODE_ENV]: _dropped, ...rest } = environment
  return rest
}
