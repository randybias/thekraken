/**
 * Per-user OIDC token storage.
 *
 * Backed by the kraken-secrets.db SQLite file (mode 0600), separate
 * from kraken.db so subprocess agents that read the main DB cannot
 * reach OAuth tokens at the OS layer (rc.11 defense-in-depth split).
 *
 * The table is created by src/db/migrations.ts applySecretsMigrations()
 * via initSecretsDatabase() on startup. Spec:
 * docs/superpowers/specs/2026-05-06-rc11-token-and-session-state-design.md
 */
import type Database from 'better-sqlite3';

export interface StoredToken {
  slack_user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  keycloak_sub: string;
  email: string;
  updated_at: string;
}

export interface TokenInput {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  keycloak_sub: string;
  email: string;
}

let db: Database.Database;

export function initTokenStore(database: Database.Database): void {
  db = database;
}

export function getUserToken(slackUserId: string): StoredToken | undefined {
  return db
    .prepare(
      `SELECT slack_user_id, access_token, refresh_token,
            expires_at, keycloak_sub, email, updated_at
     FROM user_tokens WHERE slack_user_id = ?`,
    )
    .get(slackUserId) as StoredToken | undefined;
}

export function setUserToken(slackUserId: string, token: TokenInput): void {
  db.prepare(
    `INSERT INTO user_tokens (slack_user_id, access_token, refresh_token, expires_at, keycloak_sub, email, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(slack_user_id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       keycloak_sub = excluded.keycloak_sub,
       email = excluded.email,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(
    slackUserId,
    token.access_token,
    token.refresh_token,
    token.expires_at,
    token.keycloak_sub,
    token.email,
  );
}

export function deleteUserToken(slackUserId: string): void {
  db.prepare('DELETE FROM user_tokens WHERE slack_user_id = ?').run(
    slackUserId,
  );
}

export function getAllUserTokens(): StoredToken[] {
  return db
    .prepare(
      `SELECT slack_user_id, access_token, refresh_token,
            expires_at, keycloak_sub, email, updated_at
     FROM user_tokens`,
    )
    .all() as StoredToken[];
}
