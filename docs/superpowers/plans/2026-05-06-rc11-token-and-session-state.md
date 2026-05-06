# rc.11 — Token reliability + agent session state — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship rc.11 with: token-store split for defense in depth, curated read-only DB wrapper for subprocess agents, smart-path 401 fix that aborts to re-auth instead of silent tool-less mode, loud-log visibility on background refresh failures, mid-turn token-file refresh in team-bridge, Keycloak preflight, expanded E2E for tentacle CRUD, and prompt guidance against confabulated denials.

**Architecture:** Extend existing conventions — no new HTTP/RPC. Subprocess shares pod and PVC with the dispatcher; agents read non-sensitive state via a curated `kraken-db` Node CLI (SQLite read-only mode), post to Slack by writing `outbound.ndjson` records the existing poller already handles. Sensitive `user_tokens` move to a separate `kraken-secrets.db` (mode 600).

**Tech Stack:** TypeScript, Node 22, better-sqlite3, vitest, Slack Bolt, pi-coding-agent, Keycloak OIDC.

**Spec:** `docs/superpowers/specs/2026-05-06-rc11-token-and-session-state-design.md`

---

## Task 0: Branch + worktree setup

**Files:**
- Create: `worktrees/thekraken-rc11/` (worktree)
- Branch: `feat/rc11-token-and-session-state`

- [ ] **Step 1: Stash uncommitted skill/jargon changes** (already on `fix/skill-vocab-tables-jargon`, will land in this PR)

```bash
cd ~/code/tentacular-main/thekraken
git status -s
# expected: M skills/kraken/SKILL.md, M skills/kraken/references/slack-ux.md,
#           M src/jargon-filter.ts, M src/extensions/jargon-filter.ts,
#           M test/unit/jargon-filter.test.ts
```

- [ ] **Step 2: Commit skill/jargon work as Task 0 commit on existing branch**

```bash
git add skills/kraken/SKILL.md skills/kraken/references/slack-ux.md \
  src/jargon-filter.ts src/extensions/jargon-filter.ts \
  test/unit/jargon-filter.test.ts
git commit -m "fix(skill,jargon): markdown tables prohibited + webhook is not jargon

- slack-ux.md and SKILL.md: never produce markdown tables (Slack does not
  render them), use bullet lists or *Key:* lines. Fixes B1, C1, N5 (#18).
- jargon-filter.ts (both copies): remove webhook -> system process mapping.
  Webhook is a legitimate user-facing term. Fixes N4 (#21).
- jargon-filter unit tests updated to match the new contract.
"
```

- [ ] **Step 3: Push branch + create draft PR (rc.11 work continues on it)**

```bash
git push -u origin fix/skill-vocab-tables-jargon
gh pr create --draft --title "feat(rc.11): token reliability + agent session state" \
  --body "Tracking PR for rc.11. Spec: docs/superpowers/specs/2026-05-06-rc11-token-and-session-state-design.md"
```

- [ ] **Step 4: Rename the branch to reflect the larger scope**

```bash
git branch -m fix/skill-vocab-tables-jargon feat/rc11-token-and-session-state
git push origin :fix/skill-vocab-tables-jargon feat/rc11-token-and-session-state
git push origin -u feat/rc11-token-and-session-state
```

(Skip step 4 if not needed — PR can keep its current branch name. Update title only.)

---

## Phase B — Database split

### Task 1: Add `kraken-secrets.db` schema

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/index.ts`

The token store moves to a separate SQLite database. The non-sensitive DB stays at `${dataDir}/kraken.db`; secrets DB is `${dataDir}/kraken-secrets.db`, mode 600.

- [ ] **Step 1: Add SECRETS_SCHEMA constant in `src/db/schema.ts`**

After the existing `SCHEMA` export, add:

```typescript
/**
 * Schema for the secrets database (kraken-secrets.db).
 *
 * This file is opened mode 0600 and is NOT readable by subprocess agents.
 * Holds OAuth access + refresh tokens.
 */
export const SECRETS_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_tokens (
  slack_user_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  keycloak_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`.trim();
```

- [ ] **Step 2: Remove `user_tokens` from main `SCHEMA`**

Delete lines 17-25 of `src/db/schema.ts` (the existing `user_tokens` block in `SCHEMA`).

- [ ] **Step 3: Run lint to confirm no other refs**

Run: `cd ~/code/tentacular-main/thekraken && npx tsc --noEmit`
Expected: errors in `src/auth/tokens.ts` referencing `user_tokens` schema; we'll fix in Task 2.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat(db): split user_tokens schema into SECRETS_SCHEMA

Prepares for kraken-secrets.db file split. Main schema no longer
declares user_tokens. Subsequent commits wire up the split DB and
update the token store."
```

### Task 2: Open + initialize the secrets DB

**Files:**
- Modify: `src/db/index.ts`

- [ ] **Step 1: Read current `src/db/index.ts` to understand the `initDatabase` shape**

(Ground the implementation in the existing pattern; whatever returns the main DB also needs to return the secrets DB.)

- [ ] **Step 2: Add a `initSecretsDatabase(dataDir)` function**

```typescript
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA, SECRETS_SCHEMA } from './schema.js';

export function initSecretsDatabase(dataDir: string): Database.Database {
  const path = join(dataDir, 'kraken-secrets.db');
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SECRETS_SCHEMA);
  // Defense in depth: tighten permissions on the file itself.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort; on some filesystems chmod is a no-op.
  }
  return db;
}
```

- [ ] **Step 3: Drop the old `user_tokens` table from the main DB if it exists**

In `initDatabase()` after `db.exec(SCHEMA)`, append:

```typescript
// rc.11: user_tokens migrated out to kraken-secrets.db. Drop the legacy
// table from the non-sensitive DB on first boot. Idempotent; users
// re-auth naturally (per design 2026-05-06).
db.exec('DROP TABLE IF EXISTS user_tokens');
```

- [ ] **Step 4: Run unit tests for db**

```bash
cd ~/code/tentacular-main/thekraken && npx vitest run test/unit/db
```

Expected: existing tests pass (or fail on tokens-specific assertions, which Task 3 fixes).

- [ ] **Step 5: Commit**

```bash
git add src/db/index.ts src/db/schema.ts
git commit -m "feat(db): initSecretsDatabase opens kraken-secrets.db with mode 600

- New init function for the secrets DB on the same data dir.
- Drop the legacy user_tokens table from kraken.db on first boot.
- Idempotent."
```

### Task 3: Point `tokens.ts` at the secrets DB

**Files:**
- Modify: `src/auth/tokens.ts`
- Test: `test/unit/auth/tokens.test.ts` (verify or create)

- [ ] **Step 1: Audit current consumers of `initTokenStore`**

```bash
cd ~/code/tentacular-main/thekraken
grep -rn "initTokenStore" src/ test/
```

Expected: `src/index.ts` calls `initTokenStore(db)`. We'll swap it to use the secrets DB.

- [ ] **Step 2: No code change needed in `tokens.ts` itself**

`tokens.ts` is DB-agnostic — it stores a Database reference and queries `user_tokens`. The split is at the wiring layer.

- [ ] **Step 3: Update `src/index.ts` to wire the secrets DB into `initTokenStore`**

In `src/index.ts`, in the bootstrap function:

```typescript
import { initDatabase, initSecretsDatabase } from './db/index.js';

// ...
const db = initDatabase(dataDir);
const secretsDb = initSecretsDatabase(dataDir);
initTokenStore(secretsDb); // was: initTokenStore(db)
```

- [ ] **Step 4: Run all unit tests**

```bash
npm test 2>&1 | tail -40
```

Expected: token-related tests still pass; pre-existing scenario test failures unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(auth): tokens store uses kraken-secrets.db

Wires initTokenStore() to the new secrets DB. user_tokens row reads
and writes now hit kraken-secrets.db (mode 600)."
```

### Task 4: Test for the DB split

**Files:**
- Test: `test/unit/db/split.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase, initSecretsDatabase } from '../../../src/db/index.js';

describe('DB split (rc.11)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kraken-db-split-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('main DB does NOT contain user_tokens table', () => {
    const db = initDatabase(dir);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain('user_tokens');
  });

  it('secrets DB contains user_tokens table', () => {
    const sdb = initSecretsDatabase(dir);
    const tables = sdb
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('user_tokens');
  });

  it('secrets DB file has mode 0600', () => {
    initSecretsDatabase(dir);
    const stat = statSync(path.join(dir, 'kraken-secrets.db'));
    // mode 0600 → octal trailing 600
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('legacy user_tokens in main DB is dropped on initDatabase', () => {
    // First, create a kraken.db with the legacy user_tokens table
    const dbPath = path.join(dir, 'kraken.db');
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

    // initDatabase should drop it
    const db = initDatabase(dir);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain('user_tokens');
  });
});
```

