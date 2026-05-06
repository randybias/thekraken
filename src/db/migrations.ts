/**
 * SQLite migration runner for The Kraken.
 *
 * Single initial schema (SCHEMA_V1). All connections must have
 * PRAGMA foreign_keys = ON enforced here.
 */
import Database from 'better-sqlite3';
import { SCHEMA_V1, SCHEMA_V2, SECRETS_SCHEMA_V1 } from './schema.js';

/**
 * Apply the initial schema to a database connection.
 *
 * Sets PRAGMA journal_mode = WAL and PRAGMA foreign_keys = ON before
 * executing the schema DDL. Safe to call on both new and existing DBs
 * (uses CREATE TABLE IF NOT EXISTS throughout).
 *
 * @param db - An open better-sqlite3 Database instance.
 */
export function applyMigrations(db: Database.Database): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_V1);
  // V2: change_summaries cache table (G4 — git-state recovery).
  db.exec(SCHEMA_V2);
  // rc.11: user_tokens migrated out to kraken-secrets.db. Drop the legacy
  // table from the non-sensitive DB on first boot. Idempotent; users
  // re-auth naturally per design (no data migration). Spec:
  // docs/superpowers/specs/2026-05-06-rc11-token-and-session-state-design.md
  db.exec('DROP TABLE IF EXISTS user_tokens');
}

/**
 * Open (or create) a SQLite database at the given path and apply migrations.
 *
 * Use this factory everywhere instead of calling `new Database()` directly
 * to ensure PRAGMA foreign_keys = ON is always set.
 *
 * @param path - File path for the database. Defaults to ':memory:'.
 * @returns An open, migrated Database instance.
 */
export function createDatabase(path: string = ':memory:'): Database.Database {
  const db = new Database(path);
  applyMigrations(db);
  return db;
}

/**
 * Apply the secrets schema to a database connection.
 *
 * Sets PRAGMA journal_mode = WAL before executing SECRETS_SCHEMA_V1.
 * No foreign_keys needed — the secrets DB has a single table with no FKs.
 *
 * @param db - An open better-sqlite3 Database instance.
 */
export function applySecretsMigrations(db: Database.Database): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SECRETS_SCHEMA_V1);
}

/**
 * Open (or create) a SQLite secrets database at the given path and apply
 * the secrets schema.
 *
 * Use this factory for kraken-secrets.db. The caller is responsible for
 * setting mode 0600 on the resulting file (initSecretsDatabase does this).
 *
 * @param path - File path for the database. Defaults to ':memory:'.
 * @returns An open, migrated Database instance.
 */
export function createSecretsDatabase(
  path: string = ':memory:',
): Database.Database {
  const db = new Database(path);
  applySecretsMigrations(db);
  return db;
}
