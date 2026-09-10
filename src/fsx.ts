/**
 * Small synchronous filesystem helpers shared by the plugin and the agent.
 *
 * Everything here is intentionally dependency-free and synchronous: the files
 * involved are a handful of kilobytes of configuration, and a rollback has to
 * complete deterministically while processes are dying.
 * @module dsh-restart/fsx
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Create a directory (and its parents) when missing. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/** Whether a path exists (files and directories alike). */
export function pathExists(path: string): boolean {
  return existsSync(path)
}

/** Whether a path exists and is a regular file. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Whether a path exists and is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Read and parse a JSON file.
 * @param path - file to read.
 * @returns the parsed value, or `undefined` when the file is missing or invalid.
 */
export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/**
 * Write a file through a temporary sibling followed by a rename, so a reader
 * never observes a half-written document.
 * @param path - destination path.
 * @param contents - full file contents.
 * @param mode - permission bits applied to the temporary file.
 */
export function writeTextAtomic(path: string, contents: string, mode = 0o600): void {
  ensureDir(dirname(path))
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  writeFileSync(temporary, contents, { mode })
  try {
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The rename failure is the outcome that matters.
    }
    throw error
  }
}

/**
 * Serialize a value and write it atomically.
 * @param path - destination path.
 * @param value - JSON-serializable value.
 * @param mode - permission bits applied to the temporary file.
 */
export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode)
}

/** Remove a file when present; never throws. */
export function removeFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Absence is the desired end state.
  }
}

/** Remove a directory tree when present; never throws. */
export function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Absence is the desired end state.
  }
}

/**
 * Hash file contents or an in-memory buffer with SHA-256.
 * @param input - file path or raw bytes.
 * @returns the lowercase hex digest.
 */
export function sha256(input: string | Buffer): string {
  const hash = createHash('sha256')
  hash.update(typeof input === 'string' ? readFileSync(input) : input)
  return hash.digest('hex')
}

/**
 * Read the tail of a file without loading the whole thing.
 * @param path - file to read.
 * @param maxChars - maximum number of trailing characters to return.
 * @returns the tail, or an empty string when the file is unreadable.
 */
export function readTail(path: string, maxChars: number): string {
  let handle: number | undefined
  try {
    const size = statSync(path).size
    const length = Math.min(size, Math.max(maxChars * 4, maxChars))
    const start = Math.max(0, size - length)
    const buffer = Buffer.alloc(length)
    handle = openSync(path, 'r')
    const read = readSync(handle, buffer, 0, length, start)
    return buffer.subarray(0, read).toString('utf8').slice(-maxChars)
  } catch {
    return ''
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle)
      } catch {
        // Nothing left to release.
      }
    }
  }
}

/**
 * List one directory's entry names.
 * @param path - directory to list.
 * @returns entry names, or an empty list when the directory is missing.
 */
export function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** Copy a file, creating the destination's parent directory first. */
export function copyFileInto(source: string, destination: string): void {
  ensureDir(dirname(destination))
  copyFileSync(source, destination)
}

/** ISO timestamp for "now". */
export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Filesystem-safe identifier derived from the current time plus entropy.
 * @param prefix - leading label (`restart`, `attempt`, …).
 * @returns an identifier usable as a directory or file name.
 */
export function makeId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `${prefix}-${stamp}-${randomBytes(3).toString('hex')}`
}

/** Await a delay. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Join a `files/` storage name for one snapshot index. */
export function storedFileName(index: number, sourcePath: string): string {
  return `${String(index).padStart(3, '0')}__${basename(sourcePath)}`
}

/** The `files/` directory of a snapshot root. */
export function snapshotFilesDir(root: string): string {
  return join(root, 'files')
}