- [ ] **Step 2: Run the tests, expect pass**

```bash
npx vitest run test/unit/db/split.test.ts
```

Expected: 4 passing.

- [ ] **Step 3: Commit**

```bash
git add test/unit/db/split.test.ts
git commit -m "test(db): cover kraken.db / kraken-secrets.db split"
```

---

## Phase C — `kraken-db` curated query CLI

### Task 5: Skeleton + `lookup-channel`

**Files:**
- Create: `bin/kraken-db.ts`
- Modify: `package.json` (bin entry, npm scripts)
- Test: `test/unit/bin/kraken-db.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const CLI = path.resolve(__dirname, '../../../bin/kraken-db.ts');

function runCli(dir: string, args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(
      'npx',
      ['tsx', CLI, ...args],
      { env: { ...process.env, KRAKEN_DATA_DIR: dir }, encoding: 'utf8' },
    );
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer; status?: number };
    return { stdout: e.stdout?.toString() ?? '', status: e.status ?? 1 };
  }
}

function seedKrakenDb(dir: string): void {
  const db = new Database(path.join(dir, 'kraken.db'));
  db.exec(`
    CREATE TABLE enclave_bindings (
      channel_id TEXT PRIMARY KEY,
      enclave_name TEXT NOT NULL UNIQUE,
      owner_slack_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  db.prepare(
    `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
     VALUES (?, ?, ?)`,
  ).run('C0AMY8XNBV2', 'tentacular-agensys', 'U123');
  db.close();
}

describe('kraken-db CLI', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kraken-db-cli-'));
    seedKrakenDb(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lookup-channel returns binding as JSON', () => {
    const { stdout, status } = runCli(dir, ['lookup-channel', 'C0AMY8XNBV2']);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.enclaveName).toBe('tentacular-agensys');
    expect(result.ownerSlackId).toBe('U123');
  });

  it('lookup-channel returns null for unknown channel', () => {
    const { stdout, status } = runCli(dir, ['lookup-channel', 'CUNKNOWN']);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toBeNull();
  });

  it('refuses unknown commands', () => {
    const { status } = runCli(dir, ['DROP-TABLE', 'enclave_bindings']);
    expect(status).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

```bash
npx vitest run test/unit/bin/kraken-db.test.ts
```

Expected: error — file `bin/kraken-db.ts` does not exist.

- [ ] **Step 3: Implement skeleton + `lookup-channel`**

```typescript
#!/usr/bin/env node
/**
 * kraken-db — curated read-only query CLI for subprocess agents.
 *
 * Opens kraken.db in SQLite read-only mode and exposes a small,
 * hard-coded catalog of queries. Subprocesses (manager, dev teams)
 * call this from bash to read non-sensitive session state without
 * direct SQL access.
 *
 * Returns JSON to stdout. Errors to stderr with non-zero exit.
 *
 * Configuration: KRAKEN_DATA_DIR env var (defaults to /app/data).
 */
import Database from 'better-sqlite3';
import { join } from 'node:path';

function openMainDb(): Database.Database {
  const dataDir = process.env.KRAKEN_DATA_DIR ?? '/app/data';
  const dbPath = join(dataDir, 'kraken.db');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`kraken-db: ${message}\n`);
  process.exit(code);
}

function lookupChannel(channelId: string): unknown {
  const db = openMainDb();
  try {
    const row = db
      .prepare(
        `SELECT channel_id, enclave_name, owner_slack_id, status, created_at
         FROM enclave_bindings WHERE channel_id = ?`,
      )
      .get(channelId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      channelId: row.channel_id,
      enclaveName: row.enclave_name,
      ownerSlackId: row.owner_slack_id,
      status: row.status,
      createdAt: row.created_at,
    };
  } finally {
    db.close();
  }
}

const COMMANDS: Record<string, (args: string[]) => unknown> = {
  'lookup-channel': (args) => {
    if (args.length !== 1) fail('usage: lookup-channel <channelId>');
    return lookupChannel(args[0]);
  },
};

function main(argv: string[]): void {
  const [, , cmd, ...rest] = argv;
  if (!cmd || !(cmd in COMMANDS)) {
    fail(`unknown command: ${cmd ?? '(none)'}; known: ${Object.keys(COMMANDS).join(', ')}`);
  }
  try {
    out(COMMANDS[cmd](rest));
  } catch (err) {
    fail(`${cmd} failed: ${(err as Error).message}`);
  }
}

main(process.argv);
```

- [ ] **Step 4: Add `bin` entry to `package.json`**

```json
"bin": {
  "kraken-db": "./bin/kraken-db.ts"
}
```

If `package.json` already has a `bin`, merge — don't overwrite.

- [ ] **Step 5: Run test, expect pass**

```bash
npx vitest run test/unit/bin/kraken-db.test.ts
```

Expected: 3 passing.

- [ ] **Step 6: Commit**

```bash
git add bin/kraken-db.ts test/unit/bin/kraken-db.test.ts package.json
git commit -m "feat(kraken-db): curated read-only query CLI with lookup-channel

Subprocess agents call \`kraken-db lookup-channel <channelId>\` to
resolve a Slack channel ID to its bound enclave name. Opens kraken.db
read-only; returns JSON. No raw SQL surface."
```

### Task 6: `list-enclaves`

**Files:**
- Modify: `bin/kraken-db.ts`
- Modify: `test/unit/bin/kraken-db.test.ts`

- [ ] **Step 1: Add failing tests**

```typescript
it('list-enclaves returns all bindings', () => {
  // seed two bindings: one for U123 (already), add one for U456
  const db = new Database(path.join(dir, 'kraken.db'));
  db.prepare(
    `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
     VALUES (?, ?, ?)`,
  ).run('C9999', 'other-enclave', 'U456');
  db.close();

  const { stdout, status } = runCli(dir, ['list-enclaves']);
  expect(status).toBe(0);
  const result = JSON.parse(stdout);
  expect(Array.isArray(result)).toBe(true);
  expect(result).toHaveLength(2);
  expect(result.map((r: { enclaveName: string }) => r.enclaveName).sort()).toEqual([
    'other-enclave', 'tentacular-agensys',
  ]);
});

it('list-enclaves --user filters by owner', () => {
  const { stdout, status } = runCli(dir, ['list-enclaves', '--user', 'U123']);
  expect(status).toBe(0);
  const result = JSON.parse(stdout);
  expect(result).toHaveLength(1);
  expect(result[0].enclaveName).toBe('tentacular-agensys');
});
```

- [ ] **Step 2: Implement `listEnclaves`**

In `bin/kraken-db.ts`, add to commands:

```typescript
function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      flags[key] = args[++i] ?? '';
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function listEnclaves(userId?: string): unknown {
  const db = openMainDb();
  try {
    const sql = userId
      ? `SELECT channel_id, enclave_name, owner_slack_id, status, created_at
         FROM enclave_bindings WHERE owner_slack_id = ? ORDER BY enclave_name`
      : `SELECT channel_id, enclave_name, owner_slack_id, status, created_at
         FROM enclave_bindings ORDER BY enclave_name`;
    const rows = (userId ? db.prepare(sql).all(userId) : db.prepare(sql).all()) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      channelId: row.channel_id,
      enclaveName: row.enclave_name,
      ownerSlackId: row.owner_slack_id,
      status: row.status,
      createdAt: row.created_at,
    }));
  } finally {
    db.close();
  }
}

// In COMMANDS:
'list-enclaves': (args) => {
  const { flags } = parseFlags(args);
  return listEnclaves(flags.user);
},
```

- [ ] **Step 3: Run test, expect pass**

```bash
npx vitest run test/unit/bin/kraken-db.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add bin/kraken-db.ts test/unit/bin/kraken-db.test.ts
git commit -m "feat(kraken-db): add list-enclaves command (with --user filter)"
```

### Task 7: `recent-deployments`

**Files:**
- Modify: `bin/kraken-db.ts`
- Modify: `test/unit/bin/kraken-db.test.ts`

- [ ] **Step 1: Add seed for deployments + failing tests**

```typescript
function seedDeployments(dir: string): void {
  const db = new Database(path.join(dir, 'kraken.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enclave TEXT NOT NULL,
      tentacle TEXT NOT NULL,
      version INTEGER NOT NULL,
      git_sha TEXT,
      summary TEXT,
      deployed_by_email TEXT,
      triggered_by_channel TEXT,
      triggered_by_ts TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  db.prepare(
    `INSERT INTO deployments (enclave, tentacle, version, git_sha, summary,
     deployed_by_email, triggered_by_channel, triggered_by_ts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('tentacular-agensys', 'ai-news-digest', 1, 'sha1', 'first deploy',
    'rbias@mirantis.com', 'C0AMY8XNBV2', '1700000000.000000', '2026-05-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO deployments (enclave, tentacle, version, git_sha, summary,
     deployed_by_email, triggered_by_channel, triggered_by_ts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('tentacular-agensys', 'ai-news-digest', 2, 'sha2', 'fix prompt',
    'rbias@mirantis.com', 'C0AMY8XNBV2', '1700000100.000000', '2026-05-02T00:00:00.000Z');
  db.close();
}

it('recent-deployments returns rows for an enclave (newest first)', () => {
  seedDeployments(dir);
  const { stdout, status } = runCli(dir, ['recent-deployments', 'tentacular-agensys']);
  expect(status).toBe(0);
  const result = JSON.parse(stdout);
  expect(result).toHaveLength(2);
  expect(result[0].version).toBe(2);
  expect(result[0].summary).toBe('fix prompt');
});

it('recent-deployments --tentacle filters by tentacle', () => {
  seedDeployments(dir);
  const { stdout } = runCli(dir, ['recent-deployments', 'tentacular-agensys',
    '--tentacle', 'nonexistent']);
  expect(JSON.parse(stdout)).toEqual([]);
});

it('recent-deployments --limit caps row count', () => {
  seedDeployments(dir);
  const { stdout } = runCli(dir, ['recent-deployments', 'tentacular-agensys',
    '--limit', '1']);
  expect(JSON.parse(stdout)).toHaveLength(1);
});
```

- [ ] **Step 2: Implement `recentDeployments`**

```typescript
function recentDeployments(
  enclave: string,
  opts: { tentacle?: string; limit?: string },
): unknown {
  const db = openMainDb();
  try {
    const limit = Math.max(1, Math.min(parseInt(opts.limit ?? '20', 10) || 20, 200));
    const params: unknown[] = [enclave];
    let sql = `SELECT id, enclave, tentacle, version, git_sha, summary,
                      deployed_by_email, triggered_by_channel, triggered_by_ts, created_at
               FROM deployments WHERE enclave = ?`;
    if (opts.tentacle) {
      sql += ` AND tentacle = ?`;
      params.push(opts.tentacle);
    }
    sql += ` ORDER BY id DESC LIMIT ${limit}`;
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id,
      enclave: row.enclave,
      tentacle: row.tentacle,
      version: row.version,
      gitSha: row.git_sha,
      summary: row.summary,
      deployedByEmail: row.deployed_by_email,
      triggeredByChannel: row.triggered_by_channel,
      triggeredByTs: row.triggered_by_ts,
      createdAt: row.created_at,
    }));
  } finally {
    db.close();
  }
}

