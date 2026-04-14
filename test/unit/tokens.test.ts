import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initTokenStore,
  getUserToken,
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
