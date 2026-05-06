import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../../src/db/migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLI = path.resolve(__dirname, '../../../src/cli/kraken-db.ts');

interface CliResult {
  stdout: string;
  status: number;
}

function runCli(dir: string, args: string[]): CliResult {
  try {
    const stdout = execFileSync('npx', ['tsx', CLI, ...args], {
      env: { ...process.env, KRAKEN_DATA_DIR: dir },
      encoding: 'utf8',
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer; status?: number };
    return { stdout: e.stdout?.toString() ?? '', status: e.status ?? 1 };
  }
}

function seedKrakenDb(dir: string): Database.Database {
  const db = new Database(path.join(dir, 'kraken.db'));
  applyMigrations(db);
  return db;
}

function seedBindings(db: Database.Database): void {
  db.prepare(
    `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
     VALUES (?, ?, ?)`,
  ).run('C0AMY8XNBV2', 'tentacular-agensys', 'U123');
  db.prepare(
    `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
     VALUES (?, ?, ?)`,
  ).run('C9999', 'other-enclave', 'U456');
}

function seedDeployments(db: Database.Database): void {
  // First binding required so FK passes
  db.prepare(
    `INSERT OR IGNORE INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
     VALUES (?, ?, ?)`,
  ).run('C1', 'tentacular-agensys', 'U1');

  const insert = db.prepare(
    `INSERT INTO deployments (enclave, tentacle, version, git_sha, git_tag,
       deploy_type, summary, deployed_by_email, triggered_by_channel,
       triggered_by_ts, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    'tentacular-agensys',
    'ai-news-digest',
    1,
    'sha1',
    'v1',
    'create',
    'first deploy',
    'rbias@mirantis.com',
    'C1',
    '1700000000.000000',
    '2026-05-01T00:00:00.000Z',
    'success',
  );
  insert.run(
    'tentacular-agensys',
    'ai-news-digest',
    2,
    'sha2',
    'v2',
    'update',
    'fix prompt',
    'rbias@mirantis.com',
    'C1',
    '1700000100.000000',
    '2026-05-02T00:00:00.000Z',
    'success',
  );
}

describe('kraken-db CLI', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kraken-db-cli-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('lookup-channel', () => {
    it('returns binding as JSON for known channel', () => {
      const db = seedKrakenDb(dir);
      seedBindings(db);
      db.close();

      const { stdout, status } = runCli(dir, [
        'lookup-channel',
        'C0AMY8XNBV2',
      ]);
      expect(status).toBe(0);
      const result = JSON.parse(stdout) as {
        enclaveName: string;
        ownerSlackId: string;
      };
      expect(result.enclaveName).toBe('tentacular-agensys');
      expect(result.ownerSlackId).toBe('U123');
    });

    it('returns null for unknown channel', () => {
      const db = seedKrakenDb(dir);
      seedBindings(db);
      db.close();

      const { stdout, status } = runCli(dir, ['lookup-channel', 'CUNKNOWN']);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toBeNull();
    });

    it('returns null when DB does not exist', () => {
      const empty = mkdtempSync(join(tmpdir(), 'kraken-empty-'));
      try {
        const { stdout, status } = runCli(empty, [
          'lookup-channel',
          'C0AMY8XNBV2',
        ]);
        expect(status).toBe(0);
        expect(JSON.parse(stdout)).toBeNull();
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  describe('list-enclaves', () => {
    it('returns all bindings', () => {
      const db = seedKrakenDb(dir);
      seedBindings(db);
      db.close();

      const { stdout, status } = runCli(dir, ['list-enclaves']);
      expect(status).toBe(0);
      const result = JSON.parse(stdout) as Array<{ enclaveName: string }>;
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.enclaveName).sort()).toEqual([
        'other-enclave',
        'tentacular-agensys',
      ]);
    });

    it('--user filters by owner', () => {
      const db = seedKrakenDb(dir);
      seedBindings(db);
      db.close();

      const { stdout, status } = runCli(dir, [
        'list-enclaves',
        '--user',
        'U123',
      ]);
      expect(status).toBe(0);
      const result = JSON.parse(stdout) as Array<{ enclaveName: string }>;
      expect(result).toHaveLength(1);
      expect(result[0]!.enclaveName).toBe('tentacular-agensys');
    });
  });

  describe('recent-deployments', () => {
    it('returns rows newest first', () => {
      const db = seedKrakenDb(dir);
      seedDeployments(db);
      db.close();

      const { stdout, status } = runCli(dir, [
        'recent-deployments',
        'tentacular-agensys',
      ]);
      expect(status).toBe(0);
      const result = JSON.parse(stdout) as Array<{
        version: number;
        summary: string;
      }>;
      expect(result).toHaveLength(2);
      expect(result[0]!.version).toBe(2);
      expect(result[0]!.summary).toBe('fix prompt');
    });

    it('--tentacle filters', () => {
      const db = seedKrakenDb(dir);
      seedDeployments(db);
      db.close();

      const { stdout } = runCli(dir, [
        'recent-deployments',
        'tentacular-agensys',
        '--tentacle',
        'nonexistent',
      ]);
      expect(JSON.parse(stdout)).toEqual([]);
    });

    it('--limit caps row count', () => {
      const db = seedKrakenDb(dir);
      seedDeployments(db);
      db.close();

      const { stdout } = runCli(dir, [
        'recent-deployments',
        'tentacular-agensys',
        '--limit',
        '1',
      ]);
      expect(JSON.parse(stdout)).toHaveLength(1);
    });
  });

  describe('change-summary', () => {
    it('returns the latest deploy summary for (enclave, tentacle)', () => {
      const db = seedKrakenDb(dir);
      seedDeployments(db);
      db.close();

      const { stdout } = runCli(dir, [
        'change-summary',
        'tentacular-agensys',
        'ai-news-digest',
      ]);
      const result = JSON.parse(stdout) as { summary: string; version: number };
      expect(result.summary).toBe('fix prompt');
      expect(result.version).toBe(2);
    });

    it('returns null when no deploy exists for the pair', () => {
      const { stdout } = runCli(dir, ['change-summary', 'unknown', 'unknown']);
      expect(JSON.parse(stdout)).toBeNull();
    });
  });

  describe('error paths', () => {
    it('refuses unknown commands with non-zero exit', () => {
      const { status } = runCli(dir, ['DROP-TABLE', 'enclave_bindings']);
      expect(status).not.toBe(0);
    });

    it('refuses lookup-channel without arg', () => {
      const { status } = runCli(dir, ['lookup-channel']);
      expect(status).not.toBe(0);
    });
  });
});