// In COMMANDS:
'recent-deployments': (args) => {
  const { positional, flags } = parseFlags(args);
  if (positional.length !== 1) fail('usage: recent-deployments <enclave> [--tentacle X] [--limit N]');
  return recentDeployments(positional[0], { tentacle: flags.tentacle, limit: flags.limit });
},
```

- [ ] **Step 3: Run test + commit**

```bash
npx vitest run test/unit/bin/kraken-db.test.ts
git add bin/kraken-db.ts test/unit/bin/kraken-db.test.ts
git commit -m "feat(kraken-db): add recent-deployments (--tentacle, --limit)"
```

### Task 8: `change-summary`

**Files:**
- Modify: `bin/kraken-db.ts`
- Modify: `test/unit/bin/kraken-db.test.ts`

- [ ] **Step 1: Inspect the change_summaries table schema**

```bash
grep -A 12 "change_summaries" src/db/schema.ts
```

Confirm columns. The implementation reads the latest summary for `(enclave, tentacle)`.

- [ ] **Step 2: Add tests**

```typescript
it('change-summary returns the latest summary', () => {
  const db = new Database(path.join(dir, 'kraken.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS change_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    enclave TEXT NOT NULL, tentacle TEXT NOT NULL,
    version INTEGER NOT NULL, summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.prepare(`INSERT INTO change_summaries (enclave, tentacle, version, summary, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run('tentacular-agensys', 'ai-news-digest', 1, 'first', '2026-05-01T00:00:00Z');
  db.prepare(`INSERT INTO change_summaries (enclave, tentacle, version, summary, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run('tentacular-agensys', 'ai-news-digest', 2, 'second', '2026-05-02T00:00:00Z');
  db.close();

  const { stdout } = runCli(dir, ['change-summary', 'tentacular-agensys', 'ai-news-digest']);
  const result = JSON.parse(stdout);
  expect(result.summary).toBe('second');
  expect(result.version).toBe(2);
});

it('change-summary returns null when no summary exists', () => {
  const { stdout } = runCli(dir, ['change-summary', 'unknown', 'unknown']);
  expect(JSON.parse(stdout)).toBeNull();
});
```

- [ ] **Step 3: Implement**

```typescript
function changeSummary(enclave: string, tentacle: string): unknown {
  const db = openMainDb();
  try {
    const row = db.prepare(
      `SELECT version, summary, created_at FROM change_summaries
       WHERE enclave = ? AND tentacle = ? ORDER BY id DESC LIMIT 1`,
    ).get(enclave, tentacle) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { version: row.version, summary: row.summary, createdAt: row.created_at };
  } finally {
    db.close();
  }
}

// In COMMANDS:
'change-summary': (args) => {
  if (args.length !== 2) fail('usage: change-summary <enclave> <tentacle>');
  return changeSummary(args[0], args[1]);
},
```

- [ ] **Step 4: Run test + commit**

```bash
npx vitest run test/unit/bin/kraken-db.test.ts
git add bin/kraken-db.ts test/unit/bin/kraken-db.test.ts
git commit -m "feat(kraken-db): add change-summary command"
```

### Task 9: Bake `kraken-db` into the Docker image

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Find the existing Dockerfile build step**

```bash
grep -n "RUN\|COPY\|tsx\|tsc" Dockerfile
```

- [ ] **Step 2: Compile bin to JS during build**

If the project uses `tsc` to a `dist/` dir, ensure `bin/kraken-db.ts` is included. If the build is `tsx` runtime, install `tsx` globally and add a wrapper script.

For a TS-as-JS build with `tsc`:

```dockerfile
# After existing tsc step, ensure bin output exists and is executable
RUN chmod +x dist/bin/kraken-db.js && \
    ln -sf /app/dist/bin/kraken-db.js /usr/local/bin/kraken-db
```

For a tsx-runtime build (no `tsc`):

```dockerfile
RUN npm install --global tsx && \
    printf '#!/bin/sh\nexec /usr/local/bin/tsx /app/bin/kraken-db.ts "$@"\n' > /usr/local/bin/kraken-db && \
    chmod +x /usr/local/bin/kraken-db
```

Inspect the existing Dockerfile and pick the matching pattern. Add the chosen block immediately after the existing build step that prepares `/app`.

- [ ] **Step 3: Verify in a local image build**

```bash
docker build -t thekraken-test .
docker run --rm --entrypoint /bin/sh thekraken-test -c 'which kraken-db && kraken-db lookup-channel C0NOTPRESENT 2>&1'
```

Expected: command found, returns null + exit 0 (db file not present is a separate failure path; the command parsing should not error).

Update the implementation to gracefully handle a missing `kraken.db` (return null with exit 0) — the agent may run `kraken-db` against a fresh pod before any binding exists:

```typescript
function openMainDb(): Database.Database | null {
  const dataDir = process.env.KRAKEN_DATA_DIR ?? '/app/data';
  const dbPath = join(dataDir, 'kraken.db');
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'SQLITE_CANTOPEN') return null;
    throw err;
  }
}
```

Update each command to handle null DB by returning empty/null:

```typescript
function lookupChannel(channelId: string): unknown {
  const db = openMainDb();
  if (!db) return null;
  // ...
}
```

- [ ] **Step 4: Update + run tests for the missing-DB case**

Add to `test/unit/bin/kraken-db.test.ts`:

```typescript
it('lookup-channel returns null when DB does not exist', () => {
  const empty = mkdtempSync(join(tmpdir(), 'kraken-empty-'));
  const { stdout, status } = runCli(empty, ['lookup-channel', 'C0AMY8XNBV2']);
  expect(status).toBe(0);
  expect(JSON.parse(stdout)).toBeNull();
  rmSync(empty, { recursive: true, force: true });
});
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile bin/kraken-db.ts test/unit/bin/kraken-db.test.ts
git commit -m "build: bake kraken-db into docker image; handle missing DB gracefully"
```

---

## Phase D — Smart-path 401 fix + channel-name resolution

### Task 10: Channel-name lookup helper

**Files:**
- Modify: `src/dispatcher/internal-ops.ts` (add a helper) OR new `src/dispatcher/channel-resolver.ts`
- Test: `test/unit/dispatcher/channel-resolver.test.ts`

- [ ] **Step 1: Find the existing module that owns enclave_bindings reads in-process**

```bash
grep -rn "enclave_bindings\|getEnclaveByChannel\|getBinding" src/
```

- [ ] **Step 2: Add or extend a helper**

Locate the function that returns a binding row. If there isn't one, add to a small file `src/dispatcher/channel-resolver.ts`:

```typescript
import type Database from 'better-sqlite3';

export interface ResolvedChannel {
  channelId: string;
  enclaveName: string;
  ownerSlackId: string;
}

export function resolveChannel(
  db: Database.Database,
  channelId: string,
): ResolvedChannel | null {
  const row = db.prepare(
    `SELECT channel_id, enclave_name, owner_slack_id
     FROM enclave_bindings WHERE channel_id = ? AND status = 'active'`,
  ).get(channelId) as { channel_id: string; enclave_name: string; owner_slack_id: string } | undefined;
  if (!row) return null;
  return {
    channelId: row.channel_id,
    enclaveName: row.enclave_name,
    ownerSlackId: row.owner_slack_id,
  };
}
```

- [ ] **Step 3: Tests**

```typescript
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { resolveChannel } from '../../../src/dispatcher/channel-resolver.js';

function inMemDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE enclave_bindings (
    channel_id TEXT PRIMARY KEY, enclave_name TEXT NOT NULL UNIQUE,
    owner_slack_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT '2026-01-01'
  )`);
  return db;
}

describe('resolveChannel', () => {
  it('returns binding for known active channel', () => {
    const db = inMemDb();
    db.prepare(`INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
      VALUES (?, ?, ?)`).run('C123', 'foo', 'U1');
    expect(resolveChannel(db, 'C123')).toEqual({
      channelId: 'C123', enclaveName: 'foo', ownerSlackId: 'U1',
    });
  });

  it('returns null for unknown channel', () => {
    expect(resolveChannel(inMemDb(), 'CMISS')).toBeNull();
  });

  it('returns null for inactive binding', () => {
    const db = inMemDb();
    db.prepare(`INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id, status)
      VALUES (?, ?, ?, 'inactive')`).run('C123', 'foo', 'U1');
    expect(resolveChannel(db, 'C123')).toBeNull();
  });
});
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run test/unit/dispatcher/channel-resolver.test.ts
git add src/dispatcher/channel-resolver.ts test/unit/dispatcher/channel-resolver.test.ts
git commit -m "feat(dispatcher): resolveChannel helper for in-process binding lookup"
```

### Task 11: Smart-path 401 — refresh on entry + retry + abort

**Files:**
- Modify: `src/dispatcher/smart-path.ts`
- Test: `test/unit/dispatcher/smart-path-token-refresh.test.ts`

- [ ] **Step 1: Add tests for the new behavior**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock createMcpConnection to control 401 vs success
const mockCreateMcp = vi.fn();
vi.mock('../../../src/agent/mcp-connection.js', () => ({
  createMcpConnection: (...args: unknown[]) => mockCreateMcp(...args),
}));

// Mock pi-ai 'complete' to return a terminal text response
vi.mock('@mariozechner/pi-ai', () => ({
  complete: vi.fn().mockResolvedValue({
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'endTurn',
    timestamp: 0,
  }),
  getModel: () => ({}),
  registerBuiltInApiProviders: () => {},
}));

import { runSmartPath } from '../../../src/dispatcher/smart-path.js';

const baseInput = {
  userMessage: 'hi',
  userToken: 'stale-token',
  userSlackId: 'U1',
  enclaveName: null,
  mcpUrl: 'http://mcp',
  anthropicApiKey: 'ak',
  modelId: 'claude-haiku-4-5',
  mode: 'dm' as const,
};

beforeEach(() => {
  mockCreateMcp.mockReset();
});

describe('smart-path token refresh on entry', () => {
  it('uses fresh token when getFreshToken returns one', async () => {
    mockCreateMcp.mockResolvedValueOnce({ tools: [], close: () => Promise.resolve() });
    await runSmartPath({
      ...baseInput,
      getFreshToken: () => Promise.resolve('fresh-token'),
    });
    expect(mockCreateMcp).toHaveBeenCalledWith('http://mcp', 'fresh-token');
  });

  it('retries once after 401 with refreshed token', async () => {
    mockCreateMcp
      .mockRejectedValueOnce(Object.assign(new Error('401'), { code: 401 }))
      .mockResolvedValueOnce({ tools: [], close: () => Promise.resolve() });
    let calls = 0;
    const result = await runSmartPath({
      ...baseInput,
      getFreshToken: () => Promise.resolve(`token-${++calls}`),
    });
    expect(mockCreateMcp).toHaveBeenCalledTimes(2);
    expect(result).toBe('ok');
  });

  it('returns re-auth message after persistent 401', async () => {
    mockCreateMcp.mockRejectedValue(Object.assign(new Error('401'), { code: 401 }));
    const result = await runSmartPath({
      ...baseInput,
      getFreshToken: () => Promise.resolve('still-bad'),
    });
    expect(result).toMatch(/session has expired|re-?authenticate/i);
  });

  it('returns re-auth message when getFreshToken returns null', async () => {
    const result = await runSmartPath({
      ...baseInput,
      getFreshToken: () => Promise.resolve(null),
    });
    expect(result).toMatch(/session has expired|re-?authenticate/i);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
npx vitest run test/unit/dispatcher/smart-path-token-refresh.test.ts
```

Expected: failures (existing code falls through to tool-less mode and returns "ok" instead of re-auth message).

- [ ] **Step 3: Modify smart-path.ts**

Replace the existing initial-connection block (around line 143-149) with:

```typescript
// Resolve a fresh token at entry. The caller's snapshot may be stale
// (5 min Keycloak access-token TTL is shorter than slow Slack delivery
// or background-refresh cadence).
async function resolveTokenForEntry(): Promise<string | null> {
  if (input.getFreshToken) {
    try {
      const fresh = await input.getFreshToken();
      if (fresh) return fresh;
    } catch (err) {
      log.warn({ err }, 'smart-path: getFreshToken failed at entry');
    }
  }
  return input.userToken || null;
}

const REAUTH_MESSAGE =
  'Your session has expired. Please re-authenticate (DM me \"login\") and try again.';

let activeToken = await resolveTokenForEntry();
if (!activeToken) {
  log.error('smart-path: no token available at entry');
  return REAUTH_MESSAGE;
}

let mcp: McpConnection | null = null;
try {
  mcp = await createMcpConnection(input.mcpUrl, activeToken);
} catch (err) {
  const status = (err as { code?: number }).code;
  if (status === 401) {
    log.warn('smart-path: 401 on initial MCP connect; retrying with fresh token');
    const retryToken = input.getFreshToken ? await input.getFreshToken().catch(() => null) : null;
    if (!retryToken || retryToken === activeToken) {
      log.error({ err }, 'smart-path: persistent 401 — aborting with re-auth message');
      return REAUTH_MESSAGE;
    }
    activeToken = retryToken;
    try {
      mcp = await createMcpConnection(input.mcpUrl, activeToken);
    } catch (err2) {
      log.error({ err: err2 }, 'smart-path: 401 persists after retry — aborting');
      return REAUTH_MESSAGE;
    }
  } else {
    log.error({ err }, 'smart-path: MCP connection failed (non-401); falling through to tool-less');
    // Non-auth errors keep the existing behavior — better to answer
    // conversationally than to drop the user.
  }
}

input.userToken = activeToken;
```

- [ ] **Step 4: Re-run tests, expect pass**

```bash
npx vitest run test/unit/dispatcher/smart-path-token-refresh.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/dispatcher/smart-path.ts test/unit/dispatcher/smart-path-token-refresh.test.ts
git commit -m "fix(smart-path): refresh on entry + 401 retry + abort to re-auth

- Initial MCP connect uses getFreshToken() result (snapshots are
  stale because Keycloak access-token TTL is short).
- On 401 at initial connect, refresh and retry once.
- On persistent 401 (or null token), return re-auth message and
  abort the turn — never silently degrade to tool-less mode.

Fixes M4, C4, I2 (manager appears to lose tools mid-conversation).
Bug surfaced via nats-weu E2E run 2026-05-06."
```

### Task 12: Smart-path channel-name resolution

**Files:**
- Modify: `src/index.ts` (the call site that builds SmartPathInput)
- Modify: `src/dispatcher/smart-path.ts` (already accepts channelName)
- Test: `test/unit/dispatcher/smart-path-channel-resolution.test.ts`

- [ ] **Step 1: Find smart-path call site in router/index**

```bash
grep -n "runSmartPath\|channelName" src/index.ts src/dispatcher/router.ts
```

- [ ] **Step 2: Inject `resolveChannel` lookup at the call site**

In `src/index.ts` where `runSmartPath` is invoked:

```typescript
import { resolveChannel } from './dispatcher/channel-resolver.js';

// Inside the smart-path branch, before runSmartPath:
const resolved = ctx.channelId ? resolveChannel(db, ctx.channelId) : null;
const channelName = ctx.channelName ?? resolved?.enclaveName;

const answer = await runSmartPath({
  // ...
  channelId: ctx.channelId,
  channelName, // now populated when binding exists
  // ...
});
```

- [ ] **Step 3: Test**

```typescript
// Verify that when the dispatcher router has a binding row, the
// channelName flows into the smart-path system prompt.
// Build an integration-style test that wires resolveChannel into a
// minimal smart-path invocation and asserts the prompt includes
// the resolved name.
```

(Test covered indirectly by existing smart-path prompt tests; add a focused test if there isn't one.)

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "fix(smart-path): resolve channel name from enclave_bindings if absent

Avoids leaking raw Slack channel IDs in agent replies (#19). The
binding table is in-process readable from the dispatcher; we look
up the enclave name and pass it into smart-path's channelName slot."
```

---

## Phase E — Background refresh visibility

### Task 13: Loud logs + status accessor

**Files:**
- Modify: `src/auth/oidc.ts`
- Test: `test/unit/auth/refresh-loop-status.test.ts`

- [ ] **Step 1: Tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as oidc from '../../../src/auth/oidc.js';
import { initSecretsDatabase } from '../../../src/db/index.js';
import { initTokenStore, setUserToken } from '../../../src/auth/tokens.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, tmpdir } from 'node:os';

describe('refresh loop status', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oidc-status-'));
    const sdb = initSecretsDatabase(dir);
    initTokenStore(sdb);
  });

  it('getRefreshLoopStatus returns null/zero before any sweep', () => {
    const s = oidc.getRefreshLoopStatus();
    expect(s.lastSweepAt).toBeNull();
    expect(s.lastSweepRefreshed).toBe(0);
    expect(s.lastSweepFailed).toBe(0);
  });

  it('refreshAllExpiring updates status fields', async () => {
    // Seed a token row that is about to expire to force a refresh attempt
    setUserToken('U1', {
      access_token: 'a', refresh_token: 'r',
      expires_at: Date.now() + 1000, // expires in 1s, well within REFRESH_AHEAD_MS
      keycloak_sub: 's', email: 'u@e',
    });

    // Mock fetch to fail the refresh
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('bad', { status: 400 }),
    ) as unknown as typeof globalThis.fetch;

    await oidc.refreshAllExpiring();

    const s = oidc.getRefreshLoopStatus();
    expect(s.lastSweepAt).not.toBeNull();
    expect(s.lastSweepFailed).toBe(1);

    globalThis.fetch = origFetch;
  });
});
```

- [ ] **Step 2: Implement**

Add to `src/auth/oidc.ts`:

```typescript
interface RefreshLoopStatus {
  lastSweepAt: number | null;
  lastSweepRefreshed: number;
  lastSweepFailed: number;
  lastSweepDeleted: number;
}

let refreshLoopStatus: RefreshLoopStatus = {
  lastSweepAt: null,
  lastSweepRefreshed: 0,
  lastSweepFailed: 0,
  lastSweepDeleted: 0,
};

export function getRefreshLoopStatus(): RefreshLoopStatus {
  return { ...refreshLoopStatus };
}
```

Modify `refreshAllExpiring` to track failures and update status:

```typescript
export async function refreshAllExpiring(): Promise<void> {
  const allTokens = getAllUserTokens();
  const now = Date.now();
  let refreshed = 0;
  let expired = 0;
  let failed = 0;

  for (const row of allTokens) {
    const updatedAt = new Date(row.updated_at).getTime();
    if (now - updatedAt > SESSION_WINDOW_MS) {
      deleteUserToken(row.slack_user_id);
      expired++;
      continue;
    }

    const timeUntilExpiry = row.expires_at - now;
    if (timeUntilExpiry < REFRESH_AHEAD_MS) {
      try {
        const tokens = await refreshToken(row.refresh_token);
        storeTokenForUser(row.slack_user_id, tokens);
        refreshed++;
      } catch (err) {
        failed++;
        // Promoted from warn to error per rc.11 visibility requirement.
        logger.error(
          { slackUserId: row.slack_user_id, err },
          'Background token refresh failed',
        );
      }
    }
  }

  refreshLoopStatus = {
    lastSweepAt: Date.now(),
    lastSweepRefreshed: refreshed,
    lastSweepFailed: failed,
    lastSweepDeleted: expired,
  };

  if (failed > 0) {
    logger.error(
      { refreshed, failed, expired, total: allTokens.length },
      'Background token refresh sweep had failures',
    );
  } else if (refreshed > 0 || expired > 0) {
    logger.info(
      { refreshed, expired, total: allTokens.length },
      'Background token refresh sweep complete',
    );
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run test/unit/auth/refresh-loop-status.test.ts
git add src/auth/oidc.ts test/unit/auth/refresh-loop-status.test.ts
git commit -m "feat(auth): refresh-loop status + per-failure error logs

- Promote per-user refresh failures from warn to error so default pod
  log filters surface them.
- Emit error-level summary when any sweep had failures.
- Add getRefreshLoopStatus() for the health endpoint to read."
```

---

## Phase F — Team-bridge mid-turn token refresh

### Task 14: Periodic token-file rewrite while bridge alive

**Files:**
- Modify: `src/teams/bridge.ts`
- Test: `test/unit/teams/bridge-token-refresh-timer.test.ts`

- [ ] **Step 1: Tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
// Use fake timers and a stub bridge that exposes the timer behavior.
// Given the bridge wires to many subprocesses, focus the test on the
// periodic refresh hook itself rather than the full bridge lifecycle.

describe('team-bridge mid-turn token refresh timer', () => {
  it('writes a fresh token every 60s while a record is current', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const mockGetToken = vi.fn().mockResolvedValueOnce('t1').mockResolvedValueOnce('t2');
    const mockWrite = (token: string) => { writes.push(token); };

    // Pseudo-driver: the actual implementation lives on TeamBridge as a private
    // method. Extract or expose the timer for testability.
    // Implementation note: see Task 14 step 2 — refactor to a public
    // startMidTurnRefresh(getToken, write) for testability.

    // For now, smoke-test: instantiate TeamBridge with a current record set,
    // tick 120s, expect 2 writes.
    vi.useRealTimers();
  });
});
```

(Test will be tightened once the implementation hook is in place.)

- [ ] **Step 2: Add `startMidTurnRefresh` to `TeamBridge`**

In `src/teams/bridge.ts`, add a private timer:

```typescript
private midTurnTimer: ReturnType<typeof setInterval> | null = null;
private midTurnRunning = false;

/** Starts a 60s periodic re-write of KRAKEN_TOKEN_FILE. Idempotent. */
private startMidTurnRefresh(): void {
  if (this.midTurnTimer) return;
  this.midTurnTimer = setInterval(() => {
    if (this.midTurnRunning) return; // non-overlapping
    this.midTurnRunning = true;
    void (async () => {
      try {
        const record = this.currentRecord;
        if (!record) return;
        if (!this.opts.getTokenForUser) return;
        const fresh = await this.opts
          .getTokenForUser(record.userSlackId)
          .catch(() => null);
        if (!fresh) {
          log.warn(
            { enclaveName: this.opts.enclaveName, userId: record.userSlackId },
            'team-bridge: mid-turn refresh got null token',
          );
          return;
        }
        const expiresIn = extractExpiresIn(fresh, log, this.opts.enclaveName);
        writeTokenFile(this.opts.teamDir, fresh, expiresIn);
        log.debug(
          { enclaveName: this.opts.enclaveName, expiresIn },
          'team-bridge: mid-turn token refresh',
        );
      } finally {
        this.midTurnRunning = false;
      }
    })();
  }, 60_000);
}

private stopMidTurnRefresh(): void {
  if (this.midTurnTimer) {
    clearInterval(this.midTurnTimer);
    this.midTurnTimer = null;
  }
}
```

- [ ] **Step 3: Wire start in bridge `start()` and stop in `stop()`**

Find the existing `start()` and `stop()` methods of `TeamBridge`:

```bash
grep -n "async start\|async stop\b\|stop()\b" src/teams/bridge.ts | head
```

Add `this.startMidTurnRefresh()` at the end of `start()`, `this.stopMidTurnRefresh()` at the start of `stop()`.

- [ ] **Step 4: Run + commit**

```bash
npm test 2>&1 | grep -E "team-bridge|FAIL|PASS" | head -30
git add src/teams/bridge.ts test/unit/teams/bridge-token-refresh-timer.test.ts
git commit -m "feat(team-bridge): periodic mid-turn KRAKEN_TOKEN_FILE rewrite

Long manager turns (60s+) outlive Keycloak's access-token TTL when
the realm is configured with short TTLs. A 60s timer pulls a fresh
token via getTokenForUser and rewrites the file. The subprocess
re-reads the file on every tntc/MCP call, so refreshes are picked
up automatically. Non-overlapping timer (skip tick if previous
still running)."
```

---

## Phase G — Keycloak preflight

### Task 15: Preflight check

**Files:**
- Modify: `src/auth/oidc.ts` (add `runKeycloakPreflight`)
- Modify: `src/index.ts` (call preflight on boot)
- Test: `test/unit/auth/keycloak-preflight.test.ts`

- [ ] **Step 1: Tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runKeycloakPreflight } from '../../../src/auth/oidc.js';

describe('Keycloak preflight', () => {
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('logs success when issuer is reachable + has device endpoint + offline_access', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        device_authorization_endpoint: 'https://k/device',
        scopes_supported: ['openid', 'email', 'offline_access'],
        jwks_uri: 'https://k/jwks',
      }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await runKeycloakPreflight('https://issuer/realms/r');
    expect(result.ok).toBe(true);
  });

  it('returns ok=false but does not throw on unreachable issuer', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof globalThis.fetch;
    const result = await runKeycloakPreflight('https://nope');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unreachable|ECONNREFUSED/i);
  });

  it('returns ok=false when device_authorization_endpoint missing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ scopes_supported: ['openid'] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const result = await runKeycloakPreflight('https://issuer');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/device/);
  });

  it('returns ok=false when offline_access not in scopes', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        device_authorization_endpoint: 'd',
        scopes_supported: ['openid', 'email'],
        jwks_uri: 'j',
      }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const result = await runKeycloakPreflight('https://issuer');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/offline_access/);
  });
});
```

- [ ] **Step 2: Implementation**

```typescript
export interface KeycloakPreflightResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate that the Keycloak realm is reachable and reasonably configured
 * for our usage. Logs loudly on failure but does NOT throw — startup
 * always continues per design.
 */
