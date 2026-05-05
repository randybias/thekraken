import { describe, it, expect } from 'vitest';
import { createDatabase } from '../../src/db/migrations.js';
import { recordDeployEvent } from '../../src/dispatcher/internal-ops.js';

/** Insert a required enclave_binding so FK constraints pass. */
function seedEnclave(
  db: ReturnType<typeof createDatabase>,
  enclaveName: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
     VALUES (?, ?, ?)`,
  ).run('C_TEST', enclaveName, 'U123');
}

describe('record_deploy_event', () => {
  it('writes a deploy event row with the given summary', async () => {
    const db = createDatabase(':memory:');
    seedEnclave(db, 'tentacular-agensys');
    await recordDeployEvent(db, {
      enclave: 'tentacular-agensys',
      tentacle: 'ai-news-digest',
      gitSha: 'def5678',
      summary: 'increased title length to 80 chars',
      deployedByEmail: 'rbias@mirantis.com',
      triggeredByChannel: 'C_AGENSYS',
      triggeredByTs: '1700000000.000100',
    });
    const row = db
      .prepare(`SELECT * FROM deployments WHERE git_sha = ?`)
      .get('def5678') as { summary: string; deploy_type: string };
    expect(row.summary).toBe('increased title length to 80 chars');
    expect(row.deploy_type).toBe('manual');
  });

  it('falls back to "(deployed; no notes)" when summary is empty', async () => {
    const db = createDatabase(':memory:');
    seedEnclave(db, 'tentacular-agensys');
    await recordDeployEvent(db, {
      enclave: 'tentacular-agensys',
      tentacle: 'ai-news-digest',
      gitSha: 'def5679',
      summary: '',
      deployedByEmail: 'rbias@mirantis.com',
      triggeredByChannel: 'C_AGENSYS',
      triggeredByTs: '1700000000.000100',
    });
    const row = db
      .prepare(`SELECT summary FROM deployments WHERE git_sha = ?`)
      .get('def5679') as { summary: string };
    expect(row.summary).toBe('(deployed; no notes)');
  });
});
