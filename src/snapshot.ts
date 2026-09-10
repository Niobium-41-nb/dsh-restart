/**
 * Configuration baseline snapshots: the "last known good" copy of every
 * tracked configuration file, and the restore path that puts it back.
 *
 * Two writers share this module:
 * - the host plugin takes a baseline on every *successful* boot (`appReady`),
 *   which is what makes a bad edit recoverable — the baseline predates it;
 * - the agent restores that baseline when a restart fails to come up.
 *
 * The snapshot is deliberately file-oriented rather than tree-oriented: an
 * agent editing a profile touches a handful of files, and copying whole
 * directories would drag `node_modules` along.
 * @module dsh-restart/snapshot
 */

import { join } from 'node:path'
import type { BaselineEntry, BaselineManifest } from './protocol.ts'
import { STATE_VERSION } from './protocol.ts'
import {
  copyFileInto, ensureDir, isDirectory, isFile, listDir, nowIso, pathExists, readJson,
  removeFile, removeTree, sha256, snapshotFilesDir, storedFileName, writeJsonAtomic,
} from './fsx.ts'

/** Manifest file name inside a snapshot root. */
const MANIFEST_NAME = 'manifest.json'

/**
 * Expand the tracked path list into regular files.
 *
 * Missing files stay in the list: "this file did not exist" is itself state a
 * rollback has to restore, so it must be recorded rather than skipped.
 * @param tracked - absolute file or directory paths.
 * @param limits - traversal guard rails for directory entries.
 * @returns absolute file paths, de-duplicated and order-stable.
 */
export function expandTrackedPaths(
  tracked: readonly string[],
  limits: { maxDirectoryFiles?: number } = {},
): string[] {
  const maxFiles = limits.maxDirectoryFiles ?? 64
  const files: string[] = []
  const seen = new Set<string>()
  const push = (path: string): void => {
    if (seen.has(path) || files.length >= maxFiles) return
    seen.add(path)
    files.push(path)
  }
  for (const entry of tracked) {
    if (isDirectory(entry)) {
      const names = listDir(entry).filter(name => name !== 'node_modules' && name !== '.git').sort()
      for (const name of names) {
        const child = join(entry, name)
        if (isDirectory(child)) {
          for (const nested of listDir(child).filter(n => n !== 'node_modules' && n !== '.git').sort()) {
            push(join(child, nested))
          }
        } else {
          push(child)
        }
      }
      continue
    }
    push(entry)
  }
  return files
}

/**
 * Snapshot tracked files into a baseline root.
 *
 * The destination is rebuilt from scratch: a stale snapshot that mixes two
 * generations would restore a configuration that never existed.
 * @param files - absolute file paths (see {@link expandTrackedPaths}).
 * @param destination - baseline root directory to (re)create.
 * @param source - human label recorded in the manifest.
 * @returns the written manifest.
 */
export function takeBaseline(files: readonly string[], destination: string, source: string): BaselineManifest {
  removeTree(destination)
  ensureDir(snapshotFilesDir(destination))
  const entries: BaselineEntry[] = []
  files.forEach((path, index) => {
    if (isFile(path)) {
      const stored = storedFileName(index, path)
      copyFileInto(path, join(snapshotFilesDir(destination), stored))
      entries.push({
        path,
        existed: true,
        sha256: sha256(path),
        size: 0,
        stored,
      })
      return
    }
    entries.push({ path, existed: false, sha256: '', size: 0 })
  })
  const manifest: BaselineManifest = {
    version: STATE_VERSION,
    createdAt: nowIso(),
    source,
    entries,
  }
  writeJsonAtomic(join(destination, MANIFEST_NAME), manifest)
  return manifest
}

/**
 * Read a baseline manifest from a snapshot root.
 * @param baselineDir - snapshot root directory.
 * @returns the manifest, or `undefined` when absent or unreadable.
 */
export function readBaselineManifest(baselineDir: string): BaselineManifest | undefined {
  return readJson<BaselineManifest>(join(baselineDir, MANIFEST_NAME))
}

/** Which tracked files differ from a baseline. */
export interface BaselineDiff {
  /** Files whose contents changed since the snapshot. */
  changed: string[]
  /** Files that appeared after the snapshot. */
  added: string[]
  /** Files that existed at snapshot time and are now gone. */
  removed: string[]
}

/**
 * Compare the live configuration against a baseline without writing anything.
 * @param manifest - the manifest to compare with.
 * @returns the changed/added/removed path lists.
 */
export function diffBaseline(manifest: BaselineManifest): BaselineDiff {
  const changed: string[] = []
  const added: string[] = []
  const removed: string[] = []
  for (const entry of manifest.entries) {
    const present = isFile(entry.path)
    if (entry.existed && !present) {
      removed.push(entry.path)
      continue
    }
    if (!entry.existed) {
      if (present) added.push(entry.path)
      continue
    }
    if (present && sha256(entry.path) !== entry.sha256) changed.push(entry.path)
  }
  return { changed, added, removed }
}

/** Outcome of restoring one baseline. */
export interface RestoreOutcome {
  restored: string[]
  removed: string[]
  failures: { path: string; error: string }[]
}

/**
 * Put a baseline back on disk: every recorded file returns to its snapshotted
 * bytes, and every file that did not exist then is deleted.
 * @param baselineDir - snapshot root directory.
 * @param manifest - the manifest to restore.
 * @returns which paths were restored, removed, or failed.
 */
export function restoreBaseline(baselineDir: string, manifest: BaselineManifest): RestoreOutcome {
  const outcome: RestoreOutcome = { restored: [], removed: [], failures: [] }
  for (const entry of manifest.entries) {
    try {
      if (!entry.existed) {
        if (pathExists(entry.path)) {
          removeFile(entry.path)
          outcome.removed.push(entry.path)
        }
        continue
      }
      if (entry.stored === undefined) {
        outcome.failures.push({ path: entry.path, error: 'snapshot entry has no stored copy' })
        continue
      }
      const source = join(snapshotFilesDir(baselineDir), entry.stored)
      if (!isFile(source)) {
        outcome.failures.push({ path: entry.path, error: `snapshot copy is missing: ${source}` })
        continue
      }
      // Skip the write when the file already matches, so a rollback does not
      // touch mtimes of configuration the attempt never changed.
      if (isFile(entry.path) && sha256(entry.path) === entry.sha256) continue
      copyFileInto(source, entry.path)
      outcome.restored.push(entry.path)
    } catch (error) {
      outcome.failures.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return outcome
}
