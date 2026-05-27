# Deterministic Provisioning + Thread Participation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken LLM-driven enclave provisioning flow with a deterministic `@kraken provision` command, and add SQLite-backed thread-participation tracking so non-@-mention thread replies reach the Kraken when (and only when) the thread was started by an @-mention.

**Architecture:** Five components on one branch (`spec/deterministic-provisioning`): (1) `provision` command parser + handler mirroring the existing `add`/`remove` deterministic pattern, (2) `kraken_threads` SQLite table populated by `app_mention` and consumed by the `message` handler, (3) remove `mode: 'provision'` from smart-path and restructure the unbound-channel branch of `app_mention` to run `parseCommand` first, (4) skill + system-prompt updates so the manager no longer claims `enclave_provision`, (5) new E2E scenarios E6-E9 plus adjusting E2 and PLAT-LIFECYCLE-1 step 0 message text.

**Tech Stack:** TypeScript strict, better-sqlite3 sync API, pino logger via `createChildLogger`, vitest for unit tests, Slack Bolt `app.event('app_mention')` / `app.event('message')`. No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-05-27-deterministic-provisioning-design.md`

---

## File Structure

### New files
- `src/db/kraken-threads.ts` — `recordKrakenThread`, `isKrakenThread`, `pruneOldKrakenThreads` helpers
- `src/enclave/handlers/provisioning.ts` — `handleProvision(rawArgs, ctx)` deterministic handler
- `test/unit/db/kraken-threads.test.ts` — unit tests for the threads table
- `test/unit/enclave/handlers/provisioning.test.ts` — unit tests for handleProvision

### Modified files
- `src/db/schema.ts` — add `SCHEMA_V4` constant for `kraken_threads`
- `src/db/migrations.ts` — invoke `db.exec(SCHEMA_V4)` in `createDatabase`
- `src/enclave/commands.ts` — extend `parseCommand` regex; wire `provision` to handler
- `src/slack/bot.ts` — (a) populate `kraken_threads` on top-level `app_mention`; (b) restructure unbound-channel branch to run `parseCommand` first; (c) replace `isBoundChannel && isThreadReply` gate with `isKrakenThread` lookup; (d) remove `mode: 'provision'` smart-path call site
- `src/dispatcher/smart-path.ts` — remove `'provision'` from `SmartPathMode`, `MODE_TOOL_ALLOWLIST`, `buildProvisioningPrompt` function (delete it)
- `src/dispatcher/router.ts` — remove `'provision'` SmartReason
- `src/agent/system-prompt.ts` — remove `enclave_provision` from manager Path 1 tool list in `buildManagerPrompt`
- `skills/kraken/SKILL.md` — same removal in markdown
- `skills/kraken/references/slack-ux.md` — document `@kraken provision` command
- `skills/kraken/references/thread-model.md` — document the thread-participation rule
- `test/e2e-slack/scenarios.ts` — update E2 message text; add E6, E7, E8, E9
- `test/e2e-platform/scenarios.ts` — update PLAT-LIFECYCLE-1 step 0 message text
- `test/unit/enclave/commands.test.ts` — extend with `provision` grammar cases
- `test/unit/slack-bot.test.ts` — extend with `kraken_threads`-aware message handler tests
- `test/unit/dispatcher-router.test.ts` — drop `provision` SmartReason row from routing matrix

---

## Task 1: Add `kraken_threads` SCHEMA_V4

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/migrations.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/db/schema-kraken-threads.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { createDatabase } from '../../../src/db/migrations.js';

describe('SCHEMA_V4: kraken_threads', () => {
  it('creates kraken_threads table on fresh init', () => {
    const db = createDatabase(':memory:');
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='kraken_threads'",
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('kraken_threads');
    db.close();
  });

  it('table has expected columns', () => {
    const db = createDatabase(':memory:');
    const cols = db
      .prepare("PRAGMA table_info('kraken_threads')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['channel_id', 'created_at', 'thread_ts']);
    db.close();
  });

  it('primary key is (channel_id, thread_ts)', () => {
    const db = createDatabase(':memory:');
    db.prepare(
      "INSERT INTO kraken_threads (channel_id, thread_ts, created_at) VALUES ('C1','T1', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO kraken_threads (channel_id, thread_ts, created_at) VALUES ('C1','T1', 2)",
        )
        .run(),
    ).toThrow(/UNIQUE constraint/);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/rbias/code/tentacular-main/thekraken
npx vitest run test/unit/db/schema-kraken-threads.test.ts
```
Expected: FAIL with `no such table: kraken_threads`.

- [ ] **Step 3: Add SCHEMA_V4 to `src/db/schema.ts`**

Append at the end of `src/db/schema.ts`:
```typescript
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
```

- [ ] **Step 4: Wire SCHEMA_V4 in `src/db/migrations.ts`**

Edit `src/db/migrations.ts`:
- In imports: add `SCHEMA_V4` to the import list from `./schema.js`
- After the `db.exec(SCHEMA_V3);` line, add: `db.exec(SCHEMA_V4);`

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run test/unit/db/schema-kraken-threads.test.ts
```
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrations.ts test/unit/db/schema-kraken-threads.test.ts
git commit -m "feat(db): add SCHEMA_V4 kraken_threads table

Tracks (channel_id, thread_ts) for threads where the bot was @-mentioned
at the top level. The message handler will consult this table to decide
whether non-@-mention thread replies should be forwarded to the dispatcher.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: kraken-threads helpers (record / lookup / prune)

**Files:**
- Create: `src/db/kraken-threads.ts`
- Create: `test/unit/db/kraken-threads.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/db/kraken-threads.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../../src/db/migrations.js';
import {
  recordKrakenThread,
  isKrakenThread,
  pruneOldKrakenThreads,
} from '../../../src/db/kraken-threads.js';

describe('kraken-threads helpers', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  it('record + lookup roundtrip', () => {
    recordKrakenThread(db, 'C123', 'T123.456');
    expect(isKrakenThread(db, 'C123', 'T123.456')).toBe(true);
    expect(isKrakenThread(db, 'C123', 'OTHER')).toBe(false);
    expect(isKrakenThread(db, 'OTHER', 'T123.456')).toBe(false);
  });

  it('record is idempotent on the same (channel,thread)', () => {
    recordKrakenThread(db, 'C1', 'T1');
    recordKrakenThread(db, 'C1', 'T1');
    const row = db
      .prepare(
        'SELECT COUNT(*) AS n FROM kraken_threads WHERE channel_id=? AND thread_ts=?',
      )
      .get('C1', 'T1') as { n: number };
    expect(row.n).toBe(1);
  });

  it('pruneOldKrakenThreads removes rows older than maxAgeSeconds', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    db.prepare(
      'INSERT INTO kraken_threads (channel_id, thread_ts, created_at) VALUES (?, ?, ?)',
    ).run('OLD', 'T-OLD', nowSec - 10 * 24 * 3600); // 10 days old
    db.prepare(
      'INSERT INTO kraken_threads (channel_id, thread_ts, created_at) VALUES (?, ?, ?)',
    ).run('NEW', 'T-NEW', nowSec - 1 * 3600); // 1 hour old
    pruneOldKrakenThreads(db, 7 * 24 * 3600);
    expect(isKrakenThread(db, 'OLD', 'T-OLD')).toBe(false);
    expect(isKrakenThread(db, 'NEW', 'T-NEW')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/db/kraken-threads.test.ts
```
Expected: FAIL — `Cannot find module '.../kraken-threads.js'`.

- [ ] **Step 3: Implement `src/db/kraken-threads.ts`**

Create `src/db/kraken-threads.ts`:
```typescript
/**
 * kraken_threads helpers — track threads where the bot was @-mentioned at
 * the top level. Used by the Slack message handler to decide whether to
 * forward non-@-mention thread replies to the dispatcher.
 *
 * See SCHEMA_V4 in schema.ts for the table definition.
 */

import type Database from 'better-sqlite3';
import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'kraken-threads' });

/**
 * Record that the bot was @-mentioned at the top of (channelId, threadTs).
 * Idempotent — repeated calls with the same key are no-ops.
 */
export function recordKrakenThread(
  db: Database.Database,
  channelId: string,
  threadTs: string,
): void {
  const nowSec = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT OR IGNORE INTO kraken_threads (channel_id, thread_ts, created_at)
     VALUES (?, ?, ?)`,
  ).run(channelId, threadTs, nowSec);
}

/**
 * Return true iff (channelId, threadTs) is a Kraken-owned thread (the bot
 * was @-mentioned at the thread's top-level message).
 */
export function isKrakenThread(
  db: Database.Database,
  channelId: string,
  threadTs: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM kraken_threads WHERE channel_id=? AND thread_ts=? LIMIT 1`,
    )
    .get(channelId, threadTs) as { 1: number } | undefined;
  return row !== undefined;
}

