import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/db/migrations.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = createDatabase(':memory:');
});

describe('SQLite schema', () => {
  it('creates all five tables', () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('user_tokens');
    expect(names).toContain('enclave_bindings');
    expect(names).toContain('outbound_messages');
    expect(names).toContain('deployments');
    expect(names).toContain('thread_sessions');
  });

  it('inserts and reads user_tokens', () => {
    db.prepare(
      `INSERT INTO user_tokens (slack_user_id, access_token, refresh_token, expires_at, keycloak_sub, email)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'U123',
      'at',
      'rt',
      '2026-01-01T00:00:00.000Z',
      'sub-1',
      'test@example.com',
    );
    const row = db
      .prepare(`SELECT * FROM user_tokens WHERE slack_user_id = ?`)
      .get('U123') as {
      slack_user_id: string;
      email: string;
    };
    expect(row).toBeTruthy();
    expect(row.email).toBe('test@example.com');
  });

  it('inserts and reads enclave_bindings', () => {
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id) VALUES (?, ?, ?)`,
    ).run('C001', 'marketing', 'U123');
    const row = db
      .prepare(`SELECT * FROM enclave_bindings WHERE channel_id = ?`)
      .get('C001') as {
      enclave_name: string;
      status: string;
    };
    expect(row).toBeTruthy();
    expect(row.enclave_name).toBe('marketing');
    expect(row.status).toBe('active');
  });

  it('inserts outbound_messages without FK constraint', () => {
    // outbound_messages has NO FK — can insert channel not in enclave_bindings
    db.prepare(
      `INSERT INTO outbound_messages (id, channel_id, content_hash) VALUES (?, ?, ?)`,
    ).run('msg-1', 'DM-channel-not-in-bindings', 'hash123');
    const row = db
      .prepare(`SELECT * FROM outbound_messages WHERE id = ?`)
      .get('msg-1') as {
      channel_id: string;
    };
    expect(row).toBeTruthy();
    expect(row.channel_id).toBe('DM-channel-not-in-bindings');
  });

  it('inserts and reads deployments', () => {
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id) VALUES (?, ?, ?)`,
    ).run('C001', 'marketing', 'U123');
    db.prepare(
      `INSERT INTO deployments (enclave, tentacle, version, git_sha, git_tag, deploy_type, summary, deployed_by_email, triggered_by_channel, triggered_by_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'marketing',
      'sentiment-analyzer',
      1,
      'abc123',
      'v1',
      'deploy',
      'Initial deploy',
      'alice@example.com',
      'C001',
      '1234567890.000001',
    );
    const row = db
      .prepare(`SELECT * FROM deployments WHERE enclave = ? AND tentacle = ?`)
      .get('marketing', 'sentiment-analyzer') as {
      version: number;
      status: string;
    };
    expect(row).toBeTruthy();
    expect(row.version).toBe(1);
    expect(row.status).toBe('pending');
  });

  it('inserts and reads thread_sessions', () => {
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id) VALUES (?, ?, ?)`,
    ).run('C001', 'marketing', 'U123');
    db.prepare(
      `INSERT INTO thread_sessions (channel_id, thread_ts, session_id, user_slack_id, enclave_name)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('C001', '1234567890.000001', 'session-abc', 'U123', 'marketing');
    const row = db
      .prepare(
        `SELECT * FROM thread_sessions WHERE channel_id = ? AND thread_ts = ?`,
      )
      .get('C001', '1234567890.000001') as {
      session_id: string;
      enclave_name: string;
    };
    expect(row).toBeTruthy();
    expect(row.session_id).toBe('session-abc');
    expect(row.enclave_name).toBe('marketing');
  });
});

describe('SQLite FK enforcement', () => {
  it('rejects deployments with unknown enclave', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO deployments (enclave, tentacle, version, git_sha, git_tag, deploy_type, summary, deployed_by_email, triggered_by_channel, triggered_by_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'nonexistent',
        'some-tentacle',
        1,
        'abc',
        'v1',
        'deploy',
        'Test',
        'alice@example.com',
        'C001',
        '1.0',
      );
    }).toThrow();
  });

  it('rejects thread_sessions with unknown enclave_name', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO thread_sessions (channel_id, thread_ts, session_id, user_slack_id, enclave_name)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('C001', '1.0', 'sess-1', 'U123', 'nonexistent');
    }).toThrow();
  });

  it('cascades delete from enclave_bindings to deployments and thread_sessions', () => {
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id) VALUES (?, ?, ?)`,
    ).run('C001', 'engineering', 'U456');
    db.prepare(
      `INSERT INTO deployments (enclave, tentacle, version, git_sha, git_tag, deploy_type, summary, deployed_by_email, triggered_by_channel, triggered_by_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'engineering',
      'api-gateway',
      1,
      'abc123',
      'v1',
      'deploy',
      'Initial',
      'bob@example.com',
      'C001',
      '1.0',
    );
    db.prepare(
      `INSERT INTO thread_sessions (channel_id, thread_ts, session_id, user_slack_id, enclave_name)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('C001', '2.0', 'sess-2', 'U456', 'engineering');

    db.prepare(`DELETE FROM enclave_bindings WHERE enclave_name = ?`).run(
      'engineering',
    );

    const deployRow = db
      .prepare(`SELECT * FROM deployments WHERE enclave = ?`)
      .get('engineering');
    const sessionRow = db
      .prepare(`SELECT * FROM thread_sessions WHERE enclave_name = ?`)
      .get('engineering');
    expect(deployRow).toBeUndefined();
    expect(sessionRow).toBeUndefined();
  });

  it('outbound_messages insert succeeds without enclave_bindings entry', () => {
    // No FK on outbound_messages — should NOT throw
    expect(() => {
      db.prepare(
        `INSERT INTO outbound_messages (id, channel_id, content_hash) VALUES (?, ?, ?)`,
      ).run('msg-dm', 'D0000DIRECT', 'hash456');
    }).not.toThrow();
  });
});
