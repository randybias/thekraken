/**
 * Tests for the kraken.db / kraken-secrets.db split introduced in rc.11.
 *
 * These tests use real files on disk because file-mode (0600) is part of the
 * contract. Each test gets a fresh temp directory and cleans up after itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { initDatabase, initSecretsDatabase } from '../../../src/db/index.js';
import type { KrakenConfig } from '../../../src/config.js';

/**
 * Build a minimal KrakenConfig for testing. Only the gitState.dir field
 * matters here — initDatabase and initSecretsDatabase derive their file
 * paths from path.dirname(config.gitState.dir).
 */
function makeConfig(dataDir: string): KrakenConfig {
  return {
    slack: {
      botToken: 'xoxb-test',
      mode: 'http',
      signingSecret: 'signing-secret',
    },
    oidc: {
      issuer: 'https://example.com/auth/realms/test',
      clientId: 'test-client',
      clientSecret: 'test-secret',
    },
    mcp: {
      url: 'http://localhost:8080',
      port: 8080,
    },
    cluster: {
      name: 'test-cluster',
    },
    llm: {
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
      allowedProviders: ['anthropic'],
      allowedModels: {},
      disallowedModels: [],
      anthropicApiKey: 'sk-ant-test',
    },
    gitState: {
      repoUrl: 'https://example.com/tentacles.git',
      branch: 'main',
      dir: join(dataDir, 'git-state'),
    },
    chroma: {
      baseUrl: '',
    },
    teamsDir: join(dataDir, 'teams'),
    server: {
      port: 3000,
    },
    observability: {
      otlpEndpoint: '',
      logLevel: 'info',
    },
  } as KrakenConfig;
}

describe('DB split (rc.11)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kraken-db-split-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('main DB does NOT contain user_tokens table', () => {
    const db = initDatabase(makeConfig(dir));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    db.close();
    expect(tables.map((t) => t.name)).not.toContain('user_tokens');
  });

  it('secrets DB contains user_tokens table', () => {
    const sdb = initSecretsDatabase(makeConfig(dir));
    const tables = sdb
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    sdb.close();
    expect(tables.map((t) => t.name)).toContain('user_tokens');
  });

  it('secrets DB file has mode 0600', () => {
    const sdb = initSecretsDatabase(makeConfig(dir));
    sdb.close();
    const stat = statSync(join(dir, 'kraken-secrets.db'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('legacy user_tokens table in main DB is dropped on initDatabase', () => {
    // Pre-seed kraken.db with the legacy user_tokens table to simulate
    // a PVC that pre-dates the rc.11 split.
    const dbPath = join(dir, 'kraken.db');
    const seed = new Database(dbPath);
    seed.exec(
      `CREATE TABLE user_tokens (
        slack_user_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        keycloak_sub TEXT NOT NULL,
        email TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
    );
    seed.close();

    const db = initDatabase(makeConfig(dir));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    db.close();
    expect(tables.map((t) => t.name)).not.toContain('user_tokens');
  });
});