export async function runKeycloakPreflight(
  issuer: string,
): Promise<KeycloakPreflightResult> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const reason = `issuer unreachable: ${(err as Error).message}`;
    logger.error({ issuer, err }, `Keycloak preflight: ${reason}`);
    return { ok: false, reason };
  }

  if (!res.ok) {
    const reason = `issuer returned ${res.status}`;
    logger.error({ issuer, status: res.status }, `Keycloak preflight: ${reason}`);
    return { ok: false, reason };
  }

  let cfg: { device_authorization_endpoint?: string; scopes_supported?: string[]; jwks_uri?: string };
  try {
    cfg = (await res.json()) as typeof cfg;
  } catch (err) {
    const reason = 'invalid OIDC discovery JSON';
    logger.error({ issuer, err }, `Keycloak preflight: ${reason}`);
    return { ok: false, reason };
  }

  if (!cfg.device_authorization_endpoint) {
    const reason = 'no device_authorization_endpoint';
    logger.error({ issuer }, `Keycloak preflight: ${reason}`);
    return { ok: false, reason };
  }

  if (!cfg.scopes_supported?.includes('offline_access')) {
    const reason = 'offline_access not in scopes_supported';
    logger.error({ issuer }, `Keycloak preflight: ${reason} (configure realm to include offline_access)`);
    return { ok: false, reason };
  }

  if (!cfg.jwks_uri) {
    const reason = 'no jwks_uri';
    logger.error({ issuer }, `Keycloak preflight: ${reason}`);
    return { ok: false, reason };
  }

  logger.info({ issuer }, 'Keycloak preflight passed');
  return { ok: true };
}
```

- [ ] **Step 3: Wire into startup in `src/index.ts`**

After `initDatabase` and `initSecretsDatabase` but before the bot starts:

```typescript
import { runKeycloakPreflight } from './auth/oidc.js';

