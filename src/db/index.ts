/**
 * Database barrel export and config-aware factory.
 */
import path from 'node:path';
import { chmodSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { KrakenConfig } from '../config.js';
import { createDatabase, createSecretsDatabase } from './migrations.js';

export * from './schema.js';
export * from './migrations.js';

/**
 * Open the application SQLite database at the path derived from config.
 *
 * The database file lives next to the git-state directory on the shared
 * PVC: /app/data/kraken.db by default.
 *
 * @param config - Loaded KrakenConfig.
 * @returns An open, migrated Database instance.
 */
export function initDatabase(config: KrakenConfig): Database.Database {
  // Derive db path: sibling of git-state dir (e.g. /app/data/kraken.db)
  const dbPath = path.join(path.dirname(config.gitState.dir), 'kraken.db');
  return createDatabase(dbPath);
}

/**
 * Open (or create) the OAuth token store at the path derived from config.
 *
 * The file lives in the same parent directory as kraken.db (the shared PVC):
 * /app/data/kraken-secrets.db by default. It is chmoded to 0600 as
 * defense-in-depth so that subprocess agents reading kraken.db cannot
 * reach OAuth tokens even if they traverse the mount. Some container
 * filesystems (overlayfs, tmpfs) are chmod no-ops; the try/catch ensures
 * the failure is non-fatal and logged but does not abort startup.
 *
 * @param config - Loaded KrakenConfig.
 * @returns An open, migrated Database instance backed by SECRETS_SCHEMA_V1.
 */
export function initSecretsDatabase(config: KrakenConfig): Database.Database {
  // Derive secrets db path: sibling of git-state dir (e.g. /app/data/kraken-secrets.db)
  const secretsPath = path.join(
    path.dirname(config.gitState.dir),
    'kraken-secrets.db',
  );
  const db = createSecretsDatabase(secretsPath);
  try {
    chmodSync(secretsPath, 0o600);
  } catch {
    // Best-effort: some filesystems (overlayfs, in-memory) are chmod no-ops.
    // Log to stderr so ops can see it without aborting startup.
    process.stderr.write(
      `[warn] initSecretsDatabase: chmodSync(${secretsPath}, 0o600) failed (non-fatal)\n`,
    );
  }
  return db;
}
