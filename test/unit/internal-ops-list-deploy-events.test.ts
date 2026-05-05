/**
 * Tests for list_deploy_events internal-op (G4.1 / G4.2).
 *
 * Validates:
 * - Returns events for (enclave, tentacle), newest first.
 * - Returns empty array when no events exist.
 * - Public schema only contains {ts, deployer_email, summary, _internal_sha}.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/db/migrations.js';
import { listDeployEvents } from '../../src/dispatcher/internal-ops.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

/** Seed the required enclave_bindings FK row. */
function seedEnclave(enclaveName: string, channelId = 'C001'): void {
  db.prepare(
    `INSERT OR IGNORE INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
     VALUES (?, ?, ?)`,
  ).run(channelId, enclaveName, 'U123');
}

/** Insert N deploy rows for (enclave, tentacle) with distinct created_at values. */
function seedThreeDeploysIn(
  targetDb: Database.Database,
  enclave: string,
  tentacle: string,
  channelId = 'C001',
): void {
  targetDb
    .prepare(
      `INSERT OR IGNORE INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
     VALUES (?, ?, ?)`,
    )
    .run(channelId, enclave, 'U123');

  // Insert three deploys with increasing created_at timestamps
  const inserts = [
    { version: 1, sha: 'sha1111', created: '2026-04-01T10:00:00.000Z' },
    { version: 2, sha: 'sha2222', created: '2026-04-02T10:00:00.000Z' },
    { version: 3, sha: 'sha3333', created: '2026-04-03T10:00:00.000Z' },
  ];

  for (const row of inserts) {
    targetDb
      .prepare(
        `INSERT INTO deployments
         (enclave, tentacle, version, git_sha, git_tag, deploy_type, summary,
          deployed_by_email, triggered_by_channel, triggered_by_ts, status,
          created_at)
       VALUES (?, ?, ?, ?, '', 'manual', 'deploy summary ' || ?, ?, ?, ?, 'success', ?)`,
      )
      .run(
        enclave,
        tentacle,
        row.version,
        row.sha,
        row.version.toString(),
        'deployer@test.com',
        channelId,
        `ts${row.version}`,
        row.created,
      );
  }
}

beforeEach(() => {
  db = createDatabase(':memory:');
});

describe('list_deploy_events', () => {
  it('returns events for the given (enclave, tentacle), newest first', async () => {
    seedThreeDeploysIn(db, 'tentacular-agensys', 'ai-news-digest');

    const events = await listDeployEvents(db, {
      enclave: 'tentacular-agensys',
      tentacle: 'ai-news-digest',
    });

    expect(events).toHaveLength(3);
    expect(new Date(events[0]!.ts).getTime()).toBeGreaterThan(
      new Date(events[1]!.ts).getTime(),
    );
    expect(new Date(events[1]!.ts).getTime()).toBeGreaterThan(
      new Date(events[2]!.ts).getTime(),
    );
  });

  it('returns empty array when no events exist', async () => {
    seedEnclave('tentacular-agensys');
    const events = await listDeployEvents(db, {
      enclave: 'tentacular-agensys',
      tentacle: 'unknown',
    });
    expect(events).toEqual([]);
  });

  it('does not leak SHA or version_number in the public schema', async () => {
    seedThreeDeploysIn(db, 'e', 't', 'C002');

    const events = await listDeployEvents(db, { enclave: 'e', tentacle: 't' });
    expect(events).toHaveLength(3);

    // Public schema: only these four keys
    const keys = Object.keys(events[0]!).sort();
    expect(keys).toEqual(
      ['_internal_sha', 'deployer_email', 'summary', 'ts'].sort(),
    );

    // Confirm no leaked internal fields
    const rawKeys = Object.keys(events[0]!);
    expect(rawKeys).not.toContain('version_number');
    expect(rawKeys).not.toContain('git_tag');
    expect(rawKeys).not.toContain('git_sha');
    expect(rawKeys).not.toContain('version');
  });
});
