/**
 * Startup with existing SQLite database tests.
 *
 * Verifies that starting up with a database that already has data from a
 * previous run works correctly — all persisted data survives the restart.
 *
 * This tests the restart resilience of SQLite PVC-backed storage (D7).
 * The pod restarts, the PVC is re-mounted, and createDatabase() reopens
 * the same file. All previously written rows must still be readable.
 *
 * Coverage:
 * - user_tokens survive restart (OIDC tokens persisted)
 * - enclave_bindings survive restart (channel → enclave mapping persisted)
 * - outbound_messages dedup table is preserved (avoids re-posting on restart)
 * - Schema is idempotent (CREATE TABLE IF NOT EXISTS doesn't wipe data)
 * - PRAGMA foreign_keys = ON is re-enforced after restart
 * - Multiple bindings and multiple tokens all survive
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from '../../src/db/migrations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Temp dirs created during this test run — cleaned up in afterEach. */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kraken-restart-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startup with existing database', () => {
  it('user_tokens survive restart', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'kraken.db');

    // === First startup: write a user token ===
    {
      const db = createDatabase(dbPath);
      db.prepare(
        `INSERT INTO user_tokens (slack_user_id, access_token, refresh_token, expires_at, keycloak_sub, email)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        'U_ALICE',
        'at-alice-1',
        'rt-alice-1',
        '2026-12-31T00:00:00.000Z',
        'sub-alice',
        'alice@example.com',
      );
      db.close();
    }

    // === Second startup: open existing DB ===
    {
      const db = createDatabase(dbPath);
      const row = db
        .prepare(`SELECT * FROM user_tokens WHERE slack_user_id = ?`)
        .get('U_ALICE') as {
        access_token: string;
        refresh_token: string;
        email: string;
        keycloak_sub: string;
      };

      expect(row).toBeTruthy();
      expect(row.access_token).toBe('at-alice-1');
      expect(row.refresh_token).toBe('rt-alice-1');
      expect(row.email).toBe('alice@example.com');
      expect(row.keycloak_sub).toBe('sub-alice');
      db.close();
    }
  });

  it('multiple user_tokens survive restart', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'kraken.db');

    {
      const db = createDatabase(dbPath);
      db.prepare(
        `INSERT INTO user_tokens (slack_user_id, access_token, refresh_token, expires_at, keycloak_sub, email)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        'U_ALICE',
        'at-alice',
        'rt-alice',
        '2026-12-31T00:00:00.000Z',
        'sub-alice',
        'alice@example.com',
      );
      db.prepare(
        `INSERT INTO user_tokens (slack_user_id, access_token, refresh_token, expires_at, keycloak_sub, email)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        'U_BOB',
        'at-bob',
        'rt-bob',
        '2026-12-31T00:00:00.000Z',
        'sub-bob',
        'bob@example.com',
      );
      db.close();
    }

    {
      const db = createDatabase(dbPath);
      const rows = db
        .prepare(`SELECT slack_user_id FROM user_tokens ORDER BY slack_user_id`)
        .all() as Array<{ slack_user_id: string }>;

      expect(rows).toHaveLength(2);
      expect(rows[0]!.slack_user_id).toBe('U_ALICE');
      expect(rows[1]!.slack_user_id).toBe('U_BOB');
      db.close();
    }
  });

  it('enclave_bindings survive restart', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'kraken.db');

    {
      const db = createDatabase(dbPath);
      db.prepare(
        `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
         VALUES (?, ?, ?)`,
      ).run('C_MARKETING', 'marketing', 'U_ALICE');
      db.prepare(
        `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
         VALUES (?, ?, ?)`,
      ).run('C_ENGINEERING', 'engineering', 'U_BOB');
      db.close();
    }

    {
      const db = createDatabase(dbPath);
      const rows = db
        .prepare(
          `SELECT channel_id, enclave_name, status FROM enclave_bindings ORDER BY enclave_name`,
        )
        .all() as Array<{
        channel_id: string;
        enclave_name: string;
        status: string;
      }>;

      expect(rows).toHaveLength(2);
      expect(rows[0]!.enclave_name).toBe('engineering');
      expect(rows[0]!.channel_id).toBe('C_ENGINEERING');
      expect(rows[0]!.status).toBe('active');
      expect(rows[1]!.enclave_name).toBe('marketing');
      expect(rows[1]!.channel_id).toBe('C_MARKETING');
      db.close();
    }
  });

  it('outbound_messages dedup table is preserved after restart', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'kraken.db');

    const beforeRestart = ['msg-1', 'msg-2', 'msg-3'];

    {
      const db = createDatabase(dbPath);
      for (const id of beforeRestart) {
        db.prepare(
          `INSERT INTO outbound_messages (id, channel_id, content_hash) VALUES (?, ?, ?)`,
        ).run(id, 'C_TEST', `hash-${id}`);
      }
      db.close();
    }

    {
      const db = createDatabase(dbPath);
      const rows = db
        .prepare(`SELECT id FROM outbound_messages ORDER BY id`)
        .all() as Array<{ id: string }>;

      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
      db.close();
    }
  });

  it('schema is idempotent — reopening does not wipe existing data', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'kraken.db');

    {
      const db = createDatabase(dbPath);
      db.prepare(
        `INSERT INTO user_tokens (slack_user_id, access_token, refresh_token, expires_at, keycloak_sub, email)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        'U_PERSIST',
        'at-persist',
        'rt-persist',
        '2026-12-31T00:00:00.000Z',
        'sub-persist',
        'persist@example.com',
      );
      db.close();
    }

    // Open three more times — each applies CREATE TABLE IF NOT EXISTS
    for (let i = 0; i < 3; i++) {
      const db = createDatabase(dbPath);
      const count = (
        db.prepare(`SELECT COUNT(*) as n FROM user_tokens`).get() as {
          n: number;
        }
      ).n;
      expect(count).toBe(1);
      db.close();
    }
  });

  it('foreign keys are enforced after restart', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'kraken.db');

    // First run: create binding
    {
      const db = createDatabase(dbPath);
      db.prepare(
        `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
         VALUES (?, ?, ?)`,
      ).run('C_TEST', 'testenclave', 'U_ALICE');
      db.close();
    }

    // Second run: FK should still be enforced
    {
      const db = createDatabase(dbPath);

      // Valid FK: should succeed
      expect(() => {
        db.prepare(
          `INSERT INTO deployments (enclave, tentacle, version, git_sha, git_tag, deploy_type, summary, deployed_by_email, triggered_by_channel, triggered_by_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'testenclave',
          'my-tentacle',
          1,
          'abc123',
          'v1',
          'deploy',
          'Init',
          'alice@example.com',
          'C_TEST',
          '1.0',
        );
      }).not.toThrow();

      // Invalid FK: should fail (FK enforcement ON)
      expect(() => {
        db.prepare(
          `INSERT INTO deployments (enclave, tentacle, version, git_sha, git_tag, deploy_type, summary, deployed_by_email, triggered_by_channel, triggered_by_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'nonexistent-enclave',
          'tentacle',
          2,
          'abc',
          'v2',
          'deploy',
          'Bad',
          'alice@example.com',
          'C_TEST',
          '2.0',
        );
      }).toThrow();

      db.close();
    }
  });

  it('new data written after restart coexists with pre-restart data', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'kraken.db');

    {
      const db = createDatabase(dbPath);
      db.prepare(
        `INSERT INTO user_tokens (slack_user_id, access_token, refresh_token, expires_at, keycloak_sub, email)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        'U_PRE',
        'at-pre',
        'rt-pre',
        '2026-12-31T00:00:00.000Z',
        'sub-pre',
        'pre@example.com',
      );
      db.close();
    }

    {
      const db = createDatabase(dbPath);
      // Write new row after restart
      db.prepare(
        `INSERT INTO user_tokens (slack_user_id, access_token, refresh_token, expires_at, keycloak_sub, email)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        'U_POST',
        'at-post',
        'rt-post',
        '2026-12-31T00:00:00.000Z',
        'sub-post',
        'post@example.com',
      );

      const rows = db
        .prepare(`SELECT slack_user_id FROM user_tokens ORDER BY slack_user_id`)
        .all() as Array<{ slack_user_id: string }>;

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.slack_user_id)).toEqual(['U_POST', 'U_PRE']);
      db.close();
    }
  });
});
