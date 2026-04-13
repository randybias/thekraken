/**
 * Database barrel export and config-aware factory.
 */
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { KrakenConfig } from '../config.js';
import { createDatabase } from './migrations.js';

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
