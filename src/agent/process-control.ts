/**
 * Process control and liveness probing for the restart agent.
 *
 * The agent never owns the harness as a child: the harness starts the agent,
 * so stopping it means "ask it to exit, wait, then terminate". The waiting
 * matters on Windows, where node emulates `SIGTERM` with `TerminateProcess`
 * and a cooperative `ctx.appExit` is the only path that flushes session logs.
 * @module dsh-restart/agent/process-control
 */

import { spawnSync } from 'node:child_process'
import { sleep } from '../fsx.ts'

/**
 * Whether a PID currently exists.
 * @param pid - process id to test.
 * @returns true when the process exists (including when owned by another user).
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Terminate a process unconditionally.
 *
 * On Windows the harness's process tree is taken down with it — sandbox
 * helpers and build children included — but ONLY when this agent is provably
 * outside that tree. `taskkill /T` walks parent links, so an agent spawned
 * directly by the harness would kill itself halfway through a rollback; the
 * two-stage spawn in `agent-client.ts` normally prevents that, and this guard
 * keeps the failure mode impossible even if the agent was started by hand
 * from inside the target's tree.
 * @param pid - process id to kill.
 * @param log - diagnostic sink.
 */
export function forceKill(pid: number, log: (line: string) => void): void {
  try {
    if (process.platform === 'win32') {
      const insideTargetTree = process.ppid === pid
      if (insideTargetTree) {
        log(`pid ${pid} is this agent's own parent; killing it without /T so the rollback survives`)
      }
      const args = ['/PID', String(pid), '/F']
      if (!insideTargetTree) args.splice(2, 0, '/T')
      const result = spawnSync('taskkill', args, { windowsHide: true })
      if (result.error !== undefined) log(`taskkill ${pid} failed: ${result.error.message}`)
      return
    }
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    log(`failed to kill ${pid}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Result of waiting for a process to disappear. */
export interface StopOutcome {
  stopped: boolean
  forced: boolean
}

/**
 * Wait for a process to exit on its own, then force it.
 *
 * No signal is sent during the grace window: the plugin asks the launcher for
 * a bounded shutdown (`ctx.appExit`) before the agent is called, and that
 * cooperative path must get the chance to drain the tree first.
 * @param pid - process to stop.
 * @param graceMs - how long to wait for the cooperative exit.
 * @param log - diagnostic sink.
 * @returns whether the process is gone, and whether force was required.
 */
export async function stopProcess(pid: number, graceMs: number, log: (line: string) => void): Promise<StopOutcome> {
  if (!isAlive(pid)) return { stopped: true, forced: false }
  const graceDeadline = Date.now() + Math.max(0, graceMs)
  while (Date.now() < graceDeadline) {
    if (!isAlive(pid)) return { stopped: true, forced: false }
    await sleep(120)
  }
  log(`pid ${pid} is still running after ${graceMs} ms; forcing termination`)
  forceKill(pid, log)
  const forceDeadline = Date.now() + 5_000
  while (Date.now() < forceDeadline) {
    if (!isAlive(pid)) return { stopped: true, forced: true }
    await sleep(120)
  }
  return { stopped: !isAlive(pid), forced: true }
}

/**
 * Probe an HTTP endpoint for any answer at all.
 *
 * "The socket accepted and a response came back" is the signal — a 404 or a
 * login redirect still proves the server bound its port, and the frontend
 * route set is not this plugin's business.
 * @param url - absolute URL to request.
 * @param timeoutMs - per-probe timeout.
 * @returns true when a response arrived before the timeout.
 */
export async function probeHttp(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    await response.body?.cancel()
    return true
  } catch {
    return false
  }
}
