/**
 * Unit tests for DeploymentDb (SQLite deployments table operations).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/db/migrations.js';
import { DeploymentDb } from '../../src/git-state/deployments-db.js';
import type Database from 'better-sqlite3';

describe('DeploymentDb', () => {
  let db: Database.Database;
  let deployDb: DeploymentDb;

  beforeEach(() => {
    db = createDatabase(':memory:');
    // Need an enclave_bindings row for FK
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
       VALUES ('C001', 'my-enc', 'U001')`,
    ).run();
    deployDb = new DeploymentDb(db);
  });

  function insertDeployment(overrides: Record<string, unknown> = {}): number {
    return deployDb.insert({
      enclave: 'my-enc',
      tentacle: 'my-wf',
      version: 1,
      gitSha: 'abc123',
      gitTag: 'my-wf-v1',
      deployType: 'deploy',
      summary: 'Test deployment',
      deployedByEmail: 'alice@example.com',
      triggeredByChannel: 'C001',
      triggeredByTs: '1234567890.000001',
      ...overrides,
    });
  }

  it('inserts a deployment and returns an id', () => {
    const id = insertDeployment();
    expect(id).toBeGreaterThan(0);
  });

  it('inserts with status pending by default', () => {
    const id = insertDeployment();
    const row = db
      .prepare('SELECT status FROM deployments WHERE id = ?')
      .get(id) as { status: string };
    expect(row.status).toBe('pending');
  });

  it('updates status to success', () => {
    const id = insertDeployment();
    deployDb.updateStatus(id, 'success');
    const row = db
      .prepare('SELECT status FROM deployments WHERE id = ?')
      .get(id) as { status: string; status_detail: string | null };
    expect(row.status).toBe('success');
    // better-sqlite3 returns undefined for NULL columns
    expect(row.status_detail == null).toBe(true);
  });

  it('updates status to failed with detail', () => {
    const id = insertDeployment();
    deployDb.updateStatus(id, 'failed', 'something went wrong');
    const row = db
      .prepare('SELECT status, status_detail FROM deployments WHERE id = ?')
      .get(id) as { status: string; status_detail: string };
    expect(row.status).toBe('failed');
    expect(row.status_detail).toBe('something went wrong');
  });

  it('getLatestSuccessful returns undefined when none exist', () => {
    const row = deployDb.getLatestSuccessful('my-enc', 'my-wf');
    expect(row).toBeUndefined();
  });

  it('getLatestSuccessful returns the most recent successful deployment', () => {
    const id1 = insertDeployment({ version: 1, gitTag: 'my-wf-v1' });
    const id2 = insertDeployment({ version: 2, gitTag: 'my-wf-v2' });
    deployDb.updateStatus(id1, 'success');
    deployDb.updateStatus(id2, 'success');
    const row = deployDb.getLatestSuccessful('my-enc', 'my-wf');
    // Most recent = id2
    expect(row?.version).toBe(2);
  });

  it('getLatestSuccessful ignores failed deployments', () => {
    const id = insertDeployment({ version: 1, gitTag: 'my-wf-v1' });
    deployDb.updateStatus(id, 'failed');
    const row = deployDb.getLatestSuccessful('my-enc', 'my-wf');
    expect(row).toBeUndefined();
  });

  it('listForEnclave returns deployments in descending order', () => {
    const id1 = insertDeployment({ version: 1, gitTag: 'my-wf-v1' });
    const id2 = insertDeployment({ version: 2, gitTag: 'my-wf-v2' });
    deployDb.updateStatus(id1, 'success');
    deployDb.updateStatus(id2, 'success');
    const rows = deployDb.listForEnclave('my-enc');
    expect(rows.length).toBe(2);
    // Most recent first
    expect(rows[0].version).toBe(2);
    expect(rows[1].version).toBe(1);
  });

  it('listForEnclave respects limit', () => {
    for (let i = 1; i <= 5; i++) {
      insertDeployment({ version: i, gitTag: `my-wf-v${i}` });
    }
    const rows = deployDb.listForEnclave('my-enc', 3);
    expect(rows.length).toBe(3);
  });

  it('tagExists returns false when tag not found', () => {
    expect(deployDb.tagExists('my-enc', 'my-wf', 'my-wf-v99')).toBe(false);
  });

  it('tagExists returns true when tag found', () => {
    insertDeployment({ gitTag: 'my-wf-v1' });
    expect(deployDb.tagExists('my-enc', 'my-wf', 'my-wf-v1')).toBe(true);
  });
});