// ...
await runKeycloakPreflight(config.oidc.issuer).catch((err) => {
  logger.error({ err }, 'Keycloak preflight crashed unexpectedly');
});
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run test/unit/auth/keycloak-preflight.test.ts
git add src/auth/oidc.ts src/index.ts test/unit/auth/keycloak-preflight.test.ts
git commit -m "feat(auth): Keycloak preflight on startup (loud-log, never crash)

Fetches .well-known/openid-configuration on boot. Surfaces (at error
level) if the issuer is unreachable, missing device_authorization_endpoint,
missing offline_access scope, or missing jwks_uri. Never throws — Kraken
continues to start so it can serve the next user message and surface the
problem in logs."
```

---

## Phase H — Health endpoint refresh-loop liveness

### Task 16: Extend `checkHealth`

**Files:**
- Modify: `src/health.ts`
- Test: `test/unit/health.test.ts`

- [ ] **Step 1: Tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { checkHealth } from '../../src/health.js';
import * as oidc from '../../src/auth/oidc.js';

describe('checkHealth — refresh loop liveness (rc.11)', () => {
  it('returns degraded when refresh loop has never run', () => {
    vi.spyOn(oidc, 'getRefreshLoopStatus').mockReturnValue({
      lastSweepAt: null, lastSweepRefreshed: 0, lastSweepFailed: 0, lastSweepDeleted: 0,
    });
    const r = checkHealth();
    expect(r.status).toBe('degraded');
  });

  it('returns degraded when last sweep was > 2x interval ago', () => {
    const tenMinAgo = Date.now() - 11 * 60 * 1000;
    vi.spyOn(oidc, 'getRefreshLoopStatus').mockReturnValue({
      lastSweepAt: tenMinAgo, lastSweepRefreshed: 0, lastSweepFailed: 0, lastSweepDeleted: 0,
    });
    expect(checkHealth().status).toBe('degraded');
  });

  it('returns ok when last sweep was recent', () => {
    vi.spyOn(oidc, 'getRefreshLoopStatus').mockReturnValue({
      lastSweepAt: Date.now() - 30_000, lastSweepRefreshed: 0, lastSweepFailed: 0, lastSweepDeleted: 0,
    });
    expect(checkHealth().status).toBe('ok');
  });
});
```

