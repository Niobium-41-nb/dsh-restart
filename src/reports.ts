/**
 * Report-file helpers shared by the plugin, the control agent, and the watchdog.
 *
 * Reports are the only durable record of what happened to a restart, and three
 * different processes write them: the agent finishes the one it started, the
 * plugin closes out one that was abandoned, and the watchdog finalizes one whose
 * agent died before it could. Keeping the reads and writes in one place is what
 * keeps those three from disagreeing about the newest record.
 * @module dsh-restart/reports
 */

import { join } from 'node:path'
import type { RestartReport } from './protocol.ts'
import { listDir, readJson, writeJsonAtomic } from './fsx.ts'
import type { StatePaths } from './paths.ts'

/**
 * Read the most recent report, regardless of delivery state.
 *
 * Ordering is by file name, which is chronological because ids are
 * `<prefix>-<timestamp>-<entropy>`.
 *
 * @param paths - state layout.
 * @returns the newest report, or `undefined` when none was ever written.
 */
export function readLatestReport(paths: StatePaths): RestartReport | undefined {
  const names = listDir(paths.reports).filter(fileName => fileName.endsWith('.json')).sort().reverse()
  const newest = names[0]
  return newest === undefined ? undefined : readJson<RestartReport>(join(paths.reports, newest))
}

/**
 * Rewrite one report in place, preserving everything the caller does not patch.
 *
 * `deliveredAt` is deliberately part of the record rather than of the patch: a
 * report that was already surfaced keeps that mark, so finishing it later never
 * re-delivers it to the model.
 *
 * @param paths - state layout.
 * @param report - the record to rewrite.
 * @param patch - fields to replace.
 * @returns the written report.
 */
export function rewriteReport(
  paths: StatePaths,
  report: RestartReport,
  patch: Partial<RestartReport>,
): RestartReport {
  const updated: RestartReport = { ...report, ...patch }
  writeJsonAtomic(join(paths.reports, `${updated.id}.json`), updated)
  return updated
}
