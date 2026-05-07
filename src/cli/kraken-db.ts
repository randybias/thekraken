#!/usr/bin/env node
/**
 * kraken-db — curated read-only query CLI for subprocess agents.
 *
 * Opens kraken.db in SQLite read-only mode and exposes a small,
 * hard-coded catalog of queries. Subprocesses (manager, dev teams)
 * call this from bash to read non-sensitive session state without
 * direct SQL access.
 *
 * Output: JSON to stdout. Errors: stderr + non-zero exit.
 *
 * Configuration: KRAKEN_DATA_DIR env var (defaults to /app/data).
 *
 * Spec: docs/superpowers/specs/2026-05-06-rc11-token-and-session-state-design.md
 */
import Database from 'better-sqlite3';
import { join } from 'node:path';

function openMainDb(): Database.Database | null {
  const dataDir = process.env['KRAKEN_DATA_DIR'] ?? '/app/data';
  const dbPath = join(dataDir, 'kraken.db');
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'SQLITE_CANTOPEN' || code === 'ENOENT') {
      // rc.13: by default, missing DB is an error. A broken volume
      // mount or wrong KRAKEN_DATA_DIR shouldn't look like "no data."
      // Set KRAKEN_DB_ALLOW_MISSING=1 to opt into silent empty.
      // Codex rescue finding #8.
      if (process.env['KRAKEN_DB_ALLOW_MISSING'] === '1') {
        return null;
      }
      process.stderr.write(
        `kraken-db: ${dbPath} not found. Set KRAKEN_DB_ALLOW_MISSING=1 to treat as empty.\n`,
      );
      process.exit(2);
    }
    throw err;
  }
}

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`kraken-db: ${message}\n`);
  process.exit(code);
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseFlags(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a !== undefined && a.startsWith('--')) {
      const key = a.slice(2);
      flags[key] = args[++i] ?? '';
    } else if (a !== undefined) {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// --- Commands -------------------------------------------------------------

function lookupChannel(channelId: string): unknown {
  const db = openMainDb();
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT channel_id, enclave_name, owner_slack_id, status, created_at
         FROM enclave_bindings
         WHERE channel_id = ? AND status = 'active'`,
      )
      .get(channelId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      channelId: row['channel_id'],
      enclaveName: row['enclave_name'],
      ownerSlackId: row['owner_slack_id'],
      status: row['status'],
      createdAt: row['created_at'],
    };
  } finally {
    db.close();
  }
}

function listEnclaves(userId?: string): unknown {
  const db = openMainDb();
  if (!db) return [];
  try {
    const sql = userId
      ? `SELECT channel_id, enclave_name, owner_slack_id, status, created_at
         FROM enclave_bindings
         WHERE owner_slack_id = ? AND status = 'active'
         ORDER BY enclave_name`
      : `SELECT channel_id, enclave_name, owner_slack_id, status, created_at
         FROM enclave_bindings
         WHERE status = 'active'
         ORDER BY enclave_name`;
    const rows = (
      userId ? db.prepare(sql).all(userId) : db.prepare(sql).all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      channelId: row['channel_id'],
      enclaveName: row['enclave_name'],
      ownerSlackId: row['owner_slack_id'],
      status: row['status'],
      createdAt: row['created_at'],
    }));
  } finally {
    db.close();
  }
}

function recentDeployments(
  enclave: string,
  opts: { tentacle?: string; limit?: string },
): unknown {
  const db = openMainDb();
  if (!db) return [];
  try {
    const rawLimit = parseInt(opts.limit ?? '20', 10);
    const limit = Math.max(
      1,
      Math.min(Number.isFinite(rawLimit) ? rawLimit : 20, 200),
    );
    const params: unknown[] = [enclave];
    let sql = `SELECT id, enclave, tentacle, version, git_sha, git_tag, deploy_type,
                      summary, deployed_by_email, triggered_by_channel,
                      triggered_by_ts, created_at, status
               FROM deployments WHERE enclave = ?`;
    if (opts.tentacle) {
      sql += ` AND tentacle = ?`;
      params.push(opts.tentacle);
    }
    sql += ` ORDER BY id DESC LIMIT ${limit}`;
    const rows = db.prepare(sql).all(...params) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: row['id'],
      enclave: row['enclave'],
      tentacle: row['tentacle'],
      version: row['version'],
      gitSha: row['git_sha'],
      gitTag: row['git_tag'],
      deployType: row['deploy_type'],
      summary: row['summary'],
      deployedByEmail: row['deployed_by_email'],
      triggeredByChannel: row['triggered_by_channel'],
      triggeredByTs: row['triggered_by_ts'],
      createdAt: row['created_at'],
      status: row['status'],
    }));
  } finally {
    db.close();
  }
}

/**
 * Latest deploy summary for (enclave, tentacle). Read from deployments —
 * the change_summaries table is keyed by SHA pairs and isn't the right
 * surface for "last change" by tentacle.
 */
function changeSummary(enclave: string, tentacle: string): unknown {
  const db = openMainDb();
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT version, summary, deployed_by_email, created_at
         FROM deployments WHERE enclave = ? AND tentacle = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(enclave, tentacle) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      version: row['version'],
      summary: row['summary'],
      deployedByEmail: row['deployed_by_email'],
      createdAt: row['created_at'],
    };
  } finally {
    db.close();
  }
}

const COMMANDS: Record<string, (args: string[]) => unknown> = {
  'lookup-channel': (args) => {
    if (args.length !== 1) fail('usage: lookup-channel <channelId>');
    return lookupChannel(args[0] ?? '');
  },
  'list-enclaves': (args) => {
    const { flags } = parseFlags(args);
    return listEnclaves(flags['user']);
  },
  'recent-deployments': (args) => {
    const { positional, flags } = parseFlags(args);
    if (positional.length !== 1) {
      fail('usage: recent-deployments <enclave> [--tentacle X] [--limit N]');
    }
    return recentDeployments(positional[0] ?? '', {
      tentacle: flags['tentacle'],
      limit: flags['limit'],
    });
  },
  'change-summary': (args) => {
    if (args.length !== 2) fail('usage: change-summary <enclave> <tentacle>');
    return changeSummary(args[0] ?? '', args[1] ?? '');
  },
};

function main(argv: string[]): void {
  const [, , cmd, ...rest] = argv;
  if (!cmd || !(cmd in COMMANDS)) {
    fail(
      `unknown command: ${cmd ?? '(none)'}; known: ${Object.keys(COMMANDS).join(', ')}`,
    );
  }
  try {
    out(COMMANDS[cmd]!(rest));
  } catch (err) {
    fail(`${cmd} failed: ${(err as Error).message}`);
  }
}

main(process.argv);