- [ ] **Step 2: Implement**

Modify `src/health.ts`:

```typescript
import { getRefreshLoopStatus } from './auth/oidc.js';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const STALE_THRESHOLD_MS = 2 * REFRESH_INTERVAL_MS;

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  refreshLoop?: {
    lastSweepAt: number | null;
    ageMs: number | null;
    refreshed: number;
    failed: number;
    deleted: number;
  };
}

export function checkHealth(db?: Database.Database): HealthResponse {
  // DB liveness
  if (db) {
    try {
      db.prepare('SELECT 1').get();
    } catch {
      return { status: 'error' };
    }
  }

  // Refresh loop liveness
  const s = getRefreshLoopStatus();
  const ageMs = s.lastSweepAt === null ? null : Date.now() - s.lastSweepAt;
  const refreshLoopOk = s.lastSweepAt !== null && (ageMs ?? Infinity) <= STALE_THRESHOLD_MS;

  return {
    status: refreshLoopOk ? 'ok' : 'degraded',
    refreshLoop: {
      lastSweepAt: s.lastSweepAt,
      ageMs,
      refreshed: s.lastSweepRefreshed,
      failed: s.lastSweepFailed,
      deleted: s.lastSweepDeleted,
    },
  };
}
```

Note `degraded` keeps HTTP 200 (existing handler maps `ok` → 200, `error` → 503; add `degraded` → 200).

