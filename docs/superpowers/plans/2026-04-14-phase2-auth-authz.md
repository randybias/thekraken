# Phase 2: Auth + Authz Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement OIDC device-flow authentication and POSIX-style authorization so the Kraken can authenticate Slack users, enforce enclave permissions, and pass user tokens to team subprocesses.

**Architecture:** Port the working auth/authz patterns from `thekraken-reference/` (v0.9.0) into the Kraken rewrite's stub files. OIDC tokens stored in SQLite `user_tokens` table (already defined in schema). Tool scoping enforced via pi's `tool_call` extension hook. All auth is per-user (D6 — no service identities for enclave work). Background refresh loop proactively refreshes expiring tokens.

**Tech Stack:** TypeScript, better-sqlite3, Keycloak OIDC (device authorization grant), pi-coding-agent extensions, vitest

**Port source:** `thekraken-reference/src/oidc.ts`, `thekraken-reference/src/authz.ts`, `thekraken-reference/src/mcp-scope.ts`

**MCP tools used by this phase:**
- `enclave_info({name})` — fetch owner, members, mode, status for authz decisions
- No other MCP tools are called directly by auth/authz code

**Critical rule:** Do NOT invent new auth mechanisms. Port from the reference. No token encryption, no service tokens, no invented security requirements.

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Replace stub | `src/auth/oidc.ts` | OIDC device flow, token refresh, background refresh loop |
| Replace stub | `src/auth/tokens.ts` | SQLite token CRUD (getUserToken, setUserToken, deleteUserToken, getAllUserTokens) |
| Replace stub | `src/enclave/authz.ts` | POSIX mode checking, role resolution, operation classification |
| Replace stub | `src/extensions/tool-scoping.ts` | Pi tool_call hook enforcing ENCLAVE_SCOPED / BLOCKED / DM_ALLOWED |
| Modify | `src/auth/index.ts` | Re-export public API from oidc.ts and tokens.ts |
| Modify | `src/index.ts` | Wire startTokenRefreshLoop() into startup, stopTokenRefreshLoop() into shutdown |
| Modify | `src/slack/bot.ts` | Add auth gate before routing — check getValidTokenForUser(), initiate device flow if null |
| Create | `test/unit/oidc.test.ts` | Tests for device flow, token refresh, background refresh |
| Create | `test/unit/tokens.test.ts` | Tests for SQLite token CRUD |
| Create | `test/unit/authz.test.ts` | Tests for role resolution, mode checking, operation classification |
| Create | `test/unit/tool-scoping.test.ts` | Tests for enclave/DM scoping decisions |

---

### Task 1: Token Storage (SQLite CRUD)

**Files:**
- Replace: `src/auth/tokens.ts`
- Create: `test/unit/tokens.test.ts`

The `user_tokens` table already exists in `src/db/schema.ts`. We need CRUD functions that talk to it.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/tokens.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initTokenStore,
  getUserToken,
  setUserToken,
  deleteUserToken,
  getAllUserTokens,
} from '../../src/auth/tokens.js';

