import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { resolveChannel } from '../../../src/dispatcher/channel-resolver.js';

function inMemDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE enclave_bindings (
    channel_id TEXT PRIMARY KEY,
    enclave_name TEXT NOT NULL UNIQUE,
    owner_slack_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT '2026-01-01'
  )`);
  return db;
}

describe('resolveChannel', () => {
  it('returns binding for an active channel', () => {
    const db = inMemDb();
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
       VALUES (?, ?, ?)`,
    ).run('C123', 'foo-enclave', 'U1');
    expect(resolveChannel(db, 'C123')).toEqual({
      channelId: 'C123',
      enclaveName: 'foo-enclave',
      ownerSlackId: 'U1',
    });
  });

  it('returns null for an unknown channel', () => {
    expect(resolveChannel(inMemDb(), 'CMISSING')).toBeNull();
  });

  it('returns null for an inactive binding', () => {
    const db = inMemDb();
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id, status)
       VALUES (?, ?, ?, 'inactive')`,
    ).run('C123', 'foo-enclave', 'U1');
    expect(resolveChannel(db, 'C123')).toBeNull();
  });
});
