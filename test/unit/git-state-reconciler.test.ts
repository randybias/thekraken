import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/db/migrations.js';
import { runReconciler } from '../../src/git-state/reconciler.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: Database.Database;

/** Seed an enclave_bindings row so FK constraints on deployments pass. */
function seedEnclave(enclaveName: string, channelId = 'C001'): void {
  db.prepare(
    `INSERT OR IGNORE INTO enclave_bindings
       (channel_id, enclave_name, owner_slack_id, status)
     VALUES (?, ?, 'U001', 'active')`,
  ).run(channelId, enclaveName);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('git-state reconciler', () => {
  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  it('inserts a reconstructed row for a deployed tentacle missing from DB', async () => {
    seedEnclave('tentacular-agensys', 'C_AGENSYS');

    const mockMcp = {
      wfList: async (_: string) => ({
        workflows: [
          {
            name: 'ai-news-digest',
            enclave: 'tentacular-agensys',
            annotations: {
              'tentacular.io/git-sha': 'abc1234',
              'tentacular.io/deployed-by': 'rbias@mirantis.com',
              'tentacular.io/deployed-at': '2026-04-14T15:03:56Z',
            },
          },
        ],
      }),
    };

    await runReconciler(db, mockMcp, ['tentacular-agensys']);

    const rows = db
      .prepare(
        `SELECT enclave, tentacle, git_sha, summary FROM deployments
         WHERE enclave = ? AND tentacle = ?`,
      )
      .all('tentacular-agensys', 'ai-news-digest');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      enclave: 'tentacular-agensys',
      tentacle: 'ai-news-digest',
      git_sha: 'abc1234',
      summary: '(reconstructed from cluster — no original notes)',
    });
  });

  it('is idempotent — running twice produces no duplicate rows', async () => {
    seedEnclave('tentacular-agensys', 'C_AGENSYS');

    const mockMcp = {
      wfList: async () => ({
        workflows: [
          {
            name: 'ai-news-digest',
            enclave: 'tentacular-agensys',
            annotations: {
              'tentacular.io/git-sha': 'abc1234',
              'tentacular.io/deployed-by': 'rbias@mirantis.com',
            },
          },
        ],
      }),
    };

    await runReconciler(db, mockMcp, ['tentacular-agensys']);
    await runReconciler(db, mockMcp, ['tentacular-agensys']);

    const count = db
      .prepare(
        `SELECT COUNT(*) as c FROM deployments WHERE enclave = ? AND tentacle = ?`,
      )
      .get('tentacular-agensys', 'ai-news-digest') as { c: number };
    expect(count.c).toBe(1);
  });

  it('skips tentacles whose SHA is already in DB', async () => {
    seedEnclave('tentacular-agensys', 'C_AGENSYS');

    db.prepare(
      `INSERT INTO deployments (enclave, tentacle, version, git_sha, git_tag,
        deploy_type, summary, deployed_by_email, triggered_by_channel,
        triggered_by_ts, status)
       VALUES (?, ?, 1, 'abc1234', '', 'manual', 'real summary',
        'rbias@mirantis.com', 'C_X', 'ts1', 'success')`,
    ).run('tentacular-agensys', 'ai-news-digest');

    const mockMcp = {
      wfList: async () => ({
        workflows: [
          {
            name: 'ai-news-digest',
            enclave: 'tentacular-agensys',
            annotations: {
              'tentacular.io/git-sha': 'abc1234',
              'tentacular.io/deployed-by': 'rbias@mirantis.com',
            },
          },
        ],
      }),
    };

    await runReconciler(db, mockMcp, ['tentacular-agensys']);

    const row = db
      .prepare(`SELECT summary FROM deployments WHERE git_sha = ?`)
      .get('abc1234') as { summary: string };
    expect(row.summary).toBe('real summary'); // not overwritten
  });

  it('tolerates missing annotations gracefully', async () => {
    seedEnclave('tentacular-agensys', 'C_AGENSYS');

    const mockMcp = {
      wfList: async () => ({
        workflows: [
          {
            name: 'ai-news-digest',
            enclave: 'tentacular-agensys',
            annotations: {}, // no git-sha, no deployed-by
          },
        ],
      }),
    };

    await expect(
      runReconciler(db, mockMcp, ['tentacular-agensys']),
    ).resolves.not.toThrow();

    // No row inserted because there's no git-sha to key on.
    const count = db.prepare(`SELECT COUNT(*) as c FROM deployments`).get() as {
      c: number;
    };
    expect(count.c).toBe(0);
  });
});
