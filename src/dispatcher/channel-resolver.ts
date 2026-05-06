/**
 * Channel-name resolution for smart-path and other in-process consumers.
 *
 * Reads the active enclave binding for a Slack channel directly from the
 * kraken.db file. In-process only — subprocess agents use the kraken-db
 * CLI for the same lookup.
 *
 * Spec: docs/superpowers/specs/2026-05-06-rc11-token-and-session-state-design.md
 */
import type Database from 'better-sqlite3';

export interface ResolvedChannel {
  channelId: string;
  enclaveName: string;
  ownerSlackId: string;
}

/**
 * Look up the active enclave binding for a Slack channel ID.
 *
 * Returns null if there is no binding or the binding's status is not
 * 'active'. Status filter ensures we don't surface decommissioned
 * channels as still-named-after-an-enclave.
 */
export function resolveChannel(
  db: Database.Database,
  channelId: string,
): ResolvedChannel | null {
  const row = db
    .prepare(
      `SELECT channel_id, enclave_name, owner_slack_id
       FROM enclave_bindings
       WHERE channel_id = ? AND status = 'active'`,
    )
    .get(channelId) as
    | { channel_id: string; enclave_name: string; owner_slack_id: string }
    | undefined;
  if (!row) return null;
  return {
    channelId: row.channel_id,
    enclaveName: row.enclave_name,
    ownerSlackId: row.owner_slack_id,
  };
}
