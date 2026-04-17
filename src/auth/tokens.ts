/**
 * Per-user OIDC token storage backed by SQLite user_tokens table.
 * The table is created by src/db/schema.ts on startup.
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

/**
 * Look up a stored token by the user's email address.
 * Used to resolve an enclave owner's email (from MCP metadata) to their
 * Slack user ID so that owner attribution in enclave bindings is correct.
 * Returns undefined if no matching token row exists.
 */
export function getUserTokenByEmail(email: string): StoredToken | undefined {
  return db
    .prepare(
      `SELECT slack_user_id, access_token, refresh_token,
            expires_at, keycloak_sub, email, updated_at
     FROM user_tokens WHERE email = ?`,
    )
    .get(email) as StoredToken | undefined;
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
