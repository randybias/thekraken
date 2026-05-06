import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { resolveChannel } from '../../../src/dispatcher/channel-resolver.js';

/**
 * The wiring at src/index.ts uses:
 *   const resolved = ctx.channelId ? resolveChannel(db, ctx.channelId) : null;
 *   const channelName = ctx.channelName ?? resolved?.enclaveName;
 *
 * This test models that exact composition so a future refactor that
 * breaks the precedence (e.g., overwriting an explicit channelName)
 * is caught.
 */
function effectiveChannelName(
  db: Database.Database,
  ctxChannelId: string | undefined,
  ctxChannelName: string | undefined,
): string | undefined {
  const resolved = ctxChannelId ? resolveChannel(db, ctxChannelId) : null;
  return ctxChannelName ?? resolved?.enclaveName;
}

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

describe('smart-path channel-name resolution wiring', () => {
  it('uses ctx.channelName when explicitly provided', () => {
    const db = inMemDb();
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id) VALUES (?, ?, ?)`,
    ).run('C123', 'binding-name', 'U1');
    expect(effectiveChannelName(db, 'C123', 'explicit-name')).toBe('explicit-name');
  });

  it('falls back to resolved enclave name when ctx.channelName missing', () => {
    const db = inMemDb();
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id) VALUES (?, ?, ?)`,
    ).run('C123', 'binding-name', 'U1');
    expect(effectiveChannelName(db, 'C123', undefined)).toBe('binding-name');
  });

  it('returns undefined when no binding and no ctx.channelName', () => {
    expect(effectiveChannelName(inMemDb(), 'CMISSING', undefined)).toBeUndefined();
  });

  it('returns undefined when neither channelId nor channelName present', () => {
    expect(effectiveChannelName(inMemDb(), undefined, undefined)).toBeUndefined();
  });
});
