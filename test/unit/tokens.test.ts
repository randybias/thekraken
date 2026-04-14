import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/db/migrations.js';
import { UserTokenStore, SESSION_WINDOW_MS } from '../../src/auth/tokens.js';
import type { TokenResponse } from '../../src/auth/oidc.js';
import type Database from 'better-sqlite3';

const TEST_KEY = Buffer.alloc(32, 0xcc);

function makeTokenResponse(expiresIn = 3600): TokenResponse {
  return {
    access_token: 'eyJ.access.token',
    refresh_token: 'eyJ.refresh.token',
    expires_in: expiresIn,
    token_type: 'Bearer',
  };
}

let db: Database.Database;
let store: UserTokenStore;

beforeEach(() => {
  db = createDatabase(':memory:');
  store = new UserTokenStore(db, TEST_KEY);
});

describe('UserTokenStore.storeUserToken', () => {
  it('stores a token for a user', () => {
    store.storeUserToken(
      'U001',
      makeTokenResponse(),
      'sub-1',
      'alice@example.com',
    );
    const row = db
      .prepare(`SELECT * FROM user_tokens WHERE slack_user_id = ?`)
      .get('U001') as { email: string; access_token: string };
    expect(row).toBeTruthy();
    expect(row.email).toBe('alice@example.com');
    // access_token should be encrypted (not plaintext)
    expect(row.access_token).not.toBe('eyJ.access.token');
    expect(row.access_token).toContain(':'); // iv:ciphertext:authTag format
  });

  it('overwrites an existing token on second call', () => {
    store.storeUserToken(
      'U001',
      makeTokenResponse(),
      'sub-1',
      'alice@example.com',
    );
    const tokens2: TokenResponse = {
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 3600,
      token_type: 'Bearer',
    };
    store.storeUserToken('U001', tokens2, 'sub-1', 'alice@example.com');

    const token = store.getValidTokenForUser('U001');
    expect(token).toBe('new-access-token');
  });

  it('preserves created_at on token refresh (session window anchor)', () => {
    store.storeUserToken(
      'U001',
      makeTokenResponse(),
      'sub-1',
      'alice@example.com',
    );
    const row1 = db
      .prepare(`SELECT created_at FROM user_tokens WHERE slack_user_id = ?`)
      .get('U001') as { created_at: string };

    // Small delay to ensure time difference
    store.storeUserToken(
      'U001',
      makeTokenResponse(7200),
      'sub-1',
      'alice@example.com',
    );
    const row2 = db
      .prepare(`SELECT created_at FROM user_tokens WHERE slack_user_id = ?`)
      .get('U001') as { created_at: string };

    expect(row1.created_at).toBe(row2.created_at);
  });
});

describe('UserTokenStore.getValidTokenForUser', () => {
  it('returns null when no token stored', () => {
    expect(store.getValidTokenForUser('U999')).toBeNull();
  });

  it('returns the decrypted access token when valid', () => {
    store.storeUserToken(
      'U001',
      makeTokenResponse(3600),
      'sub-1',
      'alice@example.com',
    );
    expect(store.getValidTokenForUser('U001')).toBe('eyJ.access.token');
  });

  it('returns null for an expired access token', () => {
    // Store a token that expired in the past
    store.storeUserToken(
      'U001',
      makeTokenResponse(1),
      'sub-1',
      'alice@example.com',
    );
    // Manually set expires_at to the past
    db.prepare(
      `UPDATE user_tokens SET expires_at = ? WHERE slack_user_id = ?`,
    ).run(new Date(Date.now() - 60_000).toISOString(), 'U001');
    expect(store.getValidTokenForUser('U001')).toBeNull();
  });

  it('returns null and deletes row when session window exceeded', () => {
    store.storeUserToken(
      'U001',
      makeTokenResponse(3600),
      'sub-1',
      'alice@example.com',
    );
    // Backdate created_at beyond 12-hour session window
    db.prepare(
      `UPDATE user_tokens SET created_at = ? WHERE slack_user_id = ?`,
    ).run(
      new Date(Date.now() - SESSION_WINDOW_MS - 1000).toISOString(),
      'U001',
    );

    const token = store.getValidTokenForUser('U001');
    expect(token).toBeNull();

    // Row should be deleted
    const row = db
      .prepare(`SELECT * FROM user_tokens WHERE slack_user_id = ?`)
      .get('U001');
    expect(row).toBeUndefined();
  });
});

