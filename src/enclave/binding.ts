/**
 * Enclave binding engine — channel-to-enclave lookup (read-only in Phase 1).
 *
 * Maps Slack channel IDs to enclave names using the enclave_bindings SQLite
 * table populated by the admin provisioning flow (Phase 3).
 *
 * Phase 1: read-only. Enclave binding mutations are deferred to Phase 3.
 * Phase 2: adds isValidEnclaveName validation (F2 followup).
 */

import type Database from 'better-sqlite3';
import { createChildLogger } from '../logger.js';
import type { EnclaveBinding } from '../types.js';

export type { EnclaveBinding };

// ---------------------------------------------------------------------------
// Enclave name validation (F2 — T08)
// ---------------------------------------------------------------------------

/**
 * Validate an enclave name against the allowed pattern.
 *
 * Rules:
 *   - Lowercase letters and digits only, plus hyphens
 *   - Must start with a letter or digit (not a hyphen)
 *   - 1 to 63 characters total
 *   - No consecutive hyphens, no trailing hyphens (enforced by DNS compat)
 *
 * Regex: /^[a-z0-9][a-z0-9-]{0,62}$/
 * This mirrors Kubernetes namespace naming rules.
 */
export function isValidEnclaveName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(name);
}

const log = createChildLogger({ module: 'enclave-binding' });

/**
 * Enclave binding engine. Wraps the SQLite enclave_bindings table.
 *
 * Instantiate once and reuse across requests — the prepared statements are
 * cached by better-sqlite3 internally.
 */
export class EnclaveBindingEngine {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Look up the enclave binding for a Slack channel.
   *
   * @param channelId - Slack channel ID (e.g. "C012ABC").
   * @returns The active binding, or null if the channel is not bound.
   */
  lookupEnclave(channelId: string): EnclaveBinding | null {
    const row = this.db
      .prepare(
        `SELECT channel_id, enclave_name, owner_slack_id, status, created_at
         FROM enclave_bindings
         WHERE channel_id = ? AND status = 'active'`,
      )
      .get(channelId) as
      | {
          channel_id: string;
          enclave_name: string;
          owner_slack_id: string;
          status: string;
          created_at: string;
        }
      | undefined;

    if (!row) {
      log.debug({ channelId }, 'no active enclave binding');
      return null;
    }

    return {
      channelId: row.channel_id,
      enclaveName: row.enclave_name,
      ownerSlackId: row.owner_slack_id,
      status: 'active',
      createdAt: row.created_at,
    };
  }

  /**
   * Count active enclave bindings.
   * Used for the startup banner.
   */
  count(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as n FROM enclave_bindings WHERE status = 'active'`,
      )
      .get() as { n: number };
    return row.n;
  }
}
