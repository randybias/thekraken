import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initTokenStore,
  getUserToken,
  getUserTokenByEmail,
  setUserToken,
  deleteUserToken,
  getAllUserTokens,
} from '../../src/auth/tokens.js';

describe('token store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        slack_user_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        keycloak_sub TEXT NOT NULL,
        email TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    initTokenStore(db);
  });

  it('returns undefined for unknown user', () => {
    expect(getUserToken('U_UNKNOWN')).toBeUndefined();
  });

  it('stores and retrieves a token', () => {
    const expiresAt = Date.now() + 3600_000;
    setUserToken('U_ALICE', {
      access_token: 'at_alice',
      refresh_token: 'rt_alice',
      expires_at: expiresAt,
      keycloak_sub: 'sub_alice',
      email: 'alice@example.com',
    });
    const stored = getUserToken('U_ALICE');
    expect(stored).toBeDefined();
    expect(stored!.access_token).toBe('at_alice');
    expect(stored!.email).toBe('alice@example.com');
    expect(stored!.expires_at).toBe(expiresAt);
  });

  it('upserts on duplicate user', () => {
    setUserToken('U_BOB', {
      access_token: 'at_old',
      refresh_token: 'rt_old',
      expires_at: Date.now(),
      keycloak_sub: 'sub_bob',
      email: 'bob@example.com',
    });
    setUserToken('U_BOB', {
      access_token: 'at_new',
      refresh_token: 'rt_new',
      expires_at: Date.now() + 7200_000,
      keycloak_sub: 'sub_bob',
      email: 'bob@example.com',
    });
    const stored = getUserToken('U_BOB');
    expect(stored!.access_token).toBe('at_new');
  });

  it('deletes a token', () => {
    setUserToken('U_DEL', {
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: Date.now(),
      keycloak_sub: 'sub',
      email: 'del@example.com',
    });
    deleteUserToken('U_DEL');
    expect(getUserToken('U_DEL')).toBeUndefined();
  });

  it('lists all tokens', () => {
    setUserToken('U_A', {
      access_token: 'a',
      refresh_token: 'ra',
      expires_at: Date.now(),
      keycloak_sub: 'sa',
      email: 'a@x.com',
    });
    setUserToken('U_B', {
      access_token: 'b',
      refresh_token: 'rb',
      expires_at: Date.now(),
      keycloak_sub: 'sb',
      email: 'b@x.com',
    });
    expect(getAllUserTokens()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tripwire: email uniqueness guarantee
//
// user_tokens has no UNIQUE constraint on email — we rely on Keycloak
// enforcing that one email maps to exactly one user identity. If that
// upstream guarantee ever breaks (e.g. a test import, a manual DB insert,
// a future schema change), getUserTokenByEmail becomes non-deterministic
// and owner attribution in enclave bindings silently breaks.
//
// These tests document the CURRENT behaviour of setUserToken and
// getUserTokenByEmail with respect to duplicate emails. If setUserToken is
// ever hardened with an explicit check-before-insert or a UNIQUE constraint,
// the tests must be updated to match the new guarantee — that is intentional.
// ---------------------------------------------------------------------------
describe('token store — email uniqueness tripwire', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        slack_user_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        keycloak_sub TEXT NOT NULL,
        email TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    initTokenStore(db);
  });

  it('schema has no UNIQUE constraint on email — two Slack users can share an email', () => {
    // This test documents a GAP: the schema trusts Keycloak to enforce
    // email uniqueness. If two different Slack user IDs are stored with the
    // same email, the DB happily accepts both rows.
    //
    // If this test starts FAILING with a UNIQUE constraint violation, it
    // means a UNIQUE(email) constraint was added to the schema — which is
    // the correct fix. Update this test to assert the constraint exists.
    setUserToken('U_ALICE', {
      access_token: 'at_alice',
      refresh_token: 'rt_alice',
      expires_at: Date.now() + 3600_000,
      keycloak_sub: 'sub_alice',
      email: 'shared@example.com',
    });

    // A second, distinct Slack user with the same email — DB does NOT reject this.
    expect(() =>
      setUserToken('U_ALICE_CLONE', {
        access_token: 'at_clone',
        refresh_token: 'rt_clone',
        expires_at: Date.now() + 3600_000,
        keycloak_sub: 'sub_clone',
        email: 'shared@example.com',
      }),
    ).not.toThrow();

    // Both rows exist — the schema does not deduplicate by email.
    expect(getAllUserTokens()).toHaveLength(2);
  });

  it('getUserTokenByEmail is non-deterministic when duplicate emails exist', () => {
    // Demonstrates that without a UNIQUE(email) constraint, the lookup
    // returns ONE row but there is no guarantee which one. Callers of
    // getUserTokenByEmail (specifically owner attribution in binding.ts)
    // must be aware that this function's result is only reliable when
    // Keycloak's email-uniqueness guarantee holds.
    setUserToken('U_FIRST', {
      access_token: 'at_first',
      refresh_token: 'rt_first',
      expires_at: Date.now() + 3600_000,
      keycloak_sub: 'sub_first',
      email: 'dup@example.com',
    });
    setUserToken('U_SECOND', {
      access_token: 'at_second',
      refresh_token: 'rt_second',
      expires_at: Date.now() + 3600_000,
      keycloak_sub: 'sub_second',
      email: 'dup@example.com',
    });

    // The function returns a result (not undefined), but we cannot assert
    // which row — the DB query uses no ORDER BY. We only assert that it
    // returns exactly one of the two stored users.
    const result = getUserTokenByEmail('dup@example.com');
    expect(result).toBeDefined();
    expect(['U_FIRST', 'U_SECOND']).toContain(result!.slack_user_id);
  });

  it('single user with unique email — getUserTokenByEmail returns correct row', () => {
    // Happy path: when each email maps to exactly one Slack user (the normal
    // case with Keycloak enforcing uniqueness), the lookup is deterministic.
    setUserToken('U_CAROL', {
      access_token: 'at_carol',
      refresh_token: 'rt_carol',
      expires_at: Date.now() + 3600_000,
      keycloak_sub: 'sub_carol',
      email: 'carol@example.com',
    });

    const result = getUserTokenByEmail('carol@example.com');
    expect(result).toBeDefined();
    expect(result!.slack_user_id).toBe('U_CAROL');
  });
});
