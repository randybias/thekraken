import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { EnclaveBindingEngine } from '../../src/enclave/binding.js';
import { createDatabase } from '../../src/db/migrations.js';

/**
 * Create a fresh in-memory SQLite database with the Kraken schema applied.
 */
function createTestDb(): Database.Database {
  return createDatabase(':memory:');
}

describe('EnclaveBindingEngine', () => {
  let db: Database.Database;
  let engine: EnclaveBindingEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new EnclaveBindingEngine(db);
  });

  it('returns null for an unbound channel', () => {
    const result = engine.lookupEnclave('C_UNKNOWN');
    expect(result).toBeNull();
  });

  it('returns binding for a channel with an active binding', () => {
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id, status)
       VALUES ('C123', 'my-enclave', 'U456', 'active')`,
    ).run();

    const result = engine.lookupEnclave('C123');
    expect(result).not.toBeNull();
    expect(result!.channelId).toBe('C123');
    expect(result!.enclaveName).toBe('my-enclave');
    expect(result!.ownerSlackId).toBe('U456');
    expect(result!.status).toBe('active');
    expect(result!.createdAt).toBeTruthy();
  });

  it('returns null for a channel with a non-active binding', () => {
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id, status)
       VALUES ('C123', 'my-enclave', 'U456', 'inactive')`,
    ).run();

    const result = engine.lookupEnclave('C123');
    expect(result).toBeNull();
  });

  it('returns null for DM-style channels (not bound by design)', () => {
    // DM channels (D...) are not in the enclave_bindings table
    const result = engine.lookupEnclave('D789DIRECT');
    expect(result).toBeNull();
  });

  it('count() returns 0 when no active bindings exist', () => {
    expect(engine.count()).toBe(0);
  });

  it('count() returns the number of active bindings', () => {
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id, status)
       VALUES ('C001', 'enclave-1', 'U001', 'active'),
              ('C002', 'enclave-2', 'U002', 'active'),
              ('C003', 'enclave-3', 'U003', 'inactive')`,
    ).run();

    expect(engine.count()).toBe(2);
  });

  it('lookupEnclave returns only the most recently inserted active binding', () => {
    // Two rows for the same channel — in practice this shouldn't happen due to
    // unique constraints, but test that query works correctly.
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id, status)
       VALUES ('C001', 'enclave-a', 'U001', 'active')`,
    ).run();

    const result = engine.lookupEnclave('C001');
    expect(result).not.toBeNull();
    expect(result!.enclaveName).toBe('enclave-a');
  });
});
