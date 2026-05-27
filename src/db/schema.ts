/**
 * The Kraken SQLite schema (kraken.db).
 *
 * Applied once on fresh install. Uses CREATE TABLE IF NOT EXISTS throughout.
 * The four tables represent non-sensitive operational state:
 *   - enclave_bindings: Slack channel <-> enclave mapping (FK target)
 *   - outbound_messages: sent message dedup log (no FK — covers DMs too)
 *   - deployments: tentacle deploy history (FK -> enclave_bindings.enclave_name)
 *   - thread_sessions: per-thread pi agent sessions (FK -> enclave_bindings.enclave_name)
 *
 * NOTE: user_tokens has been moved to SECRETS_SCHEMA_V1 (kraken-secrets.db, mode 0600)
 * so that subprocess agents reading kraken.db cannot reach OAuth tokens.
 * See docs/superpowers/specs/2026-05-06-rc11-token-and-session-state-design.md.
 */

export const SCHEMA_V1 = `
-- The Kraken schema v1
-- Applied once on fresh install.
-- NOTE: user_tokens lives in kraken-secrets.db (SECRETS_SCHEMA_V1), not here.

CREATE TABLE IF NOT EXISTS enclave_bindings (
  channel_id TEXT PRIMARY KEY,
  enclave_name TEXT NOT NULL UNIQUE,
  owner_slack_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS outbound_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  thread_ts TEXT,
  message_ts TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_outbound_messages_channel
  ON outbound_messages(channel_id, thread_ts);

CREATE INDEX IF NOT EXISTS idx_outbound_messages_hash
  ON outbound_messages(content_hash);

CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enclave TEXT NOT NULL,
  tentacle TEXT NOT NULL,
  version INTEGER NOT NULL,
  git_sha TEXT NOT NULL,
  git_tag TEXT NOT NULL,
  deploy_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT,
  deployed_by_email TEXT NOT NULL,
  triggered_by_channel TEXT NOT NULL,
  triggered_by_ts TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status TEXT NOT NULL DEFAULT 'pending',
  status_detail TEXT,
  UNIQUE(enclave, tentacle, version),
  FOREIGN KEY (enclave) REFERENCES enclave_bindings(enclave_name)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deployments_tentacle
  ON deployments(enclave, tentacle);

CREATE INDEX IF NOT EXISTS idx_deployments_created
  ON deployments(created_at DESC);

CREATE TABLE IF NOT EXISTS thread_sessions (
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_slack_id TEXT NOT NULL,
  enclave_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_active_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (channel_id, thread_ts),
  FOREIGN KEY (enclave_name) REFERENCES enclave_bindings(enclave_name)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_thread_sessions_user
  ON thread_sessions(user_slack_id);

CREATE INDEX IF NOT EXISTS idx_thread_sessions_enclave
  ON thread_sessions(enclave_name);
`;

/**
 * Schema for the secrets database (kraken-secrets.db).
 *
 * Opened with mode 0600. Holds OAuth access + refresh tokens. NOT
 * readable by subprocess agents — split out for defense in depth
 * (rc.11). See docs/superpowers/specs/2026-05-06-rc11-token-and-session-state-design.md.
 */
export const SECRETS_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS user_tokens (
  slack_user_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  keycloak_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

/**
 * Schema v2: cross-version change summary cache (G4).
 *
 * Caches manager-composed plain-English summaries of the diff between
 * two git SHAs. Primary key is (sha_a, sha_b) — ordered by convention
 * (older first). INSERT OR REPLACE handles idempotent updates.
 */
export const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS change_summaries (
  sha_a TEXT NOT NULL,
  sha_b TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (sha_a, sha_b)
);
`;

/**
 * Schema v3: NDJSON byte-offset cursors (rc.13).
 *
 * Persists the read offset for each NDJSON file the dispatcher consumes,
 * keyed by (enclave_name, filename). On pod restart, readers resume from
 * the stored offset — no data loss (prior pod crashed mid-record), no
 * replay (we don't re-process bytes already past the cursor).
 *
 * filename is the basename of the file relative to the team dir, e.g.
 * 'mailbox.ndjson', 'outbound.ndjson', 'signals-out.ndjson',
 * 'signals-in.ndjson'.
 *
 * Replaces the rc.11/rc.12 startAtEnd-on-construction pattern (which
 * caused data loss per codex rescue findings #1 and #2).
 */
export const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS ndjson_cursors (
  enclave_name TEXT NOT NULL,
  filename TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (enclave_name, filename)
);
`;

/**
 * Schema v4: kraken_threads — tracks threads where the bot was @-mentioned
 * at the top level. Used by the message handler to forward non-@-mention
 * thread replies to the dispatcher only when the thread is "owned" by the
 * Kraken (started by a bot @-mention). Rows older than 7 days are pruned
 * at boot.
 */
export const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS kraken_threads (
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);

CREATE INDEX IF NOT EXISTS idx_kraken_threads_created_at
  ON kraken_threads(created_at);
`;