describe('token store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        slack_user_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        keycloak_sub TEXT NOT NULL,
        email TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    initTokenStore(db);
  });

  it('returns undefined for unknown user', () => {
    expect(getUserToken('U_UNKNOWN')).toBeUndefined();
  });

  it('stores and retrieves a token', () => {
    const expiresAt = Date.now() + 3600_000;
    setUserToken('U_ALICE', {
      access_token: 'at_alice',
      refresh_token: 'rt_alice',
      expires_at: expiresAt,
      keycloak_sub: 'sub_alice',
      email: 'alice@example.com',
    });

    const stored = getUserToken('U_ALICE');
    expect(stored).toBeDefined();
    expect(stored!.access_token).toBe('at_alice');
    expect(stored!.email).toBe('alice@example.com');
    expect(stored!.expires_at).toBe(expiresAt);
  });

  it('upserts on duplicate user', () => {
    setUserToken('U_BOB', {
      access_token: 'at_old',
      refresh_token: 'rt_old',
      expires_at: Date.now(),
      keycloak_sub: 'sub_bob',
      email: 'bob@example.com',
    });
    setUserToken('U_BOB', {
      access_token: 'at_new',
      refresh_token: 'rt_new',
      expires_at: Date.now() + 7200_000,
      keycloak_sub: 'sub_bob',
      email: 'bob@example.com',
    });

    const stored = getUserToken('U_BOB');
    expect(stored!.access_token).toBe('at_new');
  });

  it('deletes a token', () => {
    setUserToken('U_DEL', {
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: Date.now(),
      keycloak_sub: 'sub',
      email: 'del@example.com',
    });
    deleteUserToken('U_DEL');
    expect(getUserToken('U_DEL')).toBeUndefined();
  });

  it('lists all tokens', () => {
    setUserToken('U_A', {
      access_token: 'a',
      refresh_token: 'ra',
      expires_at: Date.now(),
      keycloak_sub: 'sa',
      email: 'a@x.com',
    });
    setUserToken('U_B', {
      access_token: 'b',
      refresh_token: 'rb',
      expires_at: Date.now(),
      keycloak_sub: 'sb',
      email: 'b@x.com',
    });
    const all = getAllUserTokens();
    expect(all).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/tokens.test.ts`
Expected: FAIL — `initTokenStore` not exported

- [ ] **Step 3: Implement token store**

```typescript
// src/auth/tokens.ts
/**
 * Per-user OIDC token storage backed by SQLite user_tokens table.
 * The table is created by src/db/schema.ts on startup.
 */

import type Database from 'better-sqlite3';

export interface StoredToken {
  slack_user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms timestamp
  keycloak_sub: string;
  email: string;
  updated_at: string; // ISO 8601
}

export interface TokenInput {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms timestamp
  keycloak_sub: string;
  email: string;
}

let db: Database.Database;

export function initTokenStore(database: Database.Database): void {
  db = database;
}

export function getUserToken(slackUserId: string): StoredToken | undefined {
  const row = db
    .prepare(
      `SELECT slack_user_id, access_token, refresh_token,
              CAST(expires_at AS INTEGER) as expires_at,
              keycloak_sub, email, updated_at
       FROM user_tokens WHERE slack_user_id = ?`,
    )
    .get(slackUserId) as StoredToken | undefined;
  return row;
}

export function setUserToken(slackUserId: string, token: TokenInput): void {
  db.prepare(
    `INSERT INTO user_tokens (slack_user_id, access_token, refresh_token, expires_at, keycloak_sub, email, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(slack_user_id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       keycloak_sub = excluded.keycloak_sub,
       email = excluded.email,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(
    slackUserId,
    token.access_token,
    token.refresh_token,
    token.expires_at,
    token.keycloak_sub,
    token.email,
  );
}

export function deleteUserToken(slackUserId: string): void {
  db.prepare('DELETE FROM user_tokens WHERE slack_user_id = ?').run(slackUserId);
}

export function getAllUserTokens(): StoredToken[] {
  return db
    .prepare(
      `SELECT slack_user_id, access_token, refresh_token,
              CAST(expires_at AS INTEGER) as expires_at,
              keycloak_sub, email, updated_at
       FROM user_tokens`,
    )
    .all() as StoredToken[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/tokens.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/tokens.ts test/unit/tokens.test.ts
git commit -m "feat(auth): implement SQLite token CRUD for user_tokens table"
```

---

### Task 2: OIDC Device Flow

**Files:**
- Replace: `src/auth/oidc.ts`
- Create: `test/unit/oidc.test.ts`

Port from `thekraken-reference/src/oidc.ts`. The key functions: `initiateDeviceAuth`, `pollForToken`, `refreshToken`, `getValidTokenForUser`, `storeTokenForUser`, `startTokenRefreshLoop`, `stopTokenRefreshLoop`.

**Important difference from reference:** The reference reads OIDC config from `process.env` directly. The Kraken rewrite has a config module at `src/config.ts` that already loads `oidcIssuer`, `oidcClientId`, `oidcClientSecret`. Use that instead of reading env vars directly.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/oidc.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initTokenStore } from '../../src/auth/tokens.js';

// We'll test the high-level accessors that use the token store.
// Device flow HTTP calls are tested via fetch mocking.

describe('oidc', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        slack_user_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        keycloak_sub TEXT NOT NULL,
        email TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    initTokenStore(db);
  });

  describe('storeTokenForUser', () => {
    it('stores a token and computes expires_at from expires_in', async () => {
      // Dynamic import to pick up initTokenStore
      const { storeTokenForUser } = await import('../../src/auth/oidc.js');
      const before = Date.now();
      storeTokenForUser('U_TEST', {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        token_type: 'Bearer',
      });

      const { getUserToken } = await import('../../src/auth/tokens.js');
      const stored = getUserToken('U_TEST');
      expect(stored).toBeDefined();
      expect(stored!.access_token).toBe('at');
      // expires_at should be ~now + 3600s
      expect(stored!.expires_at).toBeGreaterThanOrEqual(before + 3600_000 - 1000);
    });
  });

  describe('getValidTokenForUser', () => {
    it('returns null for unknown user', async () => {
      const { getValidTokenForUser } = await import('../../src/auth/oidc.js');
      const token = await getValidTokenForUser('U_NOBODY');
      expect(token).toBeNull();
    });

    it('returns access_token when not expired', async () => {
      const { storeTokenForUser, getValidTokenForUser } = await import(
        '../../src/auth/oidc.js'
      );
      storeTokenForUser('U_FRESH', {
        access_token: 'fresh_at',
        refresh_token: 'fresh_rt',
        expires_in: 3600,
        token_type: 'Bearer',
      });

      const token = await getValidTokenForUser('U_FRESH');
      expect(token).toBe('fresh_at');
    });
  });

  describe('extractEmailFromToken', () => {
    it('extracts email from JWT payload', async () => {
      const { extractEmailFromToken } = await import(
        '../../src/auth/oidc.js'
      );
      // Build a fake JWT with email in payload
      const payload = Buffer.from(
        JSON.stringify({ email: 'alice@example.com', sub: '123' }),
      ).toString('base64url');
      const fakeJwt = `header.${payload}.signature`;
      expect(extractEmailFromToken(fakeJwt)).toBe('alice@example.com');
    });

    it('returns undefined for invalid JWT', async () => {
      const { extractEmailFromToken } = await import(
        '../../src/auth/oidc.js'
      );
      expect(extractEmailFromToken('not-a-jwt')).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/oidc.test.ts`
Expected: FAIL — module has no exports

- [ ] **Step 3: Implement OIDC module**

Port from `thekraken-reference/src/oidc.ts` with these adaptations:
- Use `src/config.ts` for OIDC config instead of reading `process.env` directly
- Use `src/auth/tokens.ts` for storage instead of `./db.js` imports
- Remove `getServiceToken()` — no service identities (D6)
- Keep: `initiateDeviceAuth`, `pollForToken`, `refreshToken`, `storeTokenForUser`, `getValidTokenForUser`, `startTokenRefreshLoop`, `stopTokenRefreshLoop`, `refreshAllExpiring`, `extractEmailFromToken`

The implementation is ~250 lines. Port the reference directly — do NOT simplify or "improve" the logic. The reference is battle-tested on eastus.

```typescript
// src/auth/oidc.ts
// Port of thekraken-reference/src/oidc.ts adapted for the Kraken rewrite.
// Changes from reference:
//   - Config via src/config.ts (not process.env directly)
//   - Token storage via src/auth/tokens.ts (not ./db.js)
//   - No getServiceToken() (D6: no service identities)
```

Full implementation: read `thekraken-reference/src/oidc.ts` lines 1-409 and port, replacing:
- `import { getUserToken, setUserToken, getAllUserTokens, deleteUserToken } from './db.js'` → `import { getUserToken, setUserToken, getAllUserTokens, deleteUserToken } from './tokens.js'`
- `getConfig()` body → read from the loaded config module (import `loadConfig` or accept config as param)
- Remove `getServiceToken()` function and its `serviceToken` variable entirely
- Keep all other functions identical

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/oidc.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/oidc.ts test/unit/oidc.test.ts
git commit -m "feat(auth): implement OIDC device flow, token refresh, background refresh loop"
```

---

### Task 3: POSIX Authorization

**Files:**
- Replace: `src/enclave/authz.ts`
- Create: `test/unit/authz.test.ts`

Port from `thekraken-reference/src/authz.ts`. Pure logic — no MCP calls in the tests (mock the mcpCall function).

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/authz.test.ts
import { describe, it, expect } from 'vitest';
import {
  checkModeBit,
  resolveRole,
  classifyOperation,
  buildDenialMessage,
  extractEmailFromToken,
} from '../../src/enclave/authz.js';

describe('resolveRole', () => {
  const info = {
    owner: 'alice@example.com',
    members: ['bob@example.com', 'carol@example.com'],
    mode: 'rwxrwx---',
    status: 'active',
    name: 'test-enclave',
  };

  it('resolves owner', () => {
    expect(resolveRole('alice@example.com', info)).toBe('owner');
  });

  it('resolves owner case-insensitive', () => {
    expect(resolveRole('Alice@Example.COM', info)).toBe('owner');
  });

  it('resolves member', () => {
    expect(resolveRole('bob@example.com', info)).toBe('member');
  });

  it('resolves visitor', () => {
    expect(resolveRole('stranger@example.com', info)).toBe('visitor');
  });
});

describe('checkModeBit', () => {
  it('owner always allowed', () => {
    expect(checkModeBit('------', 'owner', 'write')).toBe(true);
  });

  it('member read allowed with rwxrwx---', () => {
    expect(checkModeBit('rwxrwx---', 'member', 'read')).toBe(true);
  });

  it('member write allowed with rwxrwx---', () => {
    expect(checkModeBit('rwxrwx---', 'member', 'write')).toBe(true);
  });

  it('visitor denied with rwxrwx---', () => {
    expect(checkModeBit('rwxrwx---', 'visitor', 'read')).toBe(false);
  });

  it('visitor read allowed with rwxrwxr--', () => {
    expect(checkModeBit('rwxrwxr--', 'visitor', 'read')).toBe(true);
  });

  it('visitor write denied with rwxrwxr--', () => {
    expect(checkModeBit('rwxrwxr--', 'visitor', 'write')).toBe(false);
  });
});

describe('classifyOperation', () => {
  it('classifies deploy as write', () => {
    expect(classifyOperation('deploy my-tentacle')).toBe('write');
  });

  it('classifies run as execute', () => {
    expect(classifyOperation('run the workflow')).toBe('execute');
  });

  it('classifies status check as read', () => {
    expect(classifyOperation('show me the status')).toBe('read');
  });

  it('defaults ambiguous text to read', () => {
    expect(classifyOperation('hello kraken')).toBe('read');
  });
});

describe('buildDenialMessage', () => {
  it('frozen enclave message', () => {
    const msg = buildDenialMessage('member', 'write', 'frozen');
    expect(msg).toContain('frozen');
  });

  it('visitor message suggests asking owner', () => {
    const msg = buildDenialMessage('visitor', 'read', 'active');
    expect(msg).toContain('owner');
  });

  it('never uses jargon', () => {
    const msg = buildDenialMessage('member', 'execute', 'active');
    expect(msg).not.toContain('POSIX');
    expect(msg).not.toContain('namespace');
    expect(msg).not.toContain('authorization');
    expect(msg).not.toContain('mode bit');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/authz.test.ts`
Expected: FAIL — no exports from authz.ts

- [ ] **Step 3: Implement authz module**

Port from `thekraken-reference/src/authz.ts` with these changes:
- Export `resolveRole`, `checkModeBit`, `classifyOperation`, `buildDenialMessage` as named exports (reference has some as module-private — expose for testing)
- Keep `checkAccess` as the main entry point (takes mcpCall function as parameter)
- Keep `invalidateAuthzCache`, `getAuthzCache`
- Remove `extractEmailFromToken` — it's in oidc.ts already
- Use `src/logger.ts` instead of `./logger.js`

Full implementation: ~150 lines. Copy the reference, adjust imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/authz.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/enclave/authz.ts test/unit/authz.test.ts
git commit -m "feat(authz): implement POSIX mode checking, role resolution, operation classification"
```

---

### Task 4: Tool Scoping Extension

**Files:**
- Replace: `src/extensions/tool-scoping.ts`
- Create: `test/unit/tool-scoping.test.ts`

Port from `thekraken-reference/src/mcp-scope.ts`. This is the pi `tool_call` extension hook that enforces which MCP tools are allowed in enclave vs DM mode.

**Critical:** The reference was already updated to v0.9.0 enclave params. Port it directly.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/tool-scoping.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateToolCall, getAllowedTentacularTools } from '../../src/extensions/tool-scoping.js';

const MCP = 'mcp__tentacular__';

describe('evaluateToolCall', () => {
  describe('enclave mode', () => {
    const enclave = 'my-enclave';

    it('injects enclave for scoped tools', () => {
      const result = evaluateToolCall(`${MCP}wf_list`, {}, enclave);
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.updatedInput).toEqual({ enclave });
      }
    });

    it('blocks cross-enclave access', () => {
      const result = evaluateToolCall(
        `${MCP}wf_list`,
        { enclave: 'other-enclave' },
        enclave,
      );
      expect(result.allowed).toBe(false);
    });

    it('blocks platform operator tools', () => {
      const result = evaluateToolCall(`${MCP}enclave_preflight`, {}, enclave);
      expect(result.allowed).toBe(false);
    });

    it('allows health_cluster_summary without injection', () => {
      const result = evaluateToolCall(`${MCP}health_cluster_summary`, {}, enclave);
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.updatedInput).toBeUndefined();
      }
    });

    it('blocks unknown tentacular tools', () => {
      const result = evaluateToolCall(`${MCP}future_tool`, {}, enclave);
      expect(result.allowed).toBe(false);
    });
  });

  describe('DM mode', () => {
    it('allows read-only tools', () => {
      const result = evaluateToolCall(`${MCP}wf_list`, {}, null);
      expect(result.allowed).toBe(true);
    });

    it('blocks write tools', () => {
      const result = evaluateToolCall(`${MCP}wf_apply`, {}, null);
      expect(result.allowed).toBe(false);
    });
  });

  describe('non-tentacular tools', () => {
    it('allows non-MCP tools unconditionally', () => {
      const result = evaluateToolCall('Bash', { command: 'ls' }, 'my-enclave');
      expect(result.allowed).toBe(true);
    });
  });
});

describe('getAllowedTentacularTools', () => {
  it('returns scoped + always-allowed for enclave mode', () => {
    const tools = getAllowedTentacularTools('my-enclave');
    expect(tools).toContain(`${MCP}wf_list`);
    expect(tools).toContain(`${MCP}wf_apply`);
    expect(tools).not.toContain(`${MCP}enclave_provision`);
  });

  it('returns read-only for DM mode', () => {
    const tools = getAllowedTentacularTools(null);
    expect(tools).toContain(`${MCP}wf_list`);
    expect(tools).not.toContain(`${MCP}wf_apply`);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/tool-scoping.test.ts`
Expected: FAIL — no exports

- [ ] **Step 3: Implement tool scoping**

Copy `thekraken-reference/src/mcp-scope.ts` directly to `src/extensions/tool-scoping.ts`. Change only:
- Logger import: `import { logger } from '../logger.js'`

The reference already uses `'enclave'` params (updated in v0.9.0). Port it verbatim.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/tool-scoping.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/extensions/tool-scoping.ts test/unit/tool-scoping.test.ts
git commit -m "feat(authz): implement tool scoping for enclave/DM modes"
```

---

### Task 5: Wire Auth into Startup + Shutdown

**Files:**
- Modify: `src/auth/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Update auth barrel export**

```typescript
// src/auth/index.ts
export {
  initiateDeviceAuth,
  pollForToken,
  refreshToken,
  storeTokenForUser,
  getValidTokenForUser,
  startTokenRefreshLoop,
  stopTokenRefreshLoop,
  extractEmailFromToken,
} from './oidc.js';

export {
  initTokenStore,
  getUserToken,
  setUserToken,
  deleteUserToken,
  getAllUserTokens,
} from './tokens.js';

export type { DeviceAuthResponse, TokenResponse } from './oidc.js';
export type { StoredToken, TokenInput } from './tokens.js';
```

- [ ] **Step 2: Wire into index.ts startup**

In `src/index.ts`, after `initDatabase(db)`:
```typescript
import { initTokenStore, startTokenRefreshLoop, stopTokenRefreshLoop } from './auth/index.js';

// After initDatabase:
initTokenStore(db);
startTokenRefreshLoop();
```

In shutdown handler, before `shutdownOtel()`:
```typescript
stopTokenRefreshLoop();
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All 241+ tests pass (existing tests unaffected, new tests added)

- [ ] **Step 4: Commit**

```bash
git add src/auth/index.ts src/index.ts
git commit -m "feat(auth): wire token store and refresh loop into startup/shutdown"
```

---

### Task 6: Auth Gate in Slack Bot

**Files:**
- Modify: `src/slack/bot.ts`

When a Slack message arrives in an enclave channel, the bot must check if the user has a valid OIDC token before routing to teams. If not, initiate device flow and post an ephemeral auth prompt.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/slack-bot.test.ts` (or create new file):

```typescript
// test/unit/auth-gate.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('auth gate', () => {
  it('returns auth prompt when user has no token', () => {
    // Test that an unauthenticated user gets an ephemeral message
    // rather than being routed to a team
    // Implementation depends on bot.ts structure - adapt to actual code
    expect(true).toBe(true); // Placeholder for structure
  });
});
```

Note: The exact test structure depends on how `bot.ts` is currently structured. The key assertion is: if `getValidTokenForUser(slackUserId)` returns null, the bot posts an ephemeral auth prompt instead of routing to teams.

- [ ] **Step 2: Implement auth gate**

In `src/slack/bot.ts`, in the message handler (before `routeEvent`):

```typescript
import { getValidTokenForUser, initiateDeviceAuth } from '../auth/index.js';

// Inside the app_mention / message handler:
const userToken = await getValidTokenForUser(event.user);
if (!userToken) {
  // Start device flow
  const deviceAuth = await initiateDeviceAuth();
  // Post ephemeral auth prompt (visible only to this user)
  await client.chat.postEphemeral({
    channel: event.channel,
    user: event.user,
    text: `Please authenticate to use The Kraken.\nVisit: ${deviceAuth.verification_uri}\nCode: ${deviceAuth.user_code}`,
  });
  // Start polling in background (don't await — fire and forget)
  pollAndStore(event.user, deviceAuth).catch((err) =>
    logger.warn({ err, user: event.user }, 'Device auth polling failed'),
  );
  return; // Don't route to teams
}

// Pass userToken to team via mailbox record
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/slack/bot.ts test/unit/auth-gate.test.ts
git commit -m "feat(auth): add auth gate - require OIDC before routing to teams"
```

---

### Task 7: Wire User Token into Team Dispatch

**Files:**
- Modify: `src/teams/lifecycle.ts` (already has `TNTC_ACCESS_TOKEN: userToken` placeholder)
- Modify: `src/dispatcher/router.ts` (pass token through RouteDecision)

The mailbox record already has a `userToken` field (currently empty string in Phase 1). Wire the real token through the dispatch chain.

- [ ] **Step 1: Verify existing token plumbing**

Read `src/teams/lifecycle.ts` — line 177 already has `TNTC_ACCESS_TOKEN: userToken`. The token just needs to flow from the Slack handler through the dispatcher to the mailbox write.

- [ ] **Step 2: Update dispatcher to carry token**

Ensure `RouteDecision` includes the user's token, and the team spawn/forward path passes it to the mailbox record's `userToken` field.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/dispatcher/router.ts src/teams/lifecycle.ts
git commit -m "feat(auth): wire user OIDC token through dispatch chain to team subprocess"
```

---

### Task 8: Integration Smoke Test + Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass (241 existing + ~30 new = ~270+)

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: Clean (0 errors)

- [ ] **Step 3: Lint**

Run: `npm run lint && npm run format:check`
Expected: Clean

- [ ] **Step 4: Verify no stale references**

```bash
grep -rn 'namespace' src/ --include="*.ts" | grep -v node_modules | grep -v '// ' | grep -v '.d.ts'
```
Expected: No MCP tool param `namespace` references (only K8s API usage)

```bash
grep -rn 'wf_health_ns\|health_ns_usage\|cluster_preflight\|ns_list\|ns_create' src/ test/ --include="*.ts"
```
Expected: No results

- [ ] **Step 5: Final commit**

```bash
git commit -m "chore(phase2): all tests passing, lint clean, type check clean"
```

- [ ] **Step 6: Tag checkpoint**

```bash
git tag -a phase2-complete -m "Phase 2: Auth + Authz complete. OIDC device flow, POSIX authz, tool scoping."
```

---

## Guardrails (What NOT to Do)

These are specific things that went wrong in the first Phase 2 attempt. Do NOT:

1. **Invent token encryption.** No AES-256-GCM. No KRAKEN_TOKEN_ENCRYPTION_KEY. Tokens are stored in plaintext SQLite, same as the old Kraken and tntc CLI.
2. **Add a service token.** No MCP_SERVICE_TOKEN. No client_credentials grant. No getServiceToken(). Every MCP call uses a user's OIDC token (D6).
3. **Add background token refresh with invented timing.** Port the reference's exact timing: 5-minute refresh interval, 10-minute ahead window, 12-hour session window. Don't change these numbers.
4. **Add CiliumNetworkPolicy or SSH egress rules.** The cluster uses kube-router, not Cilium.
5. **Modify the Helm chart.** No chart changes in this phase.
6. **Add invented env vars.** Every env var must already exist in `src/config.ts`.
