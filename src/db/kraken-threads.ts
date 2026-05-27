/**
 * kraken_threads helpers — track threads where the bot was @-mentioned at
 * the top level. Used by the Slack message handler to decide whether to
 * forward non-@-mention thread replies to the dispatcher.
 *
 * See SCHEMA_V4 in schema.ts for the table definition.
 */

import type Database from 'better-sqlite3';
import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'kraken-threads' });

/**
 * Record that the bot was @-mentioned at the top of (channelId, threadTs).
 * Idempotent — repeated calls with the same key are no-ops.
 */
export function recordKrakenThread(
  db: Database.Database,
  channelId: string,
  threadTs: string,
): void {
  const nowSec = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT OR IGNORE INTO kraken_threads (channel_id, thread_ts, created_at)
     VALUES (?, ?, ?)`,
  ).run(channelId, threadTs, nowSec);
}

/**
 * Return true iff (channelId, threadTs) is a Kraken-owned thread (the bot
 * was @-mentioned at the thread's top-level message).
 */
export function isKrakenThread(
  db: Database.Database,
  channelId: string,
  threadTs: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM kraken_threads WHERE channel_id=? AND thread_ts=? LIMIT 1`,
    )
    .get(channelId, threadTs) as { 1: number } | undefined;
  return row !== undefined;
}

/**
 * Delete rows older than maxAgeSeconds. Returns the number of rows deleted.
 * Intended to be called once at boot (and later from a scheduled job).
 */
export function pruneOldKrakenThreads(
  db: Database.Database,
  maxAgeSeconds: number,
): number {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
  const result = db
    .prepare(`DELETE FROM kraken_threads WHERE created_at < ?`)
    .run(cutoff);
  if (result.changes > 0) {
    log.info(
      { pruned: result.changes, maxAgeSeconds },
      'kraken_threads: pruned stale rows',
    );
  }
  return result.changes;
}
