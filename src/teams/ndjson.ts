/**
 * NDJSON protocol layer for team IPC.
 *
 * Provides append-only NDJSON write and byte-offset-tracking read utilities
 * for the three team protocol files:
 *   - mailbox.ndjson   (dispatcher -> manager)
 *   - outbound.ndjson  (manager -> dispatcher)
 *   - signals.ndjson   (builder/deployer -> manager)
 *
 * Design constraints (Section 4.5 of phase1 design):
 * - All files are append-only. Writers append complete lines atomically.
 * - Readers track byte offset in memory; no file locking needed.
 * - Records with invalid JSON are logged and skipped (corruption recovery).
 * - Partial lines at EOF are buffered and emitted on the next read call.
 */

import { appendFileSync, closeSync, openSync, readSync, statSync } from 'node:fs';
import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'ndjson' });

/**
 * Append a JSON record as a single newline-terminated line to an NDJSON file.
 *
 * Uses appendFileSync which issues a single atomic write syscall. For records
 * under the OS pipe-buffer size (~4 KB on Linux), this is atomic even under
 * concurrent writers.
 *
 * @param path - Absolute path to the NDJSON file. Created if it does not exist.
 * @param record - Any JSON-serializable object.
 */
export function appendNdjson(path: string, record: object): void {
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Stateful byte-offset reader for an NDJSON file.
 *
 * Tracks the read position across multiple calls to readNew(). Only lines
 * appended since the last read are returned. Handles:
 * - Missing file (returns [] — file may not exist yet)
 * - Partial lines at EOF (buffered until the line is complete)
 * - Invalid JSON lines (logged and skipped)
 * - Multiple concurrent writers (safe: reads new bytes, advances offset)
 */
export class NdjsonReader {
  private offset = 0;
  /** Accumulated partial line from the last read (no trailing \n yet). */
  private buffer = '';

  constructor(private readonly path: string) {}

  /**
   * Return all complete JSON records appended since the last read.
   *
   * Advances the internal offset so subsequent calls only return new records.
   * Returns an empty array if the file does not exist or has no new data.
   */
  readNew(): object[] {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      // File does not exist yet — normal at startup.
      return [];
    }

    try {
      let size: number;
      try {
        size = statSync(this.path).size;
      } catch {
        return [];
      }

      if (size <= this.offset) return [];

      const toRead = size - this.offset;
      const buf = Buffer.alloc(toRead);
      readSync(fd, buf, 0, toRead, this.offset);
      this.offset = size;

      const text = this.buffer + buf.toString('utf8');
      const lines = text.split('\n');

      // The last element is either empty (complete last line) or a partial line.
      this.buffer = lines.pop() ?? '';

      const records: object[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed) as object);
        } catch {
          log.warn({ line: trimmed.slice(0, 80) }, 'ndjson: skipping invalid JSON line');
        }
      }
      return records;
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Reset the reader to the beginning of the file.
   *
   * Useful after a process restart that wants to replay all records from the
   * start (e.g. testing, or crash recovery in later phases).
   */
  reset(): void {
    this.offset = 0;
    this.buffer = '';
  }

  /** Current byte offset (exposed for testing). */
  get currentOffset(): number {
    return this.offset;
  }
}
