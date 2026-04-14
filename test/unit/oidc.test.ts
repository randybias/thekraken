import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initTokenStore } from '../../src/auth/tokens.js';

describe('oidc', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
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

  function insertTokenRow(
    slackUserId: string,
    overrides: {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
      keycloak_sub?: string;
      email?: string;
      updated_at?: string;
    } = {},
  ): void {
    db.prepare(
      `INSERT INTO user_tokens (slack_user_id, access_token, refresh_token, expires_at, keycloak_sub, email, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      slackUserId,
      overrides.access_token ?? 'at',
      overrides.refresh_token ?? 'rt',
      overrides.expires_at ?? Date.now() + 3600_000,
      overrides.keycloak_sub ?? 'sub',
      overrides.email ?? 'user@example.com',
      overrides.updated_at ?? new Date().toISOString(),
    );
  }

  describe('storeTokenForUser', () => {
    it('stores a token and computes expires_at from expires_in', async () => {
      const { storeTokenForUser } = await import('../../src/auth/oidc.js');
      const before = Date.now();
      storeTokenForUser('U_TEST', {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        token_type: 'Bearer',
      });
      const { getUserToken } = await import('../../src/auth/tokens.js');
      const stored = getUserToken('U_TEST');
      expect(stored).toBeDefined();
      expect(stored!.access_token).toBe('at');
      expect(stored!.expires_at).toBeGreaterThanOrEqual(
        before + 3600_000 - 1000,
      );
    });
  });

  describe('getValidTokenForUser', () => {
    it('returns null for unknown user', async () => {
      const { getValidTokenForUser } = await import('../../src/auth/oidc.js');
      expect(await getValidTokenForUser('U_NOBODY')).toBeNull();
    });

    it('returns access_token when not expired', async () => {
      const { storeTokenForUser, getValidTokenForUser } =
        await import('../../src/auth/oidc.js');
      storeTokenForUser('U_FRESH', {
        access_token: 'fresh_at',
        refresh_token: 'fresh_rt',
        expires_in: 3600,
        token_type: 'Bearer',
      });
      expect(await getValidTokenForUser('U_FRESH')).toBe('fresh_at');
    });

    it('returns null when token expired and refresh fails', async () => {
      // Insert a token that is already expired with an invalid refresh_token.
      // getValidTokenForUser will attempt refreshToken(), which calls fetch()
      // against a non-existent OIDC server, catch the error, and return null.
      insertTokenRow('U_EXPIRED', {
        access_token: 'old_at',
        refresh_token: 'invalid_rt',
        expires_at: Date.now() - 60_000, // expired 1 minute ago
      });

      const { getValidTokenForUser } = await import('../../src/auth/oidc.js');
      const token = await getValidTokenForUser('U_EXPIRED');
      expect(token).toBeNull();
    });

    it('returns null when 30-second expiry buffer makes token appear expired', async () => {
      // Token expires in 20 seconds — less than EXPIRY_BUFFER_MS (30s).
      // The code treats this as expired and attempts a refresh, which fails.
      insertTokenRow('U_BUFFER', {
        access_token: 'buffer_at',
        refresh_token: 'invalid_rt',
        expires_at: Date.now() + 20_000,
      });

      const { getValidTokenForUser } = await import('../../src/auth/oidc.js');
      const token = await getValidTokenForUser('U_BUFFER');
      expect(token).toBeNull();
    });

    it('returns null when 12-hour session window is exceeded', async () => {
      // Insert a token whose updated_at is 13 hours ago.
      // Even though expires_at is in the future, the session window check
      // should return null without attempting a refresh.
      const thirteenHoursAgo = new Date(
        Date.now() - 13 * 60 * 60 * 1000,
      ).toISOString();
      insertTokenRow('U_OLD_SESSION', {
        access_token: 'at_old',
        refresh_token: 'rt_old',
        expires_at: Date.now() + 3600_000, // not expired by Keycloak standards
        updated_at: thirteenHoursAgo,
      });

      const { getValidTokenForUser } = await import('../../src/auth/oidc.js');
      const token = await getValidTokenForUser('U_OLD_SESSION');
      expect(token).toBeNull();
    });
  });

  describe('extractEmailFromToken', () => {
    it('extracts email from JWT payload', async () => {
      const { extractEmailFromToken } = await import('../../src/auth/oidc.js');
      const payload = Buffer.from(
        JSON.stringify({ email: 'alice@example.com', sub: '123' }),
      ).toString('base64url');
      expect(extractEmailFromToken(`header.${payload}.signature`)).toBe(
        'alice@example.com',
      );
    });

    it('returns undefined for invalid JWT', async () => {
      const { extractEmailFromToken } = await import('../../src/auth/oidc.js');
      expect(extractEmailFromToken('not-a-jwt')).toBeUndefined();
    });
  });
});
