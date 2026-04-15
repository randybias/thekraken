/**
 * Enclave binding engine — channel-to-enclave lookup.
 *
 * Maps Slack channel IDs to enclave names using the enclave_bindings SQLite
 * table populated by the admin provisioning flow.
 *
 * Mutations are handled by the provisioning and commands modules, and by
 * the lazy reconstitution path (first mention in a channel after PVC reset).
 */

import type Database from 'better-sqlite3';
import { createChildLogger } from '../logger.js';
import type { EnclaveBinding } from '../types.js';

export type { EnclaveBinding };

const log = createChildLogger({ module: 'enclave-binding' });

/** Shape of a single item returned by enclave_list. */
interface EnclaveListItem {
  name: string;
  owner: string;
  status: string;
  platform?: string;
  channel_name?: string;
  created_at?: string;
  members: string[];
}

/** Shape of the enclave_list MCP response. */
interface EnclaveListResult {
  enclaves: EnclaveListItem[];
}

/** Shape of the enclave_info MCP response (fields relevant to reconstitution). */
interface EnclaveInfoResult {
  name: string;
  owner: string;
  owner_sub?: string;
  channel_id?: string;
  channel_name?: string;
  status: string;
  platform?: string;
}

/** Dependency injected MCP call function, same signature as in bot.ts. */
type McpCall = (
  tool: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

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
   * Look up the binding by enclave name (not channel ID).
   * Used by drift sync to fetch the owner for a named enclave.
   */
  lookupByEnclaveName(enclaveName: string): EnclaveBinding | null {
    const row = this.db
      .prepare(
        `SELECT channel_id, enclave_name, owner_slack_id, status, created_at
         FROM enclave_bindings
         WHERE enclave_name = ? AND status = 'active'`,
      )
      .get(enclaveName) as
      | {
          channel_id: string;
          enclave_name: string;
          owner_slack_id: string;
          status: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      channelId: row.channel_id,
      enclaveName: row.enclave_name,
      ownerSlackId: row.owner_slack_id,
      status: 'active',
      createdAt: row.created_at,
    };
  }

  /**
   * Insert a new active enclave binding row.
   *
   * Uses INSERT OR IGNORE so concurrent reconstitutions for the same channel
   * are safe — only the first one wins, subsequent calls are no-ops.
   *
   * @param channelId   - Slack channel ID.
   * @param enclaveName - Kubernetes namespace / enclave name.
   * @param ownerSlackId - Slack user ID of the user who triggered reconstitution.
   */
  insertBinding(
    channelId: string,
    enclaveName: string,
    ownerSlackId: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO enclave_bindings
           (channel_id, enclave_name, owner_slack_id, status)
         VALUES (?, ?, ?, 'active')`,
      )
      .run(channelId, enclaveName, ownerSlackId);

    log.info(
      { channelId, enclaveName, ownerSlackId },
      'enclave binding reconstituted',
    );
  }

  /**
   * Look up a binding, falling back to lazy MCP reconstitution if none exists.
   *
   * Called on every app_mention after the auth gate. The three-step flow:
   *   1. SQLite cache hit → return immediately (common case).
   *   2. Cache miss → call enclave_list, then enclave_info for each to find
   *      the one whose channel_id matches. Insert a binding row and return.
   *   3. MCP returns nothing for this channel → return null (unbound channel).
   *
   * MCP errors are caught and logged; the function returns null so the caller
   * can handle an unbound channel gracefully without crashing.
   *
   * @param channelId   - Slack channel ID being looked up.
   * @param ownerSlackId - Slack user ID of the authenticated user triggering reconstitution.
   * @param mcpCall     - Authenticated MCP call function (uses the user's OIDC token).
   */
  async lookupEnclaveWithReconstitute(
    channelId: string,
    ownerSlackId: string,
    mcpCall: McpCall,
  ): Promise<EnclaveBinding | null> {
    // Fast path: binding already in the local cache.
    const cached = this.lookupEnclave(channelId);
    if (cached !== null) return cached;

    log.info(
      { channelId },
      'no binding in cache — attempting lazy reconstitution via MCP',
    );

    try {
      // List all enclaves accessible to this user.
      const listResult = (await mcpCall(
        'enclave_list',
        {},
      )) as EnclaveListResult;

      const enclaves = listResult?.enclaves ?? [];
      if (enclaves.length === 0) {
        log.debug(
          { channelId },
          'enclave_list returned empty — unbound channel',
        );
        return null;
      }

      // For each enclave, call enclave_info to get channel_id (not in list result).
      for (const item of enclaves) {
        let info: EnclaveInfoResult;
        try {
          info = (await mcpCall('enclave_info', {
            name: item.name,
          })) as EnclaveInfoResult;
        } catch (infoErr) {
          log.warn(
            { err: infoErr, enclave: item.name },
            'enclave_info failed during reconstitution — skipping',
          );
          continue;
        }

        if (info?.channel_id === channelId) {
          // Found the matching enclave — insert a binding row.
          this.insertBinding(channelId, info.name, ownerSlackId);
          return {
            channelId,
            enclaveName: info.name,
            ownerSlackId,
            status: 'active',
            createdAt: new Date().toISOString(),
          };
        }
      }

      log.debug(
        { channelId, checked: enclaves.length },
        'no enclave matched channel_id — unbound channel',
      );
      return null;
    } catch (err) {
      log.warn(
        { err, channelId },
        'lazy reconstitution MCP call failed — treating as unbound',
      );
      return null;
    }
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