/**
 * Delete rows older than maxAgeSeconds. Returns the number of rows deleted.
 * Intended to be called once at boot (and later from a scheduled job).
 */
export function pruneOldKrakenThreads(
  db: Database.Database,
  maxAgeSeconds: number,
): number {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
  const result = db
    .prepare(`DELETE FROM kraken_threads WHERE created_at < ?`)
    .run(cutoff);
  if (result.changes > 0) {
    log.info(
      { pruned: result.changes, maxAgeSeconds },
      'kraken_threads: pruned stale rows',
    );
  }
  return result.changes;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/unit/db/kraken-threads.test.ts
```
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/kraken-threads.ts test/unit/db/kraken-threads.test.ts
git commit -m "feat(db): kraken_threads record / lookup / prune helpers

Three sync better-sqlite3 functions over the SCHEMA_V4 kraken_threads table:
recordKrakenThread (INSERT OR IGNORE, idempotent), isKrakenThread (LIMIT 1
existence check), pruneOldKrakenThreads (DELETE rows older than N seconds).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Extend `parseCommand` to recognize `provision`

**Files:**
- Modify: `src/enclave/commands.ts`
- Modify: `test/unit/enclave/commands.test.ts` (likely exists; if not, see Step 1 to create)

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/enclave/commands.test.ts` (or create it):
```typescript
import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../../src/enclave/commands.js';

describe('parseCommand: provision', () => {
  it('matches bare `provision`', () => {
    const parsed = parseCommand('<@U123BOT> provision');
    expect(parsed?.command).toBe('provision');
    expect(parsed?.rawArgs).toBe('');
  });

  it('matches `provision as <name>`', () => {
    const parsed = parseCommand('<@U123BOT> provision as my-enclave');
    expect(parsed?.command).toBe('provision');
    expect(parsed?.rawArgs).toBe('as my-enclave');
  });

  it('matches `provision description <text>`', () => {
    const parsed = parseCommand(
      '<@U123BOT> provision description Test enclave',
    );
    expect(parsed?.command).toBe('provision');
    expect(parsed?.rawArgs).toBe('description Test enclave');
  });

  it('matches `provision as <name> description <text>`', () => {
    const parsed = parseCommand(
      '<@U123BOT> provision as my-enclave description Test enclave from E7',
    );
    expect(parsed?.command).toBe('provision');
    expect(parsed?.rawArgs).toBe(
      'as my-enclave description Test enclave from E7',
    );
  });

  it('does NOT match `provision this channel`', () => {
    // Loose provisioning intent — not the strict deterministic grammar.
    // The handler caller must use PROVISION_PATTERN for usage hints.
    const parsed = parseCommand('<@U123BOT> provision this channel');
    expect(parsed).toBeNull();
  });

  it('provision does NOT require @USER mention (unlike add/remove)', () => {
    const parsed = parseCommand('<@U123BOT> provision as foo');
    expect(parsed).not.toBeNull();
    expect(parsed?.command).toBe('provision');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/enclave/commands.test.ts -t 'provision'
```
Expected: FAIL — parseCommand returns null for the matching strings.

- [ ] **Step 3: Extend `parseCommand` regex in `src/enclave/commands.ts`**

In `src/enclave/commands.ts`, locate the regex inside `parseCommand`:
```typescript
const match = cleaned.match(
  /^(add|remove|members|whoami|set\s+mode|show\s+prompts|show\s+prompt|show\s+templates|show\s+template|help)\s*(.*)/i,
);
```

Replace with:
```typescript
const match = cleaned.match(
  /^(add|remove|members|whoami|set\s+mode|show\s+prompts|show\s+prompt|show\s+templates|show\s+template|help|provision)\s*(.*)/i,
);
```

Then locate the rawArgs validation block:
```typescript
if (command === 'add' || command === 'remove') {
  if (!/<@[A-Z0-9_]+>/i.test(rawArgs)) {
    return null;
  }
}
```

Add a `provision`-specific post-match check immediately AFTER that block, BEFORE the `return { command, args, rawArgs };`. This enforces the strict provision grammar:
```typescript
if (command === 'provision') {
  // Strict grammar: either no args, or `as <name>`, or `description <text>`,
  // or both `as <name> description <text>` (in that order).
  // Loose phrasing like "provision this channel" must NOT match — fall
  // through to PROVISION_PATTERN usage-hint handling in bot.ts.
  const provArgsRe =
    /^(?:as\s+\S+)?(?:\s*description\s+.+)?$|^description\s+.+$/i;
  if (rawArgs.length > 0 && !provArgsRe.test(rawArgs)) {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/unit/enclave/commands.test.ts -t 'provision'
```
Expected: PASS — 6 tests.

Also run the full commands test file to make sure existing tests still pass:
```bash
npx vitest run test/unit/enclave/commands.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/enclave/commands.ts test/unit/enclave/commands.test.ts
git commit -m "feat(enclave): parseCommand recognizes \`provision [as <name>] [description <desc>]\`

Adds the deterministic provisioning grammar to the existing command parser.
Unlike add/remove, provision does NOT require a <@USER> mention.
Strict grammar enforced inline: loose phrasings like 'provision this channel'
return null and fall through to PROVISION_PATTERN handling in bot.ts.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: `handleProvision` handler — happy path

**Files:**
- Create: `src/enclave/handlers/provisioning.ts`
- Create: `test/unit/enclave/handlers/provisioning.test.ts`

- [ ] **Step 1: Write the failing test (happy path: no args, channel name default)**

Create `test/unit/enclave/handlers/provisioning.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleProvision } from '../../../../src/enclave/handlers/provisioning.js';
import type { ProvisionContext } from '../../../../src/enclave/handlers/provisioning.js';

function mkCtx(overrides: Partial<ProvisionContext> = {}): ProvisionContext {
  const sent: string[] = [];
  return {
    channelId: 'C123',
    channelName: 'voyager-agentic-flows',
    channelTopic: '',
    senderSlackId: 'U_ALICE',
    userEmail: 'alice@example.com',
    userSub: 'KEYCLOAK-SUB-1',
    mcpCall: vi.fn(async () => ({ name: 'voyager-agentic-flows' })),
    insertBinding: vi.fn(),
    recordKrakenThread: vi.fn(),
    lookupEnclave: vi.fn(() => null),
    sendMessage: vi.fn(async (text: string) => {
      sent.push(text);
    }),
    threadTs: 'T1',
    ...overrides,
    // Expose collected messages for assertions
    _sent: sent,
  } as ProvisionContext & { _sent: string[] };
}

