/**
 * SQLite migration runner for The Kraken.
 *
 * Single initial schema (SCHEMA_V1). All connections must have
 * PRAGMA foreign_keys = ON enforced here.
 */
import Database from 'better-sqlite3';
import { SCHEMA_V1 } from './schema.js';

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
