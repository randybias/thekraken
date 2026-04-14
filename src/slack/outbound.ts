/**
 * Outbound message tracking for The Kraken v2.
 *
 * Persists every Slack message The Kraken sends to the outbound_messages
 * SQLite table. On startup, hasOutboundInThread() prevents re-sending
 * duplicate messages after a pod restart.
 *
 * Content hashing uses SHA-256 (Node.js built-in crypto). The hash is
 * stored for dedup, not for retrieval — it is safe to store.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'outbound-tracker' });

/**
 * Outbound message tracking class. Wraps the outbound_messages SQLite table.
 */
export class OutboundTracker {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Record an outbound Slack message.
   *
   * @param channelId - Slack channel ID.
   * @param threadTs - Thread timestamp (root message ts for the thread).
   * @param messageTs - The ts of the message we sent (from Slack API response).
   * @param content - The text content we sent (used to compute content_hash).
   */
  store(
    channelId: string,
    threadTs: string,
    messageTs: string,
    content: string,
  ): void {
    const contentHash = hashContent(content);

    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO outbound_messages
             (channel_id, thread_ts, message_ts, content_hash)
           VALUES (?, ?, ?, ?)`,
        )
        .run(channelId, threadTs, messageTs, contentHash);

      log.debug(
        { channelId, threadTs, messageTs },
        'outbound message recorded',
      );
    } catch (err) {
      // Non-fatal — if recording fails, continue; dedup is best-effort.
      log.warn(
        { err, channelId, threadTs },
        'failed to record outbound message',
      );
    }
  }

  /**
   * Check if The Kraken has already sent any message in this thread.
   *
   * Used after a pod restart to avoid re-sending messages when processing
   * a thread that was already responded to.
   *
   * @param channelId - Slack channel ID.
   * @param threadTs - Thread timestamp (root message ts).
   * @returns True if at least one outbound message exists for this thread.
   */
  hasOutboundInThread(channelId: string, threadTs: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM outbound_messages
         WHERE channel_id = ? AND thread_ts = ?
         LIMIT 1`,
      )
      .get(channelId, threadTs);

    return row !== undefined;
  }

  /**
   * Check if a specific outbound record (by content hash) was already sent.
   *
   * Per-record dedup: prevents re-sending the exact same message after a pod
   * restart, while allowing multiple different messages in the same thread.
   * Fixes the thread-level dedup bug caught by Codex review (item 1).
   *
   * @param contentHash - SHA-256 hash of the message content.
   * @returns True if this exact content was already posted.
   */
  hasOutboundByHash(contentHash: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM outbound_messages
         WHERE content_hash = ?
         LIMIT 1`,
      )
      .get(contentHash);

    return row !== undefined;
  }
}

/**
 * Compute SHA-256 hash of content for dedup storage.
 * Content is hashed before storage — never stored in plaintext.
 */
function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