describe('handleProvision: defaults', () => {
  it('uses channel name as enclave name when no args', async () => {
    const ctx = mkCtx() as ProvisionContext & { _sent: string[] };
    await handleProvision('', ctx);
    expect(ctx.mcpCall).toHaveBeenCalledWith('enclave_provision', {
      name: 'voyager-agentic-flows',
      description: 'Workflow channel for #voyager-agentic-flows',
      owner_email: 'alice@example.com',
      owner_sub: 'KEYCLOAK-SUB-1',
      platform: 'slack',
      channel_id: 'C123',
      channel_name: 'voyager-agentic-flows',
    });
    expect(ctx.insertBinding).toHaveBeenCalledWith(
      'C123',
      'voyager-agentic-flows',
      'U_ALICE',
    );
    expect(ctx._sent[0]).toMatch(/Done\. Enclave `voyager-agentic-flows` is live/);
  });

  it('uses channel topic as description when present', async () => {
    const ctx = mkCtx({
      channelTopic: 'Voyager group workflows',
    }) as ProvisionContext & { _sent: string[] };
    await handleProvision('', ctx);
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'enclave_provision',
      expect.objectContaining({ description: 'Voyager group workflows' }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/enclave/handlers/provisioning.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/enclave/handlers/provisioning.ts`**

Create `src/enclave/handlers/provisioning.ts`:
```typescript
/**
 * Deterministic provisioning handler.
 *
 * @kraken provision [as <name>] [description <desc>]
 *
 * Replaces the LLM-driven provisioning flow in smart-path. Defaults the
 * enclave name to the channel name and the description to the channel topic
 * (or a generic fallback). Validates the name against the enclave-name regex.
 * Calls enclave_provision via MCP and inserts the local binding on success.
 *
 * Spec: docs/superpowers/specs/2026-05-27-deterministic-provisioning-design.md
 */

import { createChildLogger } from '../../logger.js';

const log = createChildLogger({ module: 'provision-handler' });

const ENCLAVE_NAME_RE = /^[a-z0-9-]{1,63}$/;

/**
 * Context required by handleProvision. Passed by the bot.ts unbound-channel
 * branch which has access to the Slack client (for channel info), bindings
 * engine, MCP call function, and kraken-threads db.
 */
export interface ProvisionContext {
  channelId: string;
  channelName: string;
  channelTopic: string;
  senderSlackId: string;
  userEmail: string;
  userSub: string;
  threadTs: string;
  mcpCall: (tool: string, params: Record<string, unknown>) => Promise<unknown>;
  insertBinding: (
    channelId: string,
    enclaveName: string,
    ownerSlackId: string,
  ) => void;
  recordKrakenThread: (channelId: string, threadTs: string) => void;
  lookupEnclave: (
    channelId: string,
  ) => { enclaveName: string } | null;
  sendMessage: (text: string) => Promise<void>;
}

interface ParsedArgs {
  name?: string;
  description?: string;
}

/**
 * Parse the rawArgs from parseCommand for the provision command.
 * Grammar (already validated by parseCommand):
 *   <empty> | `as <name>` | `description <text>` | `as <name> description <text>`
 */
function parseProvisionArgs(rawArgs: string): ParsedArgs {
  const out: ParsedArgs = {};
  const asMatch = rawArgs.match(/^as\s+(\S+)(?:\s+description\s+(.+))?$/i);
  if (asMatch) {
    out.name = asMatch[1];
    if (asMatch[2]) out.description = asMatch[2];
    return out;
  }
  const descMatch = rawArgs.match(/^description\s+(.+)$/i);
  if (descMatch) {
    out.description = descMatch[1];
  }
  return out;
}

export async function handleProvision(
  rawArgs: string,
  ctx: ProvisionContext,
): Promise<void> {
  // Step 1: parse optional overrides
  const overrides = parseProvisionArgs(rawArgs);

  // Step 2: compute defaults
  const name = overrides.name ?? ctx.channelName;
  const description =
    overrides.description ??
    (ctx.channelTopic.trim().length > 0
      ? ctx.channelTopic.trim()
      : `Workflow channel for #${ctx.channelName}`);

  // Step 3: validate name
  if (!ENCLAVE_NAME_RE.test(name)) {
    log.warn(
      { name, channelName: ctx.channelName, channelId: ctx.channelId },
      'provision: invalid enclave name',
    );
    await ctx.sendMessage(
      `\`${name}\` isn't a valid enclave name (must be lowercase letters, digits, hyphens; 1-63 chars). Use \`@kraken provision as my-enclave\` to specify one.`,
    );
    return;
  }

  // Step 4: reject if already bound
  const existing = ctx.lookupEnclave(ctx.channelId);
  if (existing) {
    await ctx.sendMessage(
      `This channel is already enclave \`${existing.enclaveName}\`. Use \`@kraken status\` to see what's there.`,
    );
    return;
  }

  // Step 5: call enclave_provision via MCP
  log.info(
    {
      name,
      description,
      channelId: ctx.channelId,
      channelName: ctx.channelName,
      userEmail: ctx.userEmail,
    },
    'provision: calling enclave_provision',
  );
  try {
    await ctx.mcpCall('enclave_provision', {
      name,
      description,
      owner_email: ctx.userEmail,
      owner_sub: ctx.userSub,
      platform: 'slack',
      channel_id: ctx.channelId,
      channel_name: ctx.channelName,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { err, name, channelId: ctx.channelId },
      'provision: enclave_provision failed',
    );
    await ctx.sendMessage(`Provisioning failed: ${msg}`);
    return;
  }

  // Step 6: insert local binding + record kraken thread
  ctx.insertBinding(ctx.channelId, name, ctx.senderSlackId);
  ctx.recordKrakenThread(ctx.channelId, ctx.threadTs);

  // Step 7: reply
  await ctx.sendMessage(
    `Done. Enclave \`${name}\` is live. Anyone in this channel can now @kraken to interact.`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/unit/enclave/handlers/provisioning.test.ts
```
Expected: PASS — 2 tests in 'defaults' describe.

- [ ] **Step 5: Commit**

```bash
git add src/enclave/handlers/provisioning.ts test/unit/enclave/handlers/provisioning.test.ts
git commit -m "feat(enclave): handleProvision deterministic handler — happy path

Defaults enclave name to channel name and description to channel topic
(or 'Workflow channel for #<channel>'). Calls enclave_provision via MCP,
inserts local binding, records the kraken_threads entry for the thread,
replies with success.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: `handleProvision` — overrides + validation + already-bound + MCP-error

**Files:**
- Modify: `test/unit/enclave/handlers/provisioning.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/enclave/handlers/provisioning.test.ts`:
```typescript
describe('handleProvision: overrides', () => {
  it('uses `as <name>` to override the enclave name', async () => {
    const ctx = mkCtx() as ProvisionContext & { _sent: string[] };
    await handleProvision('as my-custom-name', ctx);
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'enclave_provision',
      expect.objectContaining({ name: 'my-custom-name' }),
    );
    expect(ctx.insertBinding).toHaveBeenCalledWith(
      'C123',
      'my-custom-name',
      'U_ALICE',
    );
  });

  it('uses `description <text>` to override the description', async () => {
    const ctx = mkCtx() as ProvisionContext & { _sent: string[] };
    await handleProvision('description Custom description here', ctx);
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'enclave_provision',
      expect.objectContaining({
        description: 'Custom description here',
        name: 'voyager-agentic-flows', // unchanged
      }),
    );
  });

  it('uses both overrides when provided together', async () => {
    const ctx = mkCtx() as ProvisionContext & { _sent: string[] };
    await handleProvision('as foo description Bar baz quux', ctx);
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'enclave_provision',
      expect.objectContaining({
        name: 'foo',
        description: 'Bar baz quux',
      }),
    );
  });
});

describe('handleProvision: validation', () => {
  it('rejects channel-name default that fails enclave-name regex', async () => {
    const ctx = mkCtx({ channelName: 'BadName_WithStuff' }) as ProvisionContext & {
      _sent: string[];
    };
    await handleProvision('', ctx);
    expect(ctx.mcpCall).not.toHaveBeenCalled();
    expect(ctx.insertBinding).not.toHaveBeenCalled();
    expect(ctx._sent[0]).toMatch(
      /`BadName_WithStuff` isn't a valid enclave name/,
    );
  });

  it('rejects explicit name that fails regex', async () => {
    const ctx = mkCtx() as ProvisionContext & { _sent: string[] };
    await handleProvision('as Has_Underscores', ctx);
    expect(ctx.mcpCall).not.toHaveBeenCalled();
    expect(ctx._sent[0]).toMatch(/isn't a valid enclave name/);
  });
});

describe('handleProvision: already bound', () => {
  it('refuses when channel is already an enclave', async () => {
    const ctx = mkCtx({
      lookupEnclave: vi.fn(() => ({ enclaveName: 'existing' })),
    }) as ProvisionContext & { _sent: string[] };
    await handleProvision('', ctx);
    expect(ctx.mcpCall).not.toHaveBeenCalled();
    expect(ctx._sent[0]).toMatch(/already enclave `existing`/);
  });
});

describe('handleProvision: MCP error', () => {
  it('echoes MCP failure message verbatim', async () => {
    const ctx = mkCtx({
      mcpCall: vi.fn(async () => {
        throw new Error('forbidden: owner_sub empty');
      }),
    }) as ProvisionContext & { _sent: string[] };
    await handleProvision('', ctx);
    expect(ctx.insertBinding).not.toHaveBeenCalled();
    expect(ctx._sent[0]).toBe('Provisioning failed: forbidden: owner_sub empty');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/enclave/handlers/provisioning.test.ts
```
Expected: SOME PASS (happy path from Task 4), validation/error tests PASS (handler already implements these from Task 4). If everything passes, that confirms Task 4 implementation already covered these — proceed to commit.

If any test fails, fix the handler. The Task 4 implementation should already handle all of these branches.

- [ ] **Step 3: Run full provisioning.test.ts and confirm all pass**

```bash
npx vitest run test/unit/enclave/handlers/provisioning.test.ts
```
Expected: ALL PASS (now 9 tests across 4 describes).

- [ ] **Step 4: Commit**

```bash
git add test/unit/enclave/handlers/provisioning.test.ts
git commit -m "test(enclave): handleProvision overrides + validation + already-bound + MCP-error

Covers: \`as <name>\`, \`description <text>\`, combined overrides, name
regex rejection (both default and explicit), channel-already-bound, and
MCP error passthrough.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Wire `provision` command into `executeCommand` dispatcher

**Files:**
- Modify: `src/enclave/commands.ts`

- [ ] **Step 1: Read existing executeCommand switch**

In `src/enclave/commands.ts`, the `executeCommand` function has a switch statement on `parsed.command`. The handlers it dispatches to (`handleAddMember`, `handleRemoveMember`, etc.) take `(rawArgs, ctx)` or `(ctx)` etc.

`handleProvision` from Task 4 takes a richer `ProvisionContext` than the existing `CommandContext`. The dispatch needs to build the richer context. The cleanest path: in this task, ONLY add the switch case that throws "provision must be dispatched directly from bot.ts" — then in Task 8, bot.ts calls `handleProvision` BEFORE entering the standard `executeCommand` flow.

- [ ] **Step 2: Write the failing test**

Append to `test/unit/enclave/commands.test.ts`:
```typescript
import { executeCommand } from '../../../src/enclave/commands.js';

describe('executeCommand: provision', () => {
  it('refuses to dispatch provision through the standard switch', async () => {
    const sent: string[] = [];
    const ctx = {
      channelId: 'C1',
      threadTs: 'T1',
      senderSlackId: 'U1',
      enclaveName: '',
      mcpCall: async () => ({}),
      sendMessage: async (text: string) => {
        sent.push(text);
      },
      resolveEmail: async () => undefined,
    };
    await executeCommand(
      { command: 'provision', args: [], rawArgs: '' },
      ctx,
    );
    // executeCommand falls into the unrecognized-command branch (the
    // default), since 'provision' is not in the switch. The reply is
    // the standard "I don't recognise that command" message.
    expect(sent[0]).toMatch(/don't recognise that command/);
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

```bash
npx vitest run test/unit/enclave/commands.test.ts -t 'executeCommand: provision'
```
Expected: PASS — `provision` is not in executeCommand's switch, so it falls into the default branch which sends the "I don't recognise that command" reply.

This is intentional: `provision` is dispatched directly from `bot.ts` (Task 8) because it needs a richer context than `CommandContext`. The `executeCommand` switch never sees it. If something does dispatch `provision` through `executeCommand` (defensive case), the user sees a clear error.

- [ ] **Step 4: Commit**

```bash
git add test/unit/enclave/commands.test.ts
git commit -m "test(enclave): document that executeCommand does NOT dispatch provision

provision is dispatched directly from bot.ts (Task 8) because it needs
channelName, channelTopic, userEmail, and other fields not present on
CommandContext. The standard executeCommand switch never sees it; if
something accidentally dispatches it via this path, the default branch
returns the standard 'unrecognised command' reply.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Populate `kraken_threads` on top-level `app_mention`

**Files:**
- Modify: `src/slack/bot.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/slack-bot.test.ts` (or create if absent — there's an existing slack-bot.test.ts per the previous codebase exploration).

If creating new, prepend with the existing imports + bot construction harness. For brevity, the test below assumes the existing harness `mkBot()` helper exists; if not, the engineer should mirror the harness from existing tests in the file:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { recordKrakenThread } from '../../src/db/kraken-threads.js';
// Plus the existing slack-bot.test.ts harness imports

describe('app_mention: kraken_threads population', () => {
  it('records the thread when @-mention is top-level (no thread_ts)', async () => {
    const { app, db } = mkBot();
    await app.handlers.app_mention({
      event: {
        type: 'app_mention',
        channel: 'C1',
        ts: '1234.5',
        user: 'U_ALICE',
        text: '<@U_BOT> status',
      },
      // ... other mock fields
    });
    // After processing, kraken_threads should have the row
    const row = db
      .prepare(
        'SELECT 1 FROM kraken_threads WHERE channel_id=? AND thread_ts=?',
      )
      .get('C1', '1234.5');
    expect(row).toBeDefined();
  });

  it('records the thread when @-mention started the thread (thread_ts == ts)', async () => {
    const { app, db } = mkBot();
    await app.handlers.app_mention({
      event: {
        type: 'app_mention',
        channel: 'C1',
        ts: '1234.5',
        thread_ts: '1234.5', // mention started the thread
        user: 'U_ALICE',
        text: '<@U_BOT> status',
      },
    });
    const row = db
      .prepare(
        'SELECT 1 FROM kraken_threads WHERE channel_id=? AND thread_ts=?',
      )
      .get('C1', '1234.5');
    expect(row).toBeDefined();
  });

  it('does NOT record when @-mention is a reply in an existing thread', async () => {
    const { app, db } = mkBot();
    await app.handlers.app_mention({
      event: {
        type: 'app_mention',
        channel: 'C1',
        ts: '9999.9',
        thread_ts: '1234.5', // reply in a thread started earlier
        user: 'U_ALICE',
        text: '<@U_BOT> follow up',
      },
    });
    // The reply doesn't start a new owned thread; only the original mention
    // (which created thread 1234.5) would have recorded it.
    const row = db
      .prepare(
        'SELECT 1 FROM kraken_threads WHERE channel_id=? AND thread_ts=?',
      )
      .get('C1', '9999.9');
    expect(row).toBeUndefined();
  });
});
```

NOTE: the actual harness shape (`mkBot()`, app.handlers) depends on the existing test setup. The implementer should read `test/unit/slack-bot.test.ts` and mirror its pattern (likely uses Slack Bolt's Receiver mock).

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/slack-bot.test.ts -t 'kraken_threads population'
```
Expected: FAIL — `kraken_threads` rows do not exist (handler isn't populating).

- [ ] **Step 3: Implement the population in `src/slack/bot.ts`**

In the `app_mention` handler in `src/slack/bot.ts` (around line 297-510, inside the existing `app.event('app_mention', ...)` block), at the very top of the handler (right after extracting `channelId`, `threadTs`, `userId`, `text`), add:

```typescript
// Track this thread as "Kraken-owned" if the @-mention is a top-level
// thread starter. Used by the message handler to forward non-@-mention
// thread replies to the dispatcher (the user's directive: within a
// Kraken thread, mentioning the bot should not be necessary).
const eventTs = (event as { ts: string }).ts;
const isTopLevelMention = !threadTs || threadTs === eventTs;
if (isTopLevelMention) {
  recordKrakenThread(deps.db, channelId, eventTs);
}
```

Also add the import at the top of `src/slack/bot.ts`:
```typescript
import { recordKrakenThread } from '../db/kraken-threads.js';
```

And ensure `deps.db` is the existing better-sqlite3 Database instance passed to `createSlackBot` (it is — see existing usage in bot.ts for `deps.bindings`, `deps.outbound`, etc., and the createSlackBot deps in `src/index.ts`). If `db` is not yet in `SlackBotDeps`, add it.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/unit/slack-bot.test.ts -t 'kraken_threads population'
```
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/slack/bot.ts test/unit/slack-bot.test.ts
git commit -m "feat(slack): record kraken_threads on top-level app_mention

When the bot is @-mentioned as either a top-level channel message or as
the first message in a new thread, record (channel_id, thread_ts) in the
kraken_threads table. Replies in that thread (with or without @-mention)
will then be forwarded to the dispatcher by the message handler (Task 8).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Replace `isBoundChannel && isThreadReply` gate with `isKrakenThread`

**Files:**
- Modify: `src/slack/bot.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/slack-bot.test.ts`:
```typescript
describe('message handler: kraken_threads gate', () => {
  it('forwards thread reply when thread is Kraken-owned', async () => {
    const { app, db, dispatched } = mkBot();
    // Prime kraken_threads
    db.prepare(
      'INSERT INTO kraken_threads (channel_id, thread_ts, created_at) VALUES (?, ?, ?)',
    ).run('C1', '1234.5', Math.floor(Date.now() / 1000));

    await app.handlers.message({
      event: {
        type: 'message',
        channel: 'C1',
        ts: '5678.9',
        thread_ts: '1234.5',
        user: 'U_ALICE',
        text: 'follow up no mention',
        channel_type: 'channel',
      },
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].text).toBe('follow up no mention');
  });

  it('does NOT forward thread reply when thread is NOT Kraken-owned', async () => {
    const { app, dispatched } = mkBot();
    // No kraken_threads row inserted

    await app.handlers.message({
      event: {
        type: 'message',
        channel: 'C1',
        ts: '5678.9',
        thread_ts: '9999.9',
        user: 'U_ALICE',
        text: 'random chatter',
        channel_type: 'channel',
      },
    });
    expect(dispatched).toHaveLength(0);
  });

  it('forwards all DMs (channel_type=im) regardless of kraken_threads', async () => {
    const { app, dispatched } = mkBot();
    await app.handlers.message({
      event: {
        type: 'message',
        channel: 'D1',
        ts: '5678.9',
        user: 'U_ALICE',
        text: 'hello in DM',
        channel_type: 'im',
      },
    });
    expect(dispatched).toHaveLength(1);
  });

  it('does NOT forward top-level channel messages without @mention', async () => {
    const { app, dispatched } = mkBot();
    await app.handlers.message({
      event: {
        type: 'message',
        channel: 'C1',
        ts: '5678.9',
        user: 'U_ALICE',
        text: 'top-level chatter',
        channel_type: 'channel',
      },
    });
    expect(dispatched).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/slack-bot.test.ts -t 'kraken_threads gate'
```
Expected: FAIL — the existing gate uses `isBoundChannel`, so a thread reply in an unbound channel is dropped even if a kraken_threads row exists.

- [ ] **Step 3: Replace the gate in `src/slack/bot.ts`**

In `src/slack/bot.ts`, locate the message handler around line 662 onward. Find this block:

```typescript
const isBoundChannel = !!deps.bindings.lookupEnclave(channelId);
const eventTs = 'ts' in event ? (event as { ts: string }).ts : undefined;
const isThreadReply = !!threadTs && threadTs !== eventTs;
if (channelType !== 'im' && !(isBoundChannel && isThreadReply)) return;
```

Replace with:
```typescript
const eventTs = 'ts' in event ? (event as { ts: string }).ts : undefined;
const isThreadReply = !!threadTs && threadTs !== eventTs;
// Forward to dispatcher when:
//   - DM (channel_type === 'im'), OR
//   - Thread reply in a Kraken-owned thread (the top-level message of
//     this thread was a @-mention of the bot — see kraken_threads).
// Bound-channel @-mentions are handled by the app_mention handler,
// so we do NOT special-case them here.
const isOwnedThread =
  isThreadReply && threadTs !== undefined && isKrakenThread(deps.db, channelId, threadTs);
if (channelType !== 'im' && !isOwnedThread) return;
```

Add the import at the top of `src/slack/bot.ts`:
```typescript
import { isKrakenThread } from '../db/kraken-threads.js';
```

Note: `recordKrakenThread` was added in Task 7; this task adds `isKrakenThread` to the same import.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/unit/slack-bot.test.ts -t 'kraken_threads gate'
```
Expected: PASS — 4 tests.

Also run the full slack-bot test file to ensure no regressions:
```bash
npx vitest run test/unit/slack-bot.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/slack/bot.ts test/unit/slack-bot.test.ts
git commit -m "feat(slack): replace isBoundChannel thread-reply gate with isKrakenThread

The message handler previously required isBoundChannel AND isThreadReply
to forward non-@-mention messages. This dropped thread replies in
unbound channels — including the channel being provisioned, breaking
multi-turn flows.

Now: any thread reply in a Kraken-owned thread (one started by a bot
@-mention) is forwarded, regardless of bind state. DMs forward as
before. Random top-level channel messages and replies in non-owned
threads stay ignored.

Implements the user's directive: 'within a thread, mentioning the
kraken should not be necessary'.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Restructure unbound-channel `app_mention` branch

**Files:**
- Modify: `src/slack/bot.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/slack-bot.test.ts`:
```typescript
describe('app_mention: unbound channel provisioning', () => {
  it('dispatches @kraken provision to handleProvision', async () => {
    const { app, provisionCalls } = mkBot({
      // Mock channel info: name="voyager", topic="Workflows"
      conversationsInfo: vi.fn(async () => ({
        ok: true,
        channel: { name: 'voyager', topic: { value: 'Workflows' } },
      })),
    });
    await app.handlers.app_mention({
      event: {
        type: 'app_mention',
        channel: 'C_NEW',
        ts: '1.1',
        user: 'U_ALICE',
        text: '<@U_BOT> provision',
      },
    });
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0].rawArgs).toBe('');
    expect(provisionCalls[0].channelName).toBe('voyager');
  });

  it('replies with usage hint on PROVISION_PATTERN match but not strict command', async () => {
    const { app, said } = mkBot();
    await app.handlers.app_mention({
      event: {
        type: 'app_mention',
        channel: 'C_NEW',
        ts: '1.1',
        user: 'U_ALICE',
        text: '<@U_BOT> provision this channel as an enclave please',
      },
    });
    // PROVISION_PATTERN matches but parseCommand does not.
    expect(said[0]).toMatch(/To provision this channel as an enclave/);
    expect(said[0]).toMatch(/`@The Kraken provision`/);
  });

  it('replies with terse non-enclave message for unrelated mention', async () => {
    const { app, said } = mkBot();
    await app.handlers.app_mention({
      event: {
        type: 'app_mention',
        channel: 'C_NEW',
        ts: '1.1',
        user: 'U_ALICE',
        text: '<@U_BOT> what is the meaning of life?',
      },
    });
    expect(said[0]).toMatch(/isn't set up as an enclave yet/);
    expect(said[0]).toMatch(/@Kraken provision/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/slack-bot.test.ts -t 'unbound channel provisioning'
```
Expected: FAIL — current unbound-channel branch routes everything through smart-path's `mode: 'provision'`, doesn't call `handleProvision` directly.

- [ ] **Step 3: Restructure `app_mention` unbound-channel branch in `src/slack/bot.ts`**

In `src/slack/bot.ts`, locate the unbound-channel branch in the `app_mention` handler (around lines 322-398, guarded by `if (!binding)`).

Replace the WHOLE `if (!binding) { ... }` body with:

```typescript
if (!binding) {
  // Step 1: try parsing as a deterministic command (provision).
  const parsed = parseCommand(text);
  if (parsed && parsed.command === 'provision') {
    // Authenticate first.
    const provisionToken = await checkAuthOrPrompt(userId, channelId, client);
    if (provisionToken === null) return;
    // Look up channel name + topic from Slack
    let channelName = channelId;
    let channelTopic = '';
    try {
      const info = await client.conversations.info({ channel: channelId });
      channelName =
        ((info.channel as { name?: string })?.name) ?? channelId;
      channelTopic =
        ((info.channel as { topic?: { value?: string } })?.topic?.value) ?? '';
    } catch (err) {
      log.warn({ err, channelId }, 'conversations.info failed in provision');
    }
    // Resolve user email + sub from the OIDC token
    const { email: userEmail, sub: userSub } = extractIdentityFromToken(provisionToken);
    const mcpCall =
      deps.getMcpCallForToken?.(provisionToken) ?? deps.mcpCall;
    if (!mcpCall) {
      await say({
        text: 'Internal error: no MCP client factory configured.',
        thread_ts: threadTs ?? (event as { ts: string }).ts,
      });
      span.setStatus({ code: SpanStatusCode.OK });
      return;
    }
    await handleProvision(parsed.rawArgs, {
      channelId,
      channelName,
      channelTopic,
      senderSlackId: userId,
      userEmail,
      userSub,
      threadTs: threadTs ?? (event as { ts: string }).ts,
      mcpCall,
      insertBinding: (cId, name, owner) =>
        deps.bindings.insertBinding(cId, name, owner),
      recordKrakenThread: (cId, tTs) => recordKrakenThread(deps.db, cId, tTs),
      lookupEnclave: (cId) => deps.bindings.lookupEnclave(cId),
      sendMessage: async (msg) => {
        await say({
          text: msg,
          thread_ts: threadTs ?? (event as { ts: string }).ts,
        });
      },
    });
    span.setStatus({ code: SpanStatusCode.OK });
    return;
  }

  // Step 2: loose provision intent (PROVISION_PATTERN) — usage hint.
  if (PROVISION_PATTERN.test(text)) {
    let channelName = channelId;
    try {
      const info = await client.conversations.info({ channel: channelId });
      channelName = ((info.channel as { name?: string })?.name) ?? channelId;
    } catch {
      // non-fatal
    }
    await say({
      text:
        `To provision this channel as an enclave, say ` +
        `\`@The Kraken provision\` (uses channel name \`${channelName}\`) or ` +
        `\`@The Kraken provision as my-enclave\` to choose a different name.`,
      thread_ts: threadTs ?? (event as { ts: string }).ts,
    });
    span.setStatus({ code: SpanStatusCode.OK });
    return;
  }

  // Step 3: completely unrelated mention — terse hint.
  await say({
    thread_ts: threadTs ?? (event as { ts: string }).ts,
    text:
      "This channel isn't set up as an enclave yet. To get started, say " +
      '`@Kraken provision`.',
  });
  span.setStatus({ code: SpanStatusCode.OK });
  return;
}
```

Add imports at the top of `src/slack/bot.ts`:
```typescript
import { handleProvision } from '../enclave/handlers/provisioning.js';
// recordKrakenThread already imported in Task 7
```

You also need a helper `extractIdentityFromToken(token: string)`. If one already exists in `src/auth/` (e.g., as part of `extractEmailFromToken`), use it. If not, create a sibling in `src/auth/oidc.ts` or wherever the existing email extraction lives:
```typescript
export function extractIdentityFromToken(token: string): {
  email: string;
  sub: string;
} {
  // Parse JWT payload (base64url decode middle segment); return { email, sub }
  // Mirrors the existing extractEmailFromToken function.
  const payload = JSON.parse(
    Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as { email?: string; sub?: string };
  return {
    email: payload.email ?? '',
    sub: payload.sub ?? '',
  };
}
```

Or, if `extractEmailFromToken` already returns the parsed payload, reuse it. The engineer should grep `src/auth/` for the existing extractor pattern and prefer reuse.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/unit/slack-bot.test.ts -t 'unbound channel provisioning'
```
Expected: PASS — 3 tests.

Full file check:
```bash
npx vitest run test/unit/slack-bot.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/slack/bot.ts src/auth/oidc.ts test/unit/slack-bot.test.ts
git commit -m "feat(slack): unbound-channel app_mention runs parseCommand for provision

Restructures the unbound-channel branch to:
1. Run parseCommand first; if the result is 'provision', dispatch to
   handleProvision with fresh channel info + identity from OIDC token.
2. Otherwise, if the message matches the loose PROVISION_PATTERN,
   reply with a usage hint pointing at the deterministic grammar.
3. Otherwise, reply with the terse 'isn't set up as an enclave yet'
   message that now references @Kraken provision.

Removes the smart-path mode='provision' call site entirely.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: Remove provision mode from smart-path + router

**Files:**
- Modify: `src/dispatcher/smart-path.ts`
- Modify: `src/dispatcher/router.ts`
- Modify: `test/unit/dispatcher-router.test.ts`

- [ ] **Step 1: Update router test (failing because router still returns 'provision')**

In `test/unit/dispatcher-router.test.ts`, find the existing routing matrix test. Remove any case row that expects `path: 'smart', reason: 'provision'`. Add or modify a case row asserting that an unbound-channel + provision-pattern message returns `path: 'deterministic', action: { type: 'ignore_unbound' }`:

```typescript
it('unbound channel + provision-pattern returns ignore_unbound (handled by bot.ts app_mention)', () => {
  const decision = routeEvent(
    {
      type: 'app_mention',
      channelId: 'C_NEW',
      channelType: 'channel',
      threadTs: undefined,
      userId: 'U_ALICE',
      text: '<@U_BOT> provision',
    },
    {
      bindings: { lookupEnclave: () => null },
    } as RouterDeps,
  );
  expect(decision.path).toBe('deterministic');
  if (decision.path === 'deterministic') {
    expect(decision.action.type).toBe('ignore_unbound');
  }
});
```

Adjust other tests that assert `reason: 'provision'` — they should be removed.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/dispatcher-router.test.ts
```
Expected: existing 'provision' test cases FAIL; new ones FAIL because router still returns smart-path provision.

- [ ] **Step 3: Remove `provision` from `SmartReason` and `routeEvent` in `src/dispatcher/router.ts`**

In `src/dispatcher/router.ts`:
- Remove `'provision'` from the `SmartReason` union type.
- In `classifySmartReason`, remove any branch that returns `'provision'`.
- In `routeEvent`, remove any branch that returns `path: 'smart', reason: 'provision'`. For unbound-channel + provision-pattern: just fall through to `ignore_unbound` (the existing default for unbound channels). The bot.ts app_mention handler (Task 9) now handles the actual provision command directly — the router doesn't need to know about provision at all.

- [ ] **Step 4: Remove provision mode from `src/dispatcher/smart-path.ts`**

In `src/dispatcher/smart-path.ts`:
- Change `export type SmartPathMode = 'dm' | 'provision';` to `export type SmartPathMode = 'dm';`
- In `MODE_TOOL_ALLOWLIST`, remove the `provision` key entry.
- Remove the `buildProvisioningPrompt` function entirely.
- In `runSmartPath`, simplify the `systemPrompt` assignment from `input.mode === 'provision' ? buildProvisioningPrompt(...) : buildDmSystemPrompt(userEmail)` to just `buildDmSystemPrompt(userEmail)`.
- Remove the `channelId`, `channelName` fields from `SmartContext` and `runSmartPath` input if they were only used by the provision prompt. (Keep them if other code references them — grep `SmartContext` to verify.)
- Update jsdoc comments to drop provisioning references.

- [ ] **Step 5: Remove smart-path provision call site in `src/slack/bot.ts`**

The Task 9 restructure already removed the `onSmartPath` call with `mode: 'provision'`. Verify by greping `src/slack/bot.ts`:
```bash
grep -n "mode.*provision\|'provision'" src/slack/bot.ts
```
Expected: NO matches (other than possibly the `PROVISION_PATTERN` regex which is fine).

- [ ] **Step 6: Run test to verify it passes**

```bash
npx vitest run test/unit/dispatcher-router.test.ts
```
Expected: all PASS.

Full unit-test sweep to catch other usages:
```bash
npx vitest run
```
Expected: all PASS. If something fails (e.g., a test still references `SmartPathMode = 'provision'`), update it.

- [ ] **Step 7: Verify typecheck**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/dispatcher/smart-path.ts src/dispatcher/router.ts test/unit/dispatcher-router.test.ts
git commit -m "refactor(dispatcher): remove provision mode from smart-path and router

smart-path no longer handles enclave provisioning — that's now a
deterministic command parsed by the slack bot directly (Tasks 3-9).
SmartPathMode is now just 'dm'. SmartReason no longer includes
'provision'. buildProvisioningPrompt deleted entirely.

Router for unbound-channel + provision-pattern returns ignore_unbound;
the actual provision command parsing happens in bot.ts app_mention.

L group (DM smart-path lockdown) and M group (git-state UX) are unaffected
because they exercise mode='dm' or the bound-enclave manager team.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: Update Kraken skill markdown

**Files:**
- Modify: `skills/kraken/SKILL.md`
- Modify: `skills/kraken/references/slack-ux.md`
- Modify: `skills/kraken/references/thread-model.md`

- [ ] **Step 1: Read existing SKILL.md Path 1 section**

```bash
grep -n -A 10 "Path 1\|enclave_provision\|enclave_deprovision\|enclave_sync" /Users/rbias/code/tentacular-main/thekraken/skills/kraken/SKILL.md | head -30
```

- [ ] **Step 2: Update `skills/kraken/SKILL.md`**

Remove `enclave_provision` from the Path 1 manager tool list. Search the file for the exact phrase listing manager MCP tools (likely a bullet list under "Path 1" or "## MCP Tools"). The current Path 1 description includes "ALL enclave management: enclave_provision, enclave_deprovision, ..." (per `grep` from earlier brainstorming).

Find and modify:
- Replace "enclave_provision, enclave_deprovision, enclave_sync" with "enclave_deprovision, enclave_sync" (drop provision).
- Replace "provisioning, deprovisioning, and member sync are direct MCP calls" with "deprovisioning and member sync are direct MCP calls; provisioning is a dispatcher-level command (see references/slack-ux.md)".
- Where `enclave_provision` is listed as a Path 1 tool (the table around line 144 per earlier grep), remove that row.

- [ ] **Step 3: Update `skills/kraken/references/slack-ux.md`**

Add a new section near the existing command documentation:
```markdown
## @kraken provision command (dispatcher-level)

The Kraken's dispatcher handles enclave provisioning as a deterministic
command. The enclave manager never provisions — by the time the manager
is running, the enclave is already bound.

Grammar (from a Slack channel that is NOT yet bound to an enclave):

  @The Kraken provision
  @The Kraken provision as <enclave-name>
  @The Kraken provision description <text>
  @The Kraken provision as <enclave-name> description <text>

Defaults:
- `name` = channel name (validated: lowercase, alphanumeric, hyphens, max 63 chars)
- `description` = channel topic if set, else `Workflow channel for #<channel>`

If the channel name doesn't validate as a valid enclave name, the
dispatcher refuses with a clear message asking for an explicit name.

If the channel is already an enclave, the dispatcher refuses with a
pointer to `@kraken status`.
```

- [ ] **Step 4: Update `skills/kraken/references/thread-model.md`**

Add a new section:
```markdown
## Thread participation rule

A Slack thread is "Kraken-owned" if and only if the top-level message
that started the thread @-mentioned The Kraken. The dispatcher tracks
such threads in the `kraken_threads` SQLite table (channel_id,
thread_ts, created_at).

In a Kraken-owned thread:
- The bot receives every reply (with or without @-mention).
- Mid-thread follow-ups like "yes, go ahead" or "what about X?" route
  to the dispatcher (or the enclave manager for bound channels).

In any other thread:
- The bot only receives messages that explicitly @-mention it.
- Random in-thread chatter is ignored.

This implements the directive: "within a Kraken-owned thread, mentioning
the bot should not be necessary". The bot stays out of conversations it
wasn't invited into.
```

- [ ] **Step 5: Verify no broken references**

```bash
grep -rn "enclave_provision" /Users/rbias/code/tentacular-main/thekraken/skills/kraken/ 2>/dev/null
```
Expected: NO matches inside the skill markdown.

- [ ] **Step 6: Commit**

```bash
git add skills/kraken/SKILL.md skills/kraken/references/slack-ux.md skills/kraken/references/thread-model.md
git commit -m "docs(skill): remove enclave_provision from manager; document new flow

The Kraken's enclave manager never provisions — provisioning is a
deterministic dispatcher command. Updates SKILL.md Path 1 tool list,
adds slack-ux.md section documenting the new \`@kraken provision\`
grammar with defaults and overrides, and adds thread-model.md section
documenting the kraken_threads-backed thread participation rule.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: Update `system-prompt.ts` (remove enclave_provision from manager Path 1)

**Files:**
- Modify: `src/agent/system-prompt.ts`

- [ ] **Step 1: Locate the manager prompt's Path 1 tool list**

```bash
grep -n "enclave_provision\|Path 1\|Path 2" src/agent/system-prompt.ts
```

Earlier reading showed the manager prompt contains a line listing direct MCP calls including `enclave_provision`.

- [ ] **Step 2: Edit the prompt**

In `src/agent/system-prompt.ts`, locate `buildManagerPrompt`. Find the line:
```typescript
'  wf_logs, enclave_info, enclave_provision, enclave_deprovision, enclave_sync',
```

Replace with:
```typescript
'  wf_logs, enclave_info, enclave_deprovision, enclave_sync',
```

Also locate the line:
```typescript
'ALSO use this path for ALL enclave management: provisioning, deprovisioning,',
```

Replace with:
```typescript
'ALSO use this path for enclave management: deprovisioning,',
```

And remove any other reference to provisioning being a manager responsibility. The manager never provisions — provisioning happens at the dispatcher level.

- [ ] **Step 3: Run unit tests to ensure prompt-shape tests still pass**

```bash
npx vitest run test/unit/agent/system-prompt.test.ts 2>/dev/null || npx vitest run test/unit/system-prompt.test.ts 2>/dev/null || true
```

If there's no specific test for the prompt content, run the full unit-test sweep:
```bash
npx vitest run
```
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/system-prompt.ts
git commit -m "fix(agent): remove enclave_provision from manager Path 1 prompt

The manager runs inside a channel that is ALREADY a bound enclave —
provisioning never reaches it. Removing the tool from the prompt
prevents the manager from confabulating provisioning capability.

Pairs with the dispatcher-level deterministic provision command.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 13: Adjust existing E2 + PLAT-LIFECYCLE-1 message text

**Files:**
- Modify: `test/e2e-slack/scenarios.ts`
- Modify: `test/e2e-platform/scenarios.ts`

- [ ] **Step 1: Update E2 message in `test/e2e-slack/scenarios.ts`**

Find the E2 scenario (id: 'E2'). Its current message is `@Kraken provision this channel as an enclave named e2e-test`. Replace with the deterministic grammar:

```typescript
message: `@Kraken provision as ${TEST_ENCLAVE}`,
```

Where `TEST_ENCLAVE` is the existing constant (default 'e2e-test'). The expectedPatterns should still match the success reply format from `handleProvision` ("Done. Enclave `e2e-test` is live..."). Update the regex if needed:
```typescript
expectedPatterns: [
  new RegExp(`Done\\. Enclave \`${TEST_ENCLAVE}\` is live|live|ready|done|set up|enclave`, 'i'),
],
```

- [ ] **Step 2: Update PLAT-LIFECYCLE-1 step 0 in `test/e2e-platform/scenarios.ts`**

Find the LIFECYCLE_SCENARIOS entry for PLAT-LIFECYCLE-1. Step 0 (the first step) currently sends `@Kraken provision this channel as an enclave named <TEST_ENCLAVE> for end-to-end testing`. Replace with:
```typescript
message: `@Kraken provision as ${TEST_ENCLAVE}`,
```

Update the `expectedPatterns` regex to also match the new "Done. Enclave" reply.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-slack/scenarios.ts test/e2e-platform/scenarios.ts
git commit -m "test(e2e): update E2 and PLAT-LIFECYCLE-1 to use new provision grammar

The deterministic \`@Kraken provision as <name>\` command replaces the
former LLM-driven \`@Kraken provision this channel as an enclave named <name>\`.
Adjusts expectedPatterns to match the new 'Done. Enclave X is live' reply.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 14: Add E2E scenarios E6, E7, E8, E9

**Files:**
- Modify: `test/e2e-slack/scenarios.ts`

- [ ] **Step 1: Read the existing ScenarioDef shape from scenarios.ts**

```bash
grep -n "export interface ScenarioDef\|expectedPatterns\|expectedReplyCount\|skipWhen\|channel:" test/e2e-slack/scenarios.ts | head -25
```

This will surface the expected fields. Mirror the existing E1/E2/E5 entries.

- [ ] **Step 2: Append E6, E7, E8, E9 to PROVISIONING_SCENARIOS array (or wherever E1/E2/E5 live)**

Add after the existing E5:
```typescript
{
  id: 'E6',
  name: 'provision with no args uses channel name as enclave name',
  channel: CHANNELS.test,
  message: '@Kraken provision',
  expectedPatterns: [
    // The default uses channel name; we expect the success message to
    // contain SOMETHING resembling the channel-name-as-enclave-name.
    /Done\. Enclave/i,
  ],
  timeoutMs: 60_000,
  cleanup: {
    // After E6 creates the enclave, deprovision it via @Kraken remove this
    // channel as an enclave (existing E5 pattern) before E7 runs.
    // The actual cleanup mechanism depends on the harness; if scenarios
    // don't support per-scenario cleanup, run E6 and E7 in separate
    // test channels by parameterizing on KRAKEN_E2E_TEST_CHANNEL_2.
  },
},
{
  id: 'E7',
  name: 'provision with both overrides uses provided name + description',
  channel: CHANNELS.test,
  message: '@Kraken provision as e2e-foo description Test enclave from E7',
  expectedPatterns: [
    /Done\. Enclave `e2e-foo` is live/i,
  ],
  timeoutMs: 60_000,
},
{
  id: 'E8',
  name: 'thread reply without @mention reaches Kraken in owned thread',
  channel: CHANNELS.enclave, // already-bound enclave channel
  message: '@Kraken status',
  followUpMessages: ['quick follow-up?'], // no @mention
  followUpAfterFirstReply: true,
  expectedReplyCount: 2,
  expectedPatterns: [/.+/i], // bot must reply at least twice
  timeoutMs: 60_000,
},
{
  id: 'E9',
  name: 'thread chatter in non-owned thread is ignored',
  channel: CHANNELS.enclave,
  // Start a thread without mentioning the bot. The harness needs to
  // post a non-mention top-level message, then a non-mention thread
  // reply, then verify the bot does NOT reply to either.
  //
  // If the existing harness only supports @mention top-level posts,
  // mark E9 with skipWhen and file a follow-up to extend the harness.
  message: '__NO_MENTION__ this is a thread top-level',
  followUpMessages: ['__NO_MENTION__ in-thread chatter'],
  followUpAfterFirstReply: false, // we don't wait for a bot reply
  expectedReplyCount: 0,
  forbiddenPatterns: [/.+/i], // bot must NOT reply
  timeoutMs: 30_000,
  // If harness can't post non-mention messages, skip with a TODO.
  skipWhen: () => process.env['KRAKEN_E2E_NO_MENTION_SUPPORTED'] !== '1',
},
```

NOTE on E9: the existing harness was designed for @mention testing only. The implementer should check `test/e2e-slack/harness.ts` for a non-mention post helper. If absent, file a follow-up issue and mark E9 with the `skipWhen` shown above (won't run until the harness gains that capability). Alternatively, E9 can be a unit test of the message handler gate (already covered in Task 8) and only E8 stays in E2E.

- [ ] **Step 3: Update PROVISIONING_SCENARIOS export to include the new scenarios**

If the existing array is named (e.g., `export const PROVISIONING_SCENARIOS = [e1, e2, e5]`), add `e6, e7, e8, e9` to the array.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add test/e2e-slack/scenarios.ts
git commit -m "test(e2e): add E6/E7/E8/E9 for provisioning + thread participation

E6: bare \`@Kraken provision\` uses channel name as enclave name.
E7: \`provision as <name> description <text>\` uses both overrides.
E8: thread reply without @mention reaches the Kraken (positive case).
E9: chatter in a non-Kraken-owned thread is ignored (negative case);
    gated by KRAKEN_E2E_NO_MENTION_SUPPORTED until harness adds
    non-mention post support.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 15: Prune kraken_threads at boot

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add pruning call to startup sequence**

In `src/index.ts`, after `initDatabase` completes and after other startup setup (around where other one-time tasks happen, e.g., near the git-state reconciler), call the prune helper:

```typescript
import { pruneOldKrakenThreads } from './db/kraken-threads.js';

// ... in main(), after db is initialized:
pruneOldKrakenThreads(db, 7 * 24 * 3600); // 7 days
log.info('kraken_threads: boot prune complete');
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(startup): prune kraken_threads >7 days at boot

Runs pruneOldKrakenThreads(db, 7*24*3600) once during startup. Bounds
table growth. A daily scheduled prune is followup work (out of scope
for this PR).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 16: Final verification — lint, format, full test sweep

**Files:** none modified

- [ ] **Step 1: TypeScript typecheck**

```bash
cd /Users/rbias/code/tentacular-main/thekraken
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 2: ESLint**

```bash
npm run lint
```
Expected: 0 errors. Warnings are tolerable as long as no NEW warnings are introduced by this change.

- [ ] **Step 3: Prettier format check**

```bash
npm run format:check
```
Expected: "All matched files use Prettier code style!"

If format check fails:
```bash
npm run format
git add -A
git commit -m "chore: prettier format"
```

- [ ] **Step 4: Full unit test sweep**

```bash
npm test
```
Expected: all PASS (allowing for known flaky parallel-execution failures, document them if any).

- [ ] **Step 5: Push branch + open PR**

```bash
git push origin spec/deterministic-provisioning
gh pr create -R randybias/thekraken \
  --base main \
  --head spec/deterministic-provisioning \
  --title "fix(slack): deterministic @kraken provision command + thread participation tracking" \
  --body "$(cat <<'EOF'
## Summary

Replaces the broken LLM-driven enclave provisioning flow with a deterministic command. Adds SQLite-backed thread-participation tracking so non-@-mention thread replies reach the Kraken when (and only when) the thread was started by an @-mention.

Fixes the three regressions observed on eastus 2026-05-26:
1. Thread replies without @mention in unbound channels were dropped (bot.ts:694 gated on isBoundChannel which is false during provisioning).
2. Provisioning prompt asked for name despite the channel-name-default directive.
3. Smart-path was stateless — each @mention restarted the conversation; user received three identical "this channel isn't an enclave yet" replies.

Spec: docs/superpowers/specs/2026-05-27-deterministic-provisioning-design.md
Plan: docs/superpowers/plans/2026-05-27-deterministic-provisioning.md

## Components

- `provision` deterministic command (parser + handler) mirroring add/remove pattern
- `kraken_threads` SQLite table tracks bot-owned threads
- bot.ts unbound-channel branch runs parseCommand first; message handler gate replaced
- smart-path's `provision` mode removed
- Kraken skill + manager system prompt updated to drop enclave_provision from Path 1
- E2E E2 + PLAT-LIFECYCLE-1 message text updated to new grammar
- E6/E7/E8/E9 new scenarios cover defaults, overrides, thread participation positive + negative

## Test plan

- [ ] Unit tests pass (vitest)
- [ ] Lint + format clean
- [ ] After v0.10.1 lockstep deploy: manual smoke on nats-weu — `@Kraken provision` in a fresh channel; verify enclave created with channel-name as name
- [ ] After deploy: E2E suite passes (including new E6-E9)
- [ ] After deploy: production transcript replay on eastus — `@Kraken provision` in unbound channel succeeds in one message; thread follow-ups reach the bot without @-mention

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR URL printed.

- [ ] **Step 6: Watch PR checks**

```bash
gh pr checks <PR_NUMBER> -R randybias/thekraken
```
Expected: all checks pass within ~5 minutes.

If any check fails: read the failure log, fix, re-push.

---

## Manual smoke test (after PR merge + v0.10.1 deploy)

These run AFTER the v0.10.1 lockstep release is deployed to nats-weu and eastus. Out of scope for the PR but listed here for the operator's reference.

1. **Provision flow** — in a fresh unbound Slack channel: `@Kraken provision`. Confirm:
   - Bot replies with `Done. Enclave \`<channel-name>\` is live...`
   - Chroma dashboard shows the new enclave
   - `kubectl get ns | grep <channel-name>` returns the namespace

2. **Provision with overrides** — `@Kraken provision as my-test description My test enclave`. Confirm:
   - Bot replies with `Done. Enclave \`my-test\` is live...`
   - enclave_info MCP call returns description="My test enclave"

3. **Thread follow-up without @mention** — in a bound enclave channel, start a thread with `@Kraken status`. After bot replies, reply in the thread with `thanks` (NO @mention). Confirm:
   - Bot receives the message (logs show the message handler forwarded it)

4. **Non-Kraken thread ignored** — in a bound enclave channel, post a top-level message WITHOUT @mention. Then reply in that thread without @mention. Confirm:
   - Bot stays silent

---

## Spec coverage summary

| Spec section | Implemented in |
|---|---|
| Component 1: Provision command | Tasks 3, 4, 5, 6 |
| Component 2: kraken_threads | Tasks 1, 2, 7, 15 |
| Component 3: Remove provision from smart-path + restructure bot.ts | Tasks 8, 9, 10 |
| Component 4: Skill + system-prompt updates | Tasks 11, 12 |
| Component 5: E2E scenarios | Tasks 13, 14 |
| Manual smoke + PR | Task 16 |