describe('UserTokenStore.getRefreshableTokens', () => {
  it('returns tokens expiring within threshold', () => {
    // Token expiring in 5 minutes — within 15-minute threshold
    store.storeUserToken(
      'U001',
      makeTokenResponse(300),
      'sub-1',
      'alice@example.com',
    );
    const result = store.getRefreshableTokens(15 * 60 * 1000);
    expect(result.length).toBe(1);
    expect(result[0]!.slackUserId).toBe('U001');
    expect(result[0]!.refreshToken).toBe('eyJ.refresh.token');
  });

  it('excludes tokens not yet near expiry', () => {
    // Token expiring in 2 hours — outside 15-minute threshold
    store.storeUserToken(
      'U001',
      makeTokenResponse(7200),
      'sub-1',
      'alice@example.com',
    );
    const result = store.getRefreshableTokens(15 * 60 * 1000);
    expect(result.length).toBe(0);
  });

  it('excludes tokens past session window', () => {
    store.storeUserToken(
      'U001',
      makeTokenResponse(300),
      'sub-1',
      'alice@example.com',
    );
    // Backdate created_at beyond session window
    db.prepare(
      `UPDATE user_tokens SET created_at = ? WHERE slack_user_id = ?`,
    ).run(
      new Date(Date.now() - SESSION_WINDOW_MS - 1000).toISOString(),
      'U001',
    );

    const result = store.getRefreshableTokens(15 * 60 * 1000);
    expect(result.length).toBe(0);
  });

  it('returns multiple refreshable users', () => {
    store.storeUserToken(
      'U001',
      makeTokenResponse(300),
      'sub-1',
      'alice@example.com',
    );
    store.storeUserToken(
      'U002',
      makeTokenResponse(300),
      'sub-2',
      'bob@example.com',
    );
    const result = store.getRefreshableTokens(15 * 60 * 1000);
    expect(result.length).toBe(2);
  });
});

describe('UserTokenStore.deleteUserToken', () => {
  it('removes the row from the database', () => {
    store.storeUserToken(
      'U001',
      makeTokenResponse(),
      'sub-1',
      'alice@example.com',
    );
    store.deleteUserToken('U001');
    const row = db
      .prepare(`SELECT * FROM user_tokens WHERE slack_user_id = ?`)
      .get('U001');
    expect(row).toBeUndefined();
  });

  it('is idempotent on non-existent user', () => {
    expect(() => store.deleteUserToken('U_NONEXISTENT')).not.toThrow();
  });
});

describe('UserTokenStore.markTokenExpired', () => {
  it('causes getValidTokenForUser to return null', () => {
    store.storeUserToken(
      'U001',
      makeTokenResponse(3600),
      'sub-1',
      'alice@example.com',
    );
    expect(store.getValidTokenForUser('U001')).toBe('eyJ.access.token');

    store.markTokenExpired('U001');
    expect(store.getValidTokenForUser('U001')).toBeNull();
  });

  it('keeps the row in the database (for audit)', () => {
    store.storeUserToken(
      'U001',
      makeTokenResponse(3600),
      'sub-1',
      'alice@example.com',
    );
    store.markTokenExpired('U001');
    const row = db
      .prepare(`SELECT * FROM user_tokens WHERE slack_user_id = ?`)
      .get('U001');
    expect(row).toBeTruthy();
  });
});
