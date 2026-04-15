import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/db/migrations.js';
import {
  recordDeployment,
  getDeploymentHistory,
  getLatestDeployment,
  updateDeploymentStatus,
  type DeploymentRecord,
} from '../../src/git-state/deployments-db.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: Database.Database;

/** Insert a required enclave_binding so FK constraints pass. */
function seedEnclave(enclaveName: string, channelId = 'C001'): void {
  db.prepare(
    `INSERT OR IGNORE INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
     VALUES (?, ?, ?)`,
  ).run(channelId, enclaveName, 'U123');
}

/** Minimal valid deployment params for the given enclave/tentacle/version. */
function deployParams(
  enclave: string,
  tentacle: string,
  version: number,
  overrides: Partial<{
    git_sha: string;
    git_tag: string;
    deploy_type: string;
    summary: string;
    deployed_by_email: string;
    triggered_by_channel: string;
    triggered_by_ts: string;
  }> = {},
) {
  return {
    enclave,
    tentacle,
    version,
    git_sha: overrides.git_sha ?? 'abc123',
    git_tag: overrides.git_tag ?? `v${version}`,
    deploy_type: overrides.deploy_type ?? 'deploy',
    summary: overrides.summary ?? `Deploy version ${version}`,
    deployed_by_email: overrides.deployed_by_email ?? 'alice@example.com',
    triggered_by_channel: overrides.triggered_by_channel ?? 'C001',
    triggered_by_ts:
      overrides.triggered_by_ts ?? `${1_700_000_000 + version}.000001`,
  };
}

beforeEach(() => {
  db = createDatabase(':memory:');
  seedEnclave('marketing');
});

// ---------------------------------------------------------------------------
// recordDeployment
// ---------------------------------------------------------------------------