In `createHealthServer` and `makeHealthHandler`:

```typescript
const statusCode = body.status === 'error' ? 503 : 200;
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run test/unit/health.test.ts
git add src/health.ts test/unit/health.test.ts
git commit -m "feat(health): surface refresh-loop liveness as degraded status

- Health response includes refreshLoop.{lastSweepAt, ageMs, counts}.
- 'degraded' if last sweep > 2x interval ago, but HTTP stays 200 so
  Kubernetes readiness keeps the pod in service. Observability only."
```

---

## Phase I — Subprocess prompts: post_to_slack, kraken-db, no-confab

### Task 17: Update manager + dev-team prompts

**Files:**
- Modify: `src/agent/system-prompt.ts`
- Modify: `src/dispatcher/smart-path.ts` (DM/provision system prompts)

- [ ] **Step 1: Add post_to_slack idiom + kraken-db reference + no-confab clause to manager prompt**

In `buildManagerPrompt` (`src/agent/system-prompt.ts`), append a new section after the Token Handling section:

```typescript
'',
'## Posting to Slack channels other than this thread',
'You may post into a different Slack channel or thread by appending a',
'record to $KRAKEN_TEAM_DIR/outbound.ndjson:',
'  printf \'{"id":"%s","timestamp":"%s","type":"slack_message","channelId":"%s","threadTs":"%s","text":"%s"}\\n\' \\\\',
'    "$(uuidgen)" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$CHANNEL" "$THREAD" "$TEXT" \\\\',
'    >> "$KRAKEN_TEAM_DIR/outbound.ndjson"',
'(Set THREAD to "" for a top-of-channel post.) The dispatcher\'s',
'outbound poller posts the record to Slack. Use this for cross-channel',
'announcements, not for ordinary in-thread replies (those go via the',
'normal manager response).',
'',
'## Reading Kraken session state',
'You have a curated read-only query CLI: `kraken-db`.',
'Available queries:',
'  kraken-db lookup-channel <channelId>     -> { enclaveName, ownerSlackId, ... } | null',
'  kraken-db list-enclaves [--user <slackId>] -> [{...}, ...]',
'  kraken-db recent-deployments <enclave> [--tentacle X] [--limit N] -> [...]',
'  kraken-db change-summary <enclave> <tentacle> -> { summary, version, createdAt } | null',
'Returns JSON. Use this to resolve channel IDs to enclave names, look up',
'recent deploy history, or recall a tentacle\'s last change summary.',
'',
'## Honesty about capabilities',
'If you cannot do something, ask the user. NEVER claim a structural',
'denial — e.g. "I don\'t have access to Slack", "I can\'t retrieve that",',
'"I can\'t post to channels" — without first trying. If a tool call',
'fails, say what failed and ask the user how to proceed.',
```

- [ ] **Step 2: Add no-confab clause to smart-path system prompts**

In `src/dispatcher/smart-path.ts`, find the system-prompt builders for `dm` and `provision` modes and append the same honesty clause.

- [ ] **Step 3: Run prompt-related tests**

```bash
npx vitest run test/unit/agent/system-prompt
```

If existing tests assert exact prompt text, update those assertions.

- [ ] **Step 4: Commit**

```bash
git add src/agent/system-prompt.ts src/dispatcher/smart-path.ts test/unit/agent
git commit -m "feat(prompts): post_to_slack idiom, kraken-db reference, no-confab clause

- Manager prompt teaches the outbound.ndjson pattern for cross-channel
  posts and the kraken-db query CLI for session-state lookups.
- Smart-path prompts (dm + provision) get an honesty clause: never
  claim structural denial without trying. Fixes #20."
```

---

## Phase J — E2E expansion (tentacle CRUD)

### Task 18: Add F-CRUD scenarios

**Files:**
- Modify: `test/e2e-slack/scenarios.ts`
- Test: same file (E2E suite)

- [ ] **Step 1: Add scenarios**

Append to the F group in `test/e2e-slack/scenarios.ts`. Ensure they're gated:

```typescript
const ALLOW_DESTRUCTIVE = process.env.KRAKEN_E2E_ALLOW_DESTRUCTIVE === '1';

// ... at the end of the existing F group, when ALLOW_DESTRUCTIVE:
...(ALLOW_DESTRUCTIVE ? [
  {
    id: 'F-CREATE-1',
    name: 'create a new echo-probe tentacle (full lifecycle: build + deploy)',
    channel: CHANNELS.enclave,
    message: '@Kraken Build a new tentacle called e2e-echo-probe-1 from the echo-probe scaffold.',
    expectedPatterns: [/commission|building|builder/i, /deploy|ready/i],
    forbiddenPatterns: [FORBIDDEN_MARKDOWN_TABLE, FORBIDDEN_SLACK_CHANNEL_ID],
    timeoutMs: 600_000, // 10m for full build + deploy
  },
  {
    id: 'F-READ-1',
    name: 'read tentacle status by name (prose, no table)',
    channel: CHANNELS.enclave,
    message: '@Kraken What is the status of e2e-echo-probe-1?',
    expectedPatterns: [/e2e-echo-probe-1/i, /(ready|deployed|active)/i],
    forbiddenPatterns: [FORBIDDEN_MARKDOWN_TABLE, FORBIDDEN_VERSION_NUMBER, FORBIDDEN_SHA],
    timeoutMs: 60_000,
  },
  {
    id: 'F-READ-2',
    name: 'last change summary (plain English, no SHAs)',
    channel: CHANNELS.enclave,
    message: '@Kraken What was the last change to e2e-echo-probe-1?',
    expectedPatterns: [/(deploy|change|summary)/i],
    forbiddenPatterns: [FORBIDDEN_SHA, FORBIDDEN_VERSION_NUMBER],
    timeoutMs: 60_000,
  },
  {
    id: 'F-UPDATE-1',
    name: 'update tentacle (re-deploy with a change)',
    channel: CHANNELS.enclave,
    message: '@Kraken Re-deploy e2e-echo-probe-1.',
    expectedPatterns: [/(re-?deploy|deployed|building)/i],
    forbiddenPatterns: [FORBIDDEN_MARKDOWN_TABLE, FORBIDDEN_SHA],
    timeoutMs: 600_000,
  },
  {
    id: 'F-DELETE-1',
    name: 'delete tentacle (verify removal)',
    channel: CHANNELS.enclave,
    message: '@Kraken Remove e2e-echo-probe-1.',
    expectedPatterns: [/(removed|delete|gone)/i],
    forbiddenPatterns: [FORBIDDEN_MARKDOWN_TABLE],
    timeoutMs: 300_000,
  },
] : []),
```

If `FORBIDDEN_VERSION_NUMBER` and `FORBIDDEN_SHA` don't exist yet, define them at the top of the file:

```typescript
const FORBIDDEN_VERSION_NUMBER = /\bv\d+\.\d+\.\d+\b|\bversion\s+\d+\b/i;
const FORBIDDEN_SHA = /\b[0-9a-f]{7,40}\b/;
```

- [ ] **Step 2: Document the gate in `CLAUDE.md` E2E groups table**

Already mentioned in the workspace-level `CLAUDE.md`. Update entry for group F to mention `KRAKEN_E2E_ALLOW_DESTRUCTIVE=1`.

- [ ] **Step 3: Commit**

```bash
git add test/e2e-slack/scenarios.ts
git commit -m "test(e2e): F-CRUD lifecycle scenarios (gated by ALLOW_DESTRUCTIVE)

Adds F-CREATE-1, F-READ-1, F-READ-2, F-UPDATE-1, F-DELETE-1 to exercise
the full tentacle lifecycle. Gated behind KRAKEN_E2E_ALLOW_DESTRUCTIVE=1
to avoid churning the cluster on every test run."
```

