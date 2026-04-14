/**
 * Per-user OIDC token storage with AES-256-GCM encryption at rest.
 *
 * Wraps the user_tokens SQLite table. Every read/write boundary
 * encrypts/decrypts access_token and refresh_token via crypto.ts.
 *
 * Session window: 12-hour hard cap from created_at (not updated_at).
 * This limits the blast radius if a token is compromised.
 */

import type Database from 'better-sqlite3';
import { encrypt, decrypt } from './crypto.js';
import type { TokenResponse } from './oidc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 12-hour session window enforced from token creation (device flow). */
export const SESSION_WINDOW_MS = 12 * 60 * 60 * 1000;

/** 30-second clock-skew buffer before expiry. */
const EXPIRY_BUFFER_MS = 30_000;

// ---------------------------------------------------------------------------
// Row type (raw SQLite output)
// ---------------------------------------------------------------------------

interface UserTokenRow {
  slack_user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  keycloak_sub: string;
  email: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// UserTokenStore
// ---------------------------------------------------------------------------

/**
 * Manages per-user OIDC tokens with encryption at rest.
 *
 * All access_token and refresh_token values are stored as
 * AES-256-GCM ciphertexts (iv:ciphertext:authTag hex strings).
 */
export class UserTokenStore {
  constructor(
    private readonly db: Database.Database,
    private readonly encryptionKey: Buffer,
  ) {}

  /**
   * Store a token set for a Slack user. Encrypts access_token and
   * refresh_token before writing.
   *
   * Uses INSERT OR REPLACE — if the user already has a row, it is
   * overwritten. This is correct because each user has exactly one
   * active session.
   *
   * Note: created_at is set only on initial INSERT (not on REPLACE of
   * an existing row) to preserve the 12-hour session window anchor.
   * We achieve this by doing a SELECT-then-INSERT-or-UPDATE pattern.
   */
  storeUserToken(
    slackUserId: string,
    tokens: TokenResponse,
    keycloakSub: string,
    email: string,
  ): void {
    const expiresAt = new Date(
      Date.now() + tokens.expires_in * 1000,
    ).toISOString();
    const encryptedAccess = encrypt(tokens.access_token, this.encryptionKey);
    const encryptedRefresh = encrypt(tokens.refresh_token, this.encryptionKey);

    // Check if row exists to preserve created_at
    const existing = this.db
      .prepare(`SELECT created_at FROM user_tokens WHERE slack_user_id = ?`)
      .get(slackUserId) as { created_at: string } | undefined;

    if (existing) {
      // UPDATE — preserve created_at (session window anchor)
      this.db
        .prepare(
          `UPDATE user_tokens
           SET access_token = ?, refresh_token = ?, expires_at = ?,
               keycloak_sub = ?, email = ?
           WHERE slack_user_id = ?`,
        )
        .run(
          encryptedAccess,
          encryptedRefresh,
          expiresAt,
          keycloakSub,
          email,
          slackUserId,
        );
    } else {
      // INSERT — created_at defaults to now()
      this.db
        .prepare(
          `INSERT INTO user_tokens
             (slack_user_id, access_token, refresh_token, expires_at,
              keycloak_sub, email)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          slackUserId,
          encryptedAccess,
          encryptedRefresh,
          expiresAt,
          keycloakSub,
          email,
        );
    }
  }

  /**
   * Return a valid (non-expired) access token for a Slack user, or null.
   *
   * Checks:
   *   1. Row exists
   *   2. created_at within 12-hour session window (deletes row + returns null)
   *   3. expires_at not past (with 30s buffer; returns null for caller to refresh)
   *
   * Decrypts access_token before returning.
   */
  getValidTokenForUser(slackUserId: string): string | null {
    const row = this.db
      .prepare(`SELECT * FROM user_tokens WHERE slack_user_id = ?`)
      .get(slackUserId) as UserTokenRow | undefined;

    if (!row) return null;

    // Check 2: 12-hour session window from created_at
    const createdAt = new Date(row.created_at).getTime();
    if (Date.now() - createdAt > SESSION_WINDOW_MS) {
      this.deleteUserToken(slackUserId);
      return null;
    }

    // Check 3: expires_at with buffer
    const expiresAt = new Date(row.expires_at).getTime();
    if (expiresAt - Date.now() < EXPIRY_BUFFER_MS) {
      // Token expired — caller should attempt refresh
      return null;
    }

    return decrypt(row.access_token, this.encryptionKey);
  }

  /**
   * Return all rows where the access token will expire within thresholdMs
   * AND the 12-hour session window has not elapsed.
   *
   * Used by the refresh loop. Returns decrypted refresh_tokens.
   *
   * @param thresholdMs - Refresh tokens expiring within this many ms.
   */
  getRefreshableTokens(thresholdMs: number): Array<{
    slackUserId: string;
    refreshToken: string;
    expiresAt: number;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM user_tokens`)
      .all() as UserTokenRow[];

    const now = Date.now();
    const result: Array<{
      slackUserId: string;
      refreshToken: string;
      expiresAt: number;
      createdAt: number;
    }> = [];

    for (const row of rows) {
      const createdAt = new Date(row.created_at).getTime();
      // Skip rows past session window
      if (now - createdAt > SESSION_WINDOW_MS) continue;

      const expiresAt = new Date(row.expires_at).getTime();
      // Only include tokens expiring soon
      if (expiresAt - now < thresholdMs) {
        try {
          const refreshToken = decrypt(row.refresh_token, this.encryptionKey);
          result.push({
            slackUserId: row.slack_user_id,
            refreshToken,
            expiresAt,
            createdAt,
          });
        } catch {
          // Skip rows with corrupted tokens — they will be caught by auth gate
        }
      }
    }

    return result;
  }

  /**
   * Delete a user's token row entirely.
   * Called on session window expiry or explicit logout.
   */
  deleteUserToken(slackUserId: string): void {
    this.db
      .prepare(`DELETE FROM user_tokens WHERE slack_user_id = ?`)
      .run(slackUserId);
  }

  /**
   * Mark a token as expired by setting expires_at to now.
   * Called when refresh fails — the row stays for audit but
   * getValidTokenForUser will return null.
   */
  markTokenExpired(slackUserId: string): void {
    const now = new Date(Date.now() - EXPIRY_BUFFER_MS * 2).toISOString();
    this.db
      .prepare(`UPDATE user_tokens SET expires_at = ? WHERE slack_user_id = ?`)
      .run(now, slackUserId);
  }
}