describe('recordDeployment', () => {
  it('inserts a row and returns a positive integer ID', () => {
    const id = recordDeployment(
      db,
      deployParams('marketing', 'sentiment-analyzer', 1),
    );
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('inserted row has correct fields', () => {
    const id = recordDeployment(
      db,
      deployParams('marketing', 'sentiment-analyzer', 1, {
        git_sha: 'deadbeef',
        git_tag: 'v1.0.0',
        summary: 'Initial deploy',
      }),
    );

    const row = db
      .prepare('SELECT * FROM deployments WHERE id = ?')
      .get(id) as DeploymentRecord;

    expect(row.enclave).toBe('marketing');
    expect(row.tentacle).toBe('sentiment-analyzer');
    expect(row.version).toBe(1);
    expect(row.git_sha).toBe('deadbeef');
    expect(row.git_tag).toBe('v1.0.0');
    expect(row.summary).toBe('Initial deploy');
    expect(row.deployed_by_email).toBe('alice@example.com');
  });

  it('defaults status to pending when not provided', () => {
    const id = recordDeployment(db, deployParams('marketing', 'my-wf', 1));
    const row = db
      .prepare('SELECT status FROM deployments WHERE id = ?')
      .get(id) as DeploymentRecord;
    expect(row.status).toBe('pending');
  });

  it('accepts a custom initial status', () => {
    const id = recordDeployment(db, {
      ...deployParams('marketing', 'my-wf', 1),
      status: 'success',
    });
    const row = db
      .prepare('SELECT status FROM deployments WHERE id = ?')
      .get(id) as DeploymentRecord;
    expect(row.status).toBe('success');
  });

  it('stores optional details when provided', () => {
    const id = recordDeployment(db, {
      ...deployParams('marketing', 'my-wf', 1),
      details: 'Rolled out to 3 replicas.',
    });
    const row = db
      .prepare('SELECT details FROM deployments WHERE id = ?')
      .get(id) as DeploymentRecord;
    expect(row.details).toBe('Rolled out to 3 replicas.');
  });

  it('stores null details when details is omitted', () => {
    const id = recordDeployment(db, deployParams('marketing', 'my-wf', 1));
    const row = db
      .prepare('SELECT details FROM deployments WHERE id = ?')
      .get(id) as DeploymentRecord;
    expect(row.details).toBeNull();
  });

  it('rejects a duplicate (enclave, tentacle, version) combination', () => {
    recordDeployment(db, deployParams('marketing', 'my-wf', 1));
    expect(() =>
      recordDeployment(db, deployParams('marketing', 'my-wf', 1)),
    ).toThrow();
  });

  it('rejects an unknown enclave (FK violation)', () => {
    expect(() =>
      recordDeployment(db, deployParams('nonexistent-enclave', 'my-wf', 1)),
    ).toThrow();
  });

  it('allows same version for different tentacles', () => {
    expect(() => {
      recordDeployment(db, deployParams('marketing', 'wf-a', 1));
      recordDeployment(db, deployParams('marketing', 'wf-b', 1));
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getDeploymentHistory
// ---------------------------------------------------------------------------

describe('getDeploymentHistory', () => {
  it('returns an empty array when no deployments exist', () => {
    const history = getDeploymentHistory(db, 'marketing', 'nonexistent-wf');
    expect(history).toEqual([]);
  });

  it('returns all deployments in newest-first order', () => {
    // Insert three versions with deliberate ordering
    recordDeployment(
      db,
      deployParams('marketing', 'my-wf', 1, {
        triggered_by_ts: '1700000001.000001',
      }),
    );
    recordDeployment(
      db,
      deployParams('marketing', 'my-wf', 2, {
        triggered_by_ts: '1700000002.000001',
      }),
    );
    recordDeployment(
      db,
      deployParams('marketing', 'my-wf', 3, {
        triggered_by_ts: '1700000003.000001',
      }),
    );

    const history = getDeploymentHistory(db, 'marketing', 'my-wf');
    expect(history).toHaveLength(3);
    // Newest first: version 3 should appear before 2 and 1
    expect(history[0].version).toBeGreaterThanOrEqual(history[1].version);
    expect(history[1].version).toBeGreaterThanOrEqual(history[2].version);
  });

  it('does not return deployments for a different tentacle', () => {
    recordDeployment(db, deployParams('marketing', 'wf-a', 1));
    recordDeployment(db, deployParams('marketing', 'wf-b', 1));

    const history = getDeploymentHistory(db, 'marketing', 'wf-a');
    expect(history).toHaveLength(1);
    expect(history[0].tentacle).toBe('wf-a');
  });

  it('respects the limit parameter', () => {
    for (let v = 1; v <= 5; v++) {
      recordDeployment(db, deployParams('marketing', 'my-wf', v));
    }
    const history = getDeploymentHistory(db, 'marketing', 'my-wf', 3);
    expect(history).toHaveLength(3);
  });

  it('defaults limit to 20', () => {
    for (let v = 1; v <= 25; v++) {
      recordDeployment(db, deployParams('marketing', 'many-wf', v));
    }
    const history = getDeploymentHistory(db, 'marketing', 'many-wf');
    expect(history).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// getLatestDeployment
// ---------------------------------------------------------------------------

describe('getLatestDeployment', () => {
  it('returns null when no deployments exist', () => {
    const result = getLatestDeployment(db, 'marketing', 'nonexistent-wf');
    expect(result).toBeNull();
  });

  it('returns the most recent deployment', () => {
    recordDeployment(db, deployParams('marketing', 'my-wf', 1));
    recordDeployment(db, deployParams('marketing', 'my-wf', 2));
    recordDeployment(db, deployParams('marketing', 'my-wf', 3));

    const latest = getLatestDeployment(db, 'marketing', 'my-wf');
    expect(latest).not.toBeNull();
    // Most recently inserted (by created_at DESC) should be returned
    expect(latest!.enclave).toBe('marketing');
    expect(latest!.tentacle).toBe('my-wf');
  });

  it('returns a single deployment when only one exists', () => {
    recordDeployment(db, deployParams('marketing', 'solo-wf', 1));
    const latest = getLatestDeployment(db, 'marketing', 'solo-wf');
    expect(latest).not.toBeNull();
    expect(latest!.version).toBe(1);
  });

  it('does not return deployments from a different tentacle', () => {
    recordDeployment(db, deployParams('marketing', 'wf-a', 1));

    const latest = getLatestDeployment(db, 'marketing', 'wf-b');
    expect(latest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateDeploymentStatus
// ---------------------------------------------------------------------------

describe('updateDeploymentStatus', () => {
  it('updates the status of a deployment', () => {
    const id = recordDeployment(db, deployParams('marketing', 'my-wf', 1));

    updateDeploymentStatus(db, id, 'success');

    const row = db
      .prepare('SELECT status, status_detail FROM deployments WHERE id = ?')
      .get(id) as { status: string; status_detail: string | null };
    expect(row.status).toBe('success');
    expect(row.status_detail).toBeNull();
  });

  it('stores a status_detail message when provided', () => {
    const id = recordDeployment(db, deployParams('marketing', 'my-wf', 1));

    updateDeploymentStatus(db, id, 'failed', 'tntc exited with code 1');

    const row = db
      .prepare('SELECT status, status_detail FROM deployments WHERE id = ?')
      .get(id) as { status: string; status_detail: string | null };
    expect(row.status).toBe('failed');
    expect(row.status_detail).toBe('tntc exited with code 1');
  });

  it('sets status_detail to null when not provided', () => {
    const id = recordDeployment(db, deployParams('marketing', 'my-wf', 1));

    updateDeploymentStatus(db, id, 'success');

    const row = db
      .prepare('SELECT status_detail FROM deployments WHERE id = ?')
      .get(id) as { status_detail: string | null };
    expect(row.status_detail).toBeNull();
  });

  it('is a no-op for a non-existent ID (does not throw)', () => {
    expect(() => updateDeploymentStatus(db, 999_999, 'success')).not.toThrow();
  });
});