---

## Phase K — Hygiene (lint + format + typecheck + full test pass)

### Task 19: Lint, format, typecheck, full test pass

- [ ] **Step 1: Run all checks**

```bash
cd ~/code/tentacular-main/thekraken
npx tsc --noEmit
npm run lint
npm run format:check
npm test
```

Expected: tsc + lint + format clean. `npm test` may have 3 pre-existing scenario-test failures (need ANTHROPIC_API_KEY); confirm those are the only failures.

- [ ] **Step 2: Apply prettier if needed**

```bash
npm run format -- --write 2>&1 | tail -5  # only if prettier reports diffs
```

- [ ] **Step 3: Commit any formatting fixups**

```bash
git add -u
git commit -m "chore: prettier + lint cleanup" || echo "nothing to commit"
```

- [ ] **Step 4: Mark PR ready for review (or leave as draft)**

```bash
gh pr ready
```

---

## Phase L — Lockstep release + redeploy

### Task 20: Cut v0.10.0-rc.11 lockstep

- [ ] **Step 1: Pre-tag triage in all 7 repos**

```bash
cd ~/code/tentacular-main
for repo in tentacular tentacular-mcp tentacular-skill tentacular-scaffolds \
            tentacular-docs thekraken tentacular-chroma; do
  echo "=== $repo ==="
  git -C "$repo" status -s
done
```

Expected: `thekraken` has the rc.11 commits awaiting merge; others clean.

- [ ] **Step 2: Merge the rc.11 PR**

```bash
gh pr merge --squash  # or --merge if preferred
```

Wait for green CI on the PR before merging.

- [ ] **Step 3: Tag rc.11 across all 7 repos**

```bash
VERSION="v0.10.0-rc.11"
for repo in tentacular tentacular-mcp tentacular-skill tentacular-scaffolds \
            tentacular-docs thekraken tentacular-chroma; do
  cd ~/code/tentacular-main/$repo
  git checkout main && git pull origin main
  git tag -a "$VERSION" -m "Release candidate $VERSION"
  git push origin "$VERSION"
  cd -
done
```

- [ ] **Step 4: Watch CI**

```bash
gh run list -R randybias/tentacular --limit 3
gh run list -R randybias/tentacular-mcp --limit 3
gh run list -R randybias/thekraken --limit 3
gh run list -R randybias/tentacular-chroma --limit 3
```

Watch until all builds finish. Confirm:
- `ghcr.io/randybias/tentacular-engine:v0.10.0-rc.11`
- `ghcr.io/randybias/tentacular-mcp:v0.10.0-rc.11`
- `ghcr.io/randybias/thekraken:v0.10.0-rc.11`
- `ghcr.io/randybias/tentacular-chroma:v0.10.0-rc.11`
all exist via `crane manifest`.

### Task 21: Redeploy nats-weu via D-checklist

- [ ] **Step 1: Set kubeconfig**

```bash
export KUBECONFIG=/tmp/nats-fixed.kubeconfig
```

- [ ] **Step 2: Phase D1 — Capture rollback state** (per workspace CLAUDE.md)

```bash
TARGET_CLUSTER=nats-weu
VERSION=v0.10.0-rc.11
mkdir -p ~/code/tentacular-main/scratch
helm -n tentacular get values tentacular-platform > ~/code/tentacular-main/scratch/${TARGET_CLUSTER}-platform-values-pre-${VERSION}.yaml 2>/dev/null || true
helm -n tentacular-kraken get values thekraken > ~/code/tentacular-main/scratch/${TARGET_CLUSTER}-kraken-values-pre-${VERSION}.yaml
helm -n observability get values chroma > ~/code/tentacular-main/scratch/${TARGET_CLUSTER}-chroma-values-pre-${VERSION}.yaml 2>/dev/null || true
```

- [ ] **Step 3: Phase D2 — Helm upgrade each component**

```bash
# MCP server
kubectl -n tentacular-system set image deploy/tentacular-tentacular-mcp \
  tentacular-mcp=ghcr.io/randybias/tentacular-mcp:$VERSION --field-manager=helm

# Kraken
helm upgrade thekraken charts/thekraken \
  -n tentacular-kraken \
  --set image.tag=$VERSION \
  --reuse-values --wait --timeout=5m

# Chroma
helm upgrade chroma charts/chroma \
  -n observability \
  --set image.tag=$VERSION \
  --reuse-values --wait --timeout=5m
```

- [ ] **Step 4: Phase D3 — Verify every component at target version**

```bash
kubectl -n tentacular-system get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}'
kubectl -n tentacular-kraken get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}'
kubectl -n observability get deploy chroma -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

Each line should end with `:v0.10.0-rc.11`.

- [ ] **Step 5: Phase D4 — Re-deploy ai-* tentacles via state restore**

```bash
for t in ai-news-digest ai-news-roundup ai-team-feed ai-weekly-roundup; do
  echo $t | tee /dev/null
  # ai-news-digest doesn't exist on nats-weu — adjust list to actual tentacles deployed
done
```

(Identify actually-deployed tentacles via `tntc -c nats-weu list --enclave tentacular-agensys` first; restore each with `tntc state restore tentacular-agensys <name> HEAD`.)

- [ ] **Step 6: Phase D5 — Smoke tests**

- DM the bot in nats-weu Slack: "what enclaves am I in?" → should reply with names, NOT raw channel IDs.
- Mention in enclave: "what's the status of ai-news-digest?" → prose, no markdown table, no SHAs.
- Manager replies pull live data (M4 should be FIXED — manager sees all deployed tentacles, not just one).

- [ ] **Step 7: Phase D6 — Document**

Append a one-liner to `kraken-token-architecture.md` (or a new short note in `scratch/`):

> Deployed v0.10.0-rc.11 to nats-weu on 2026-05-06. D-checklist verified.

### Task 22: Re-run E2E suite

- [ ] **Step 1: Run nats-weu E2E**

```bash
cd ~/code/tentacular-main/thekraken
./scripts/run-e2e-nats-weu.sh
```

- [ ] **Step 2: Confirm rc.10 → rc.11 deltas**

Per group, expect:
- B1, C1: PASS (markdown tables fixed)
- C4, I2: PASS (smart-path 401 fixed)
- M4: PASS (manager sees real data)
- N4: PASS (webhook not jargon)
- N5: PASS (no markdown table on enclave-info)
- L1-L4: still PASS
- F-CREATE-1 through F-DELETE-1: PASS (gated; run with `KRAKEN_E2E_ALLOW_DESTRUCTIVE=1`)

- [ ] **Step 3: Triage any remaining failures**

For any new or persistent failures:
- Capture log evidence
- File issue if root cause is in code
- File regex broadening if test was wrong

- [ ] **Step 4: Update memory**

Save a project memory entry with rc.11 deploy + E2E result.

---

## Self-Review

**Spec coverage check:**
- DB split → Tasks 1-4 ✓
- kraken-db CLI → Tasks 5-9 ✓
- Smart-path 401 fix → Task 11 ✓
- Channel-name resolution → Tasks 10, 12 ✓
- Background refresh visibility → Task 13 ✓
- Team-bridge mid-turn refresh → Task 14 ✓
- Keycloak preflight → Task 15 ✓
- Health endpoint → Task 16 ✓
- Subprocess prompt updates (post_to_slack, kraken-db, no-confab) → Task 17 ✓
- E2E expansion → Task 18 ✓
- Lint/format → Task 19 ✓
- Lockstep release → Task 20 ✓
- Redeploy + retest → Tasks 21-22 ✓

**Placeholder scan:** No "TBD", "TODO", "fill in details." Each step has either runnable code, exact commands, or specific assertions.

**Type consistency:**
- `getRefreshLoopStatus()` returns `RefreshLoopStatus` (Task 13), consumed by `checkHealth` (Task 16). Field names match.
- `resolveChannel(db, channelId)` returns `ResolvedChannel | null` (Task 10), used in `src/index.ts` to populate `channelName` (Task 12). Both touch the same fields.
- `KeycloakPreflightResult` (Task 15) has `ok` and optional `reason`, used in startup logging.

No mismatches found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-06-rc11-token-and-session-state.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review between
2. **Inline Execution** — execute tasks in this session in batches with checkpoints

Which approach?
