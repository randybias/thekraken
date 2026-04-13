# Phase 0: Scaffold + Test Harness + Git-State Infra Port — Design

**Change ID:** phase0-scaffold
**Status:** Draft
**Created:** 2026-04-13
**Author:** Senior Architect

---

## 1. Package Structure Layout

The directory tree below matches design doc Section 11. Differences from the
execution plan's `Critical Files` section are noted inline. The execution plan
adds `consistency.ts` and `mcp-client.ts` under `src/` that do not appear in
Section 11. Both are Phase 1+ deliverables, so Phase 0 creates only the
Section 11 stubs. The execution plan also lists `permissions.md` under
`skills/kraken/references/` which Section 11 omits; we include it since the
PM's tasks.md (T15) explicitly lists it.

```
thekraken/
├── src/
│   ├── index.ts                    # Main entry, startup sequence (stub: process.exit(0))
│   ├── config.ts                   # Env var loading, typed config object
│   ├── types.ts                    # Shared type definitions (empty barrel)
│   ├── health.ts                   # /healthz HTTP handler
│   ├── slack/
│   │   ├── index.ts                # Barrel export
│   │   ├── bot.ts                  # SlackBot: HTTP Events + Socket Mode (stub)
│   │   ├── events.ts               # Channel lifecycle events (stub)
│   │   ├── formatter.ts            # Markdown -> Block Kit (stub)
│   │   ├── cards.ts                # Structured cards (stub)
│   │   └── home-tab.ts             # Slack Home tab UI (stub)
│   ├── enclave/
│   │   ├── index.ts                # Barrel export
│   │   ├── binding.ts              # Channel <-> enclave state machine (stub)
│   │   ├── authz.ts                # POSIX authorization engine (stub)
│   │   ├── commands.ts             # @kraken command parser + dispatcher (stub)
│   │   ├── drift.ts                # Membership reconciliation (stub)
│   │   ├── provisioning.ts         # Enclave creation flow (stub)
│   │   └── personas.ts             # Persona inference from description (stub)
│   ├── auth/
│   │   ├── index.ts                # Barrel export
│   │   ├── oidc.ts                 # Keycloak device auth (stub)
│   │   └── tokens.ts               # Token storage, refresh loop (stub)
│   ├── agent/
│   │   ├── index.ts                # Barrel export
│   │   ├── runner.ts               # Per-thread agent lifecycle (stub)
│   │   ├── tools.ts                # MCP tool config (stub) — named tools.ts per Section 11
│   │   ├── system-prompt.ts        # System prompt builder (stub)
│   │   └── queue.ts                # Per-thread concurrent queue (stub)
│   ├── db/
│   │   ├── index.ts                # Barrel export
│   │   ├── schema.ts               # SQLite DDL constant
│   │   └── migrations.ts           # Schema application (fresh v2, single migration)
│   └── extensions/
│       ├── index.ts                # Barrel export
│       ├── tool-scoping.ts         # beforeToolCall: RBAC enforcement (stub)
│       ├── jargon-filter.ts        # Output postproc (stub)
│       └── context-injector.ts     # [CONTEXT] block injection (stub)
├── skills/
│   ├── tentacular/                 # Reserved, empty
│   └── kraken/
│       ├── SKILL.md                # Placeholder header + TODO
│       └── references/
│           ├── slack-ux.md         # Placeholder
│           ├── enclave-personas.md # Placeholder
│           ├── thread-model.md     # Placeholder
│           └── permissions.md      # Placeholder (from PM T15)
├── test/
│   ├── unit/
│   │   ├── placeholder.test.ts     # Vitest smoke (assert true)
│   │   ├── aimock-smoke.test.ts    # LLMock + MCPMock smoke
│   │   ├── slack-mock-smoke.test.ts
│   │   ├── config.test.ts
│   │   ├── schema.test.ts
│   │   └── health.test.ts
│   ├── integration/                # Empty, reserved
│   ├── scenarios/                  # Empty, reserved
│   ├── fixtures/                   # AIMock recorded fixtures, empty
│   └── mocks/
│       ├── slack-client.ts         # Mock Slack WebClient
│       └── event-simulator.ts      # Slack event payload factories
├── scripts/
│   └── entrypoint.sh              # Git-state init, hard-fail, then exec node
├── kraken-hooks/
│   └── pre-commit                 # Version auto-bump in workflow.yaml
├── charts/
│   └── thekraken/
│       ├── Chart.yaml
│       ├── values.yaml
│       ├── values-mirantis.yaml
│       └── templates/
│           ├── _helpers.tpl
│           ├── configmap.yaml
│           ├── deployment.yaml
│           ├── ingress.yaml
│           ├── namespace.yaml
│           ├── networkpolicy.yaml
│           ├── pvc.yaml
│           ├── secret.yaml
│           ├── service.yaml
│           └── serviceaccount.yaml
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── docker-build.yml
├── openspec/
│   ├── project.md
│   └── changes/
│       └── phase0-scaffold/
├── Dockerfile
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── .prettierrc
├── .gitignore
├── CLAUDE.md                      # Created Phase 1+
└── README.md
```

**Note on `slack/mock.ts`:** Design doc Section 11 lists `slack/mock.ts` for
the mock WebClient. We place it in `test/mocks/slack-client.ts` instead (per
PM tasks). Test mocks do not belong in `src/`. Developers should NOT create
`src/slack/mock.ts`.

---

## 2. package.json

**Package manager:** npm (matches thekraken-reference). No pnpm.

```jsonc
{
  "name": "thekraken",
  "version": "2.0.0",
  "description": "The Kraken v2 — Pi-based enclave-centric Slack bot for Tentacular",
  "type": "module",
  "main": "dist/index.js",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/",
    "lint:fix": "eslint src/ --fix",
    "format": "prettier --write \"src/**/*.ts\" \"test/**/*.ts\"",
    "format:check": "prettier --check \"src/**/*.ts\" \"test/**/*.ts\""
  },
  "dependencies": {
    "@mariozechner/pi-agent-core": "0.66.1",
    "@mariozechner/pi-ai": "0.66.1",
    "@mariozechner/pi-coding-agent": "0.66.1",
    "@slack/bolt": "^4.6.0",
    "better-sqlite3": "^11.8.1"
  },
  "devDependencies": {
    "@copilotkit/aimock": "^1.13.0",
    "@eslint/js": "^9.35.0",
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.10.0",
    "eslint": "^9.35.0",
    "eslint-plugin-no-catch-all": "^1.1.0",
    "globals": "^15.12.0",
    "prettier": "^3.8.1",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.35.0",
    "vitest": "^4.0.18"
  }
}
```

**Key decisions:**

- Pi packages pinned to exact `0.66.1` (no caret). These are lockstep
  dependencies; floating would break us.
- `@copilotkit/aimock` as devDependency (confirmed package name from
  CopilotKit/aimock GitHub repo).
- No `husky` — we use `kraken-hooks/pre-commit` as a git hooks path, not
  husky's model. The reference's `"prepare": "husky"` is dropped.
- No `pino` or `yaml` yet — those are Phase 1+ when we actually need logging
  and YAML parsing in the runtime. The pre-commit hook uses `sed`, not a
  Node.js YAML parser.
- No `zod` yet — add when needed in Phase 1 for runtime validation.
- `format` and `format:check` cover both `src/` and `test/` (the reference
  only covered `src/`).
- `@vitest/coverage-v8` omitted from Phase 0 — add when coverage thresholds
  are established in Phase 1.

**Developer note on T01:** If `@mariozechner/pi-agent-core@0.66.1` does not
resolve from npm, check whether the package is published under a different
scope or version. Document the actual resolved version in a comment in
`package.json` and open an issue.

---

## 3. tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Differences from thekraken-reference:**

- Added `noUncheckedIndexedAccess: true` — catches `undefined` from index
  signatures. Required for the safety profile of v2.
- Added `noUnusedLocals` and `noUnusedParameters` — stricter than reference.
  These are compile-time only and prevent dead code accumulation.
- All other options match the reference exactly.

---

## 4. ESLint + Prettier Configs

### eslint.config.js

```js
import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';
import noCatchAll from 'eslint-plugin-no-catch-all';

export default [
  { ignores: ['node_modules/', 'dist/', 'skills/'] },
  { files: ['src/**/*.{js,ts}', 'test/**/*.{js,ts}'] },
  { languageOptions: { globals: globals.node } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'no-catch-all': noCatchAll },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-catch-all/no-catch-all': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
```

**Differences from thekraken-reference:**

- Removed `groups/` and `container/` from ignores (do not exist in v2).
- Added `skills/` to ignores (markdown + non-TS files).
- Added `test/**/*.{js,ts}` to files scope (reference did not lint tests).
- Removed broken `preserve-caught-error` rule — that rule does not exist in
  the referenced plugin. The reference had a misconfiguration. Use only
  `no-catch-all/no-catch-all`.

### .prettierrc

```json
{
  "singleQuote": true
}
```

Matches the reference exactly. No changes needed.

### vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
```

**Difference from reference:** Tests live in `test/` not `src/`. The reference
mixed test files into `src/` — v2 separates them cleanly.

---

## 5. SQLite Schema (Exact DDL)

Developers: copy this SQL verbatim into `src/db/schema.ts` as an exported
`const SCHEMA_V1`.

```sql
-- The Kraken v2 schema
-- Applied once on fresh install. No migration history needed for v2.0.

CREATE TABLE IF NOT EXISTS user_tokens (
  slack_user_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,          -- ISO 8601
  keycloak_sub TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enclave_bindings (
  channel_id TEXT PRIMARY KEY,
  enclave_name TEXT NOT NULL UNIQUE,        -- UNIQUE so dependent FKs can target it
  owner_slack_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'archived'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Note: UNIQUE on enclave_name implicitly creates an index; no separate
-- index declaration needed.

CREATE TABLE IF NOT EXISTS outbound_messages (
  id TEXT PRIMARY KEY,               -- UUID v4
  channel_id TEXT NOT NULL,
  thread_ts TEXT,                    -- NULL for top-level messages
  message_ts TEXT,                   -- Slack message_ts after post (NULL if pending)
  content_hash TEXT NOT NULL,        -- SHA-256 of content for dedup on restart
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_outbound_messages_channel
  ON outbound_messages(channel_id, thread_ts);

CREATE INDEX IF NOT EXISTS idx_outbound_messages_hash
  ON outbound_messages(content_hash);

CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enclave TEXT NOT NULL,
  tentacle TEXT NOT NULL,
  version INTEGER NOT NULL,
  git_sha TEXT NOT NULL,
  git_tag TEXT NOT NULL,
  deploy_type TEXT NOT NULL,         -- 'deploy' | 'rollback' | 'archive' | 'restore'
  summary TEXT NOT NULL,
  details TEXT,
  deployed_by_email TEXT NOT NULL,
  triggered_by_channel TEXT NOT NULL,
  triggered_by_ts TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'success' | 'failed'
  status_detail TEXT,
  UNIQUE(enclave, tentacle, version),
  FOREIGN KEY (enclave) REFERENCES enclave_bindings(enclave_name)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deployments_tentacle
  ON deployments(enclave, tentacle);

CREATE INDEX IF NOT EXISTS idx_deployments_created
  ON deployments(created_at DESC);

CREATE TABLE IF NOT EXISTS thread_sessions (
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  session_id TEXT NOT NULL,          -- Pi agent session ID
  user_slack_id TEXT NOT NULL,
  enclave_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_active_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (channel_id, thread_ts),
  FOREIGN KEY (enclave_name) REFERENCES enclave_bindings(enclave_name)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_thread_sessions_user
  ON thread_sessions(user_slack_id);

CREATE INDEX IF NOT EXISTS idx_thread_sessions_enclave
  ON thread_sessions(enclave_name);
```

**Implementation in `src/db/schema.ts`:**

```typescript
export const SCHEMA_V1 = `
... (the SQL above) ...
`;
```

### 5.1 Foreign Key Policy

SQLite is the Kraken's **key operational state**, not a cache. Git is
the source of truth for tentacle source code and deployment history, but
Kraken DB is authoritative for live operational state (channel-to-enclave
bindings, user tokens, in-flight deploy status, thread sessions).

**FK relationships:**

| Child Table | Column | References | On Delete | On Update |
|-------------|--------|-----------|-----------|-----------|
| `deployments` | `enclave` | `enclave_bindings(enclave_name)` | CASCADE | CASCADE |
| `thread_sessions` | `enclave_name` | `enclave_bindings(enclave_name)` | CASCADE | CASCADE |

`outbound_messages` intentionally has NO FK to `enclave_bindings`. It
records sends to any Slack channel (including DMs and non-enclave
channels), so `channel_id` is not guaranteed to exist in
`enclave_bindings`.

`user_tokens` has no FK (not tied to any enclave).

**Enforcement:** `PRAGMA foreign_keys = ON` must be set on every
connection. The `applyMigrations()` function sets it, and any code that
opens a `better-sqlite3` connection directly must do the same (use the
shared `createDatabase()` helper to avoid drift).

**Archive semantics (destructive for dependents):**

When an enclave is deprovisioned, `enclave_bindings` row is deleted and
CASCADE removes:
- All `deployments` rows for that enclave (history lost; git still has it)
- All `thread_sessions` rows for that enclave (pi sessions orphaned)

This is intentional. Archive is considered a somewhat destructive
operation. If history needs to be preserved for that enclave, the
operator must take a snapshot (DB backup or deployment log export) before
the archive. See Followup F1 below.

**Rebuild ordering on startup:**

When rebuilding `deployments` from `git log` on pod start, populate
`enclave_bindings` first (from the `enclaves/` directory tree in git)
THEN populate `deployments`. A `deployments` row without its parent
enclave_bindings row is an error and will fail insert.

```
Startup order:
1. applyMigrations()  -- creates schema, PRAGMA foreign_keys = ON
2. reconcileEnclaveBindings()  -- reads enclaves/ from git, populates enclave_bindings
3. rebuildDeploymentsFromGit()  -- reads git log, populates deployments
4. (other state populated as needed)
```

### 5.2 Followup F1: Archive History Preservation (Future Phase)

**Not addressed in Phase 0.** Tracked for later.

Current design: archive is destructive for `deployments` and
`thread_sessions`. Rehydrating an archived enclave loses its deploy
history and thread context. Rehydration is considered low priority and
acceptable as an operator-intervention disaster-recovery scenario.

If we later decide archive must be non-destructive, options include:
- Soft-delete (`enclave_bindings.status = 'archived'`) with FK still
  pointing, and application-layer filtering
- Pre-archive snapshot table (`archived_deployments`, etc.)
- Export to the git repo itself (machine-readable append to `CONTEXT.md`
  or a dedicated `HISTORY.md`) before dropping the row

Logged in `/Users/rbias/code/tentacular-main/scratch/kraken-v2-followups.md`.

---

**Implementation in `src/db/migrations.ts`:**

```typescript
import Database from 'better-sqlite3';
import { SCHEMA_V1 } from './schema.js';

export function applyMigrations(db: Database.Database): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_V1);
}

export function createDatabase(path: string = ':memory:'): Database.Database {
  const db = new Database(path);
  applyMigrations(db);
  return db;
}
```

---

## 6. Config Module Interface

```typescript
// src/config.ts

export interface SlackConfig {
  /** Slack bot OAuth token (xoxb-...). Required. */
  botToken: string;
  /** Slack app-level token for Socket Mode (xapp-...). Required if mode is 'socket'. */
  appToken?: string;
  /** Slack signing secret for HTTP Events API. Required if mode is 'http'. */
  signingSecret?: string;
  /** Transport mode. Default: 'http'. */
  mode: 'http' | 'socket';
}

export interface OidcConfig {
  /** Keycloak realm URL. Required. */
  issuer: string;
  /** OIDC client ID. Required. */
  clientId: string;
  /** OIDC client secret. Required. */
  clientSecret: string;
}

export interface McpConfig {
  /** URL of tentacular-mcp in-cluster server. Required. */
  url: string;
  /** Port for NetworkPolicy scoping. Default: 8080. */
  port: number;
}

export interface LlmConfig {
  /** Default LLM provider. Default: 'anthropic'. */
  defaultProvider: 'anthropic' | 'openai' | 'google';
  /** Default model ID. Default: 'claude-sonnet-4-6'. */
  defaultModel: string;
  /** Allowed providers list. Default: ['anthropic', 'openai', 'google']. */
  allowedProviders: string[];
  /**
   * Allowed models per provider. If a provider key is absent, all models
   * from that provider are allowed (subject to disallowedModels).
   */
  allowedModels: Record<string, string[]>;
  /**
   * Globally disallowed model IDs. Takes precedence over allowedModels.
   * Default: ['gpt-4o', 'o3', 'o4-mini', 'gpt-5-nano', 'gpt-5-mini', 'gemini-2.5-pro']
   */
  disallowedModels: string[];
}

export interface GitStateConfig {
  /** Git repo URL for tentacle state. Required (hard fail if unset). */
  repoUrl: string;
  /** Branch to track. Default: 'main'. */
  branch: string;
  /** Local clone directory. Default: '/app/data/git-state'. */
  dir: string;
}

export interface ServerConfig {
  /** HTTP port for health endpoint and Slack Bolt. Default: 3000. */
  port: number;
}

export interface KrakenConfig {
  slack: SlackConfig;
  oidc: OidcConfig;
  mcp: McpConfig;
  llm: LlmConfig;
  gitState: GitStateConfig;
  server: ServerConfig;
}
```

### Environment Variable Mapping

| Env Var | Config Field | Required | Default |
|---------|-------------|----------|---------|
| `SLACK_BOT_TOKEN` | `slack.botToken` | Yes | -- |
| `SLACK_APP_TOKEN` | `slack.appToken` | If `SLACK_MODE=socket` | -- |
| `SLACK_SIGNING_SECRET` | `slack.signingSecret` | If `SLACK_MODE=http` | -- |
| `SLACK_MODE` | `slack.mode` | No | `http` |
| `OIDC_ISSUER` | `oidc.issuer` | Yes | -- |
| `OIDC_CLIENT_ID` | `oidc.clientId` | Yes | -- |
| `OIDC_CLIENT_SECRET` | `oidc.clientSecret` | Yes | -- |
| `TENTACULAR_MCP_URL` | `mcp.url` | Yes | -- |
| `MCP_PORT` | `mcp.port` | No | `8080` |
| `LLM_DEFAULT_PROVIDER` | `llm.defaultProvider` | No | `anthropic` |
| `LLM_DEFAULT_MODEL` | `llm.defaultModel` | No | `claude-sonnet-4-6` |
| `LLM_ALLOWED_PROVIDERS` | `llm.allowedProviders` | No | `anthropic,openai,google` |
| `LLM_ALLOWED_MODELS` | `llm.allowedModels` | No | (see below) |
| `LLM_DISALLOWED_MODELS` | `llm.disallowedModels` | No | (see below) |
| `GIT_STATE_REPO_URL` | `gitState.repoUrl` | Yes | -- |
| `GIT_STATE_BRANCH` | `gitState.branch` | No | `main` |
| `GIT_STATE_DIR` | `gitState.dir` | No | `/app/data/git-state` |
| `PORT` | `server.port` | No | `3000` |

### LLM_ALLOWED_MODELS Format

Comma-separated `provider:model1|model2` entries:

```
LLM_ALLOWED_MODELS=anthropic:claude-sonnet-4-6|claude-opus-4-6|claude-sonnet-4-6-thinking,openai:gpt-5.3-chat-latest|gpt-5.4,google:gemini-3-pro-preview|gemini-3.1-pro
```

### LLM_DISALLOWED_MODELS Format

Comma-separated model IDs:

```
LLM_DISALLOWED_MODELS=gpt-4o,o3,o4-mini,gpt-5-nano,gpt-5-mini,gemini-2.5-pro
```

### `loadConfig()` Behavior

```typescript
export function loadConfig(): KrakenConfig {
  // 1. Read all env vars
  // 2. Validate required vars; throw Error with descriptive message listing
  //    ALL missing vars (not just the first one)
  // 3. Apply defaults
  // 4. Parse LLM_ALLOWED_MODELS and LLM_DISALLOWED_MODELS
  // 5. Return frozen KrakenConfig object
}
```

The function throws on:
- Missing `SLACK_BOT_TOKEN`
- Missing `SLACK_SIGNING_SECRET` when `SLACK_MODE` is `http` (or unset)
- Missing `SLACK_APP_TOKEN` when `SLACK_MODE` is `socket`
- Missing `OIDC_ISSUER`, `OIDC_CLIENT_ID`, or `OIDC_CLIENT_SECRET`
- Missing `TENTACULAR_MCP_URL`
- Missing `GIT_STATE_REPO_URL`

Error messages must name the missing variable(s) explicitly:

```
KrakenConfig: missing required environment variables: SLACK_BOT_TOKEN, GIT_STATE_REPO_URL
```

---

## 7. Health Endpoint Interface

```typescript
// src/health.ts
import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
}

/**
 * Creates a standalone HTTP server that serves /healthz.
 * Used ONLY when Slack Bolt is in Socket Mode (Bolt does not start its own
 * HTTP server in socket mode). In HTTP mode, the health route is registered
 * on Bolt's Express receiver instead.
 *
 * @param port - Port to listen on (default: from config.server.port)
 * @returns The HTTP server instance (for test teardown)
 */
export function createHealthServer(port: number): Server {
  const server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url === '/healthz') {
        const body: HealthResponse = { status: 'ok' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404);
      res.end();
    }
  );
  server.listen(port);
  return server;
}

/**
 * Express-compatible request handler for mounting on Bolt's receiver.
 * Used in HTTP mode where Bolt owns the HTTP server on port 3000.
 */
export function healthHandler(
  req: IncomingMessage,
  res: ServerResponse
): void {
  const body: HealthResponse = { status: 'ok' };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
```

**Composition strategy:** The `src/index.ts` startup sequence (Phase 1) will:
- In `http` mode: Create Bolt's `ExpressReceiver`, register `/healthz` via
  `receiver.router.get('/healthz', healthHandler)`, then start Bolt on port
  3000.
- In `socket` mode: Start Bolt with `SocketModeReceiver` (no HTTP), then
  call `createHealthServer(config.server.port)` for K8s probes.

For Phase 0, only the standalone `createHealthServer` is tested. The
Express-compatible handler is exported but not tested until Phase 1 when Bolt
is integrated.

---

## 8. Test Harness Architecture

### AIMock Setup: Per-Test, Not Global

**Decision:** Use AIMock's manual setup/teardown per test file, not `globalSetup`.

**Rationale:** Global setup means a single LLMock/MCPMock server running for the
entire test suite. This creates shared mutable state between tests (response
queues, call recordings). Per-test instances are isolated and predictable. The
overhead of starting/stopping is negligible (LLMock binds to a random port in
<10ms).

**Pattern:**

```typescript
// test/unit/aimock-smoke.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LLMock, MCPMock } from '@copilotkit/aimock';

describe('AIMock smoke', () => {
  let llmock: LLMock;
  let mcpmock: MCPMock;

  beforeEach(async () => {
    llmock = new LLMock({ port: 0 });  // random port
    await llmock.start();
    mcpmock = new MCPMock({ port: 0 });
    await mcpmock.start();
  });

  afterEach(async () => {
    await llmock.stop();
    await mcpmock.stop();
  });

  it('intercepts an Anthropic API call', async () => {
    llmock.addResponse('anthropic', {
      content: [{ type: 'text', text: 'Hello from mock' }],
    });

    const res = await fetch(
      `http://localhost:${llmock.port}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'test-key',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'test' }],
        }),
      }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content[0].text).toBe('Hello from mock');
  });

  it('intercepts an MCP tool call', async () => {
    mcpmock.addTool('ns_list', {
      result: { namespaces: ['marketing', 'engineering'] },
    });

    // MCPMock exposes a JSON-RPC endpoint
    const res = await fetch(
      `http://localhost:${mcpmock.port}/mcp`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'ns_list', arguments: {} },
          id: 1,
        }),
      }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.namespaces).toContain('marketing');
  });
});
```

**Note:** The exact AIMock API may differ from the pseudocode above. The
developer implementing T07 must read the `@copilotkit/aimock` README and
adjust constructor signatures and method names accordingly. The test structure
(per-test lifecycle, random ports, explicit start/stop) is the design decision;
the API details are implementation.

### MockSlackWebClient

```typescript
// test/mocks/slack-client.ts

export interface MockCall {
  method: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export class MockSlackWebClient {
  calls: Record<string, MockCall[]> = {};
  private responses: Record<string, unknown[]> = {};

  /** Register a scripted response for a Slack API method. */
  addResponse(method: string, response: unknown): void {
    if (!this.responses[method]) {
      this.responses[method] = [];
    }
    this.responses[method].push(response);
  }

  /** Get the last call for a method, or undefined. */
  lastCall(method: string): MockCall | undefined {
    const methodCalls = this.calls[method];
    return methodCalls?.[methodCalls.length - 1];
  }

  /** Reset all calls and responses. */
  reset(): void {
    this.calls = {};
    this.responses = {};
  }

  /** Proxy handler — intercepts any method call (chat.postMessage, etc.) */
  [key: string]: unknown;
}
```

Implementation uses a `Proxy` so that `client.chat.postMessage({ ... })`
records to `calls['chat.postMessage']` and returns the next scripted response
(or a default `{ ok: true }` if none queued).

### SlackEventSimulator

```typescript
// test/mocks/event-simulator.ts

export interface SlackEvent {
  type: string;
  [key: string]: unknown;
}

export interface SlackEventEnvelope {
  type: 'event_callback';
  event: SlackEvent;
  event_id: string;
  team_id: string;
}

export function createAppMention(opts: {
  channel: string;
  user: string;
  text: string;
  threadTs?: string;
}): SlackEventEnvelope { /* ... */ }

export function createMessage(opts: {
  channel: string;
  user: string;
  text: string;
  threadTs?: string;
}): SlackEventEnvelope { /* ... */ }

export function createChannelArchive(opts: {
  channel: string;
}): SlackEventEnvelope { /* ... */ }

export function createChannelRename(opts: {
  channel: string;
  name: string;
}): SlackEventEnvelope { /* ... */ }

export function createMemberLeftChannel(opts: {
  channel: string;
  user: string;
}): SlackEventEnvelope { /* ... */ }
```

Each factory generates a structurally valid Slack event payload with
auto-generated `event_id`, `team_id`, and `ts` values.

---

## 9. entrypoint.sh v2

Below is the complete v2 entrypoint. Changes from the reference are marked
with comments.

```bash
#!/usr/bin/env bash
set -euo pipefail

# ─── tntc config ───────────────────────────────────────────────
TNTC_HOME="${HOME}/.tentacular"
mkdir -p "$TNTC_HOME"

if [ -n "${TENTACULAR_MCP_URL:-}" ]; then
  cat > "$TNTC_HOME/config.yaml" <<EOF
environments:
    default:
        mcp_endpoint: ${TENTACULAR_MCP_URL:-}
        oidc_issuer: ${OIDC_ISSUER:-}
        oidc_client_id: ${OIDC_CLIENT_ID:-}
default_env: default
registry: ${TNTC_REGISTRY:-ghcr.io/randybias}
workspace: /app/data/workspaces
EOF
elif [ ! -f "$TNTC_HOME/config.yaml" ]; then
  echo "WARNING: TENTACULAR_MCP_URL not set and no existing config found" >&2
fi

mkdir -p /app/data/workspaces

# ─── REMOVED: Claude session symlink (NanoClaw artifact) ──────
# ─── REMOVED: Sender allowlist migration (NanoClaw artifact) ──

# ─── Git-backed state (MANDATORY in v2) ───────────────────────
# CHANGED: No GIT_STATE_ENABLED toggle. Always required.

if [ -z "${GIT_STATE_REPO_URL:-}" ]; then
  echo "FATAL: GIT_STATE_REPO_URL is required but not set. The Kraken refuses to start without git-state." >&2
  exit 1
fi

GIT_STATE_DIR="${GIT_STATE_DIR:-/app/data/git-state}"

git config --global user.name "${GIT_STATE_USER_NAME:-The Kraken}"
git config --global user.email "${GIT_STATE_USER_EMAIL:-kraken@tentacular.dev}"

if [ -f /app/.git-credentials/token ]; then
  git config --global credential.helper \
    '!f() { echo "username=token"; echo "password=$(cat /app/.git-credentials/token)"; }; f'
fi

if [ -d "$GIT_STATE_DIR/.git" ]; then
  # CHANGED: Hard fail on pull failure (no stale-copy fallback)
  if ! (cd "$GIT_STATE_DIR" && git pull --ff-only origin "${GIT_STATE_BRANCH:-main}"); then
    echo "FATAL: git pull failed for state repo. The Kraken refuses to start with stale state." >&2
    exit 1
  fi
else
  # CHANGED: Hard fail on clone failure
  if ! git clone --branch "${GIT_STATE_BRANCH:-main}" "${GIT_STATE_REPO_URL}" "$GIT_STATE_DIR"; then
    echo "FATAL: git clone failed for ${GIT_STATE_REPO_URL}. The Kraken cannot start." >&2
    exit 1
  fi
fi

# Set hooks path to kraken-hooks (version bump on commit)
git -C "$GIT_STATE_DIR" config core.hooksPath /app/kraken-hooks

# Append git_state to tntc config
cat >> "$TNTC_HOME/config.yaml" <<EOF
git_state:
    repo_path: ${GIT_STATE_DIR}
    enabled: true
EOF

exec node dist/index.js "$@"
```

### Summary of Diffs from Reference

| Line/Section | Reference | v2 |
|---|---|---|
| Claude session symlink (lines 28-35) | Present | Removed |
| Sender allowlist migration (lines 37-43) | Present | Removed |
| `GIT_STATE_ENABLED` conditional (line 46) | `if [ "${GIT_STATE_ENABLED:-}" = "true" ]` | Removed; always on |
| Missing `GIT_STATE_REPO_URL` | Silently skipped | `exit 1` with FATAL message |
| `git pull` failure | `WARNING` + continue | `exit 1` with FATAL message |
| `git clone` failure | Implicit (set -e catches) | Explicit `exit 1` with FATAL message |
| `core.hooksPath` | Not set | Set to `/app/kraken-hooks` |
| Exit codes | Implicit | Always `exit 1` for config/git failures |

---

## 10. Pre-Commit Hook

### Decision: `sed` over `yq`

**Decision:** Use `sed` for version bumping. Do not use `yq`.

**Rationale:**
1. `yq` has two incompatible implementations (mikefarah/yq and kislyuk/yq).
   Installing the wrong one is a common failure mode.
2. The version field is always on a line matching `^version: \d+$` in
   `workflow.yaml`. A simple `sed` substitution is sufficient and testable.
3. Avoids adding a Dockerfile dependency (yq is not in `node:22` base image).
4. `sed` behavior is consistent across GNU/BSD in this specific pattern.

### kraken-hooks/pre-commit

```bash
#!/usr/bin/env bash
set -euo pipefail

# Pre-commit hook for git-state repo.
# Auto-bumps version: N -> N+1 in workflow.yaml for any tentacle with staged changes.
# Ignores CONTEXT.md-only changes (doc commits should not bump version).

ENCLAVES_DIR="enclaves"

# Get list of staged files under enclaves/
staged_files=$(git diff --cached --name-only --diff-filter=ACMR -- "${ENCLAVES_DIR}/")

if [ -z "$staged_files" ]; then
  exit 0
fi

# Extract unique tentacle directories (enclave/tentacle pairs)
tentacle_dirs=()
while IFS= read -r file; do
  # Skip CONTEXT.md at any level
  if [[ "$file" == */CONTEXT.md ]]; then
    continue
  fi

  # Extract enclave/tentacle path: enclaves/<enclave>/<tentacle>/...
  # We need at least 3 path components under enclaves/
  dir=$(echo "$file" | cut -d'/' -f1-3)
  if [ "$(echo "$dir" | tr '/' '\n' | wc -l)" -ge 3 ]; then
    tentacle_dirs+=("$dir")
  fi
done <<< "$staged_files"

# Deduplicate
mapfile -t unique_dirs < <(printf '%s\n' "${tentacle_dirs[@]}" | sort -u)

for tentacle_dir in "${unique_dirs[@]}"; do
  workflow_file="${tentacle_dir}/workflow.yaml"

  if [ ! -f "$workflow_file" ]; then
    continue
  fi

  # Read current version
  current_version=$(sed -n 's/^version: *\([0-9]*\)$/\1/p' "$workflow_file")

  if [ -z "$current_version" ]; then
    echo "WARNING: No 'version:' field found in ${workflow_file}, skipping bump" >&2
    continue
  fi

  new_version=$((current_version + 1))

  # Replace version line in place
  sed -i'' "s/^version: *${current_version}$/version: ${new_version}/" "$workflow_file"

  # Re-stage the bumped file
  git add "$workflow_file"

  echo "pre-commit: bumped ${workflow_file} from v${current_version} to v${new_version}"
done
```

**Testing approach:** The unit test (T11) creates a temporary git repo with a
mock `enclaves/test-enclave/test-tentacle/workflow.yaml`, stages a change, runs
the hook script, and asserts the version was incremented.

**Note on `sed -i''`:** This syntax works on both GNU sed (`-i''` is a no-op
suffix) and BSD sed (macOS, where `-i ''` with space is also accepted). In the
Docker container (Debian-based `node:22`), GNU sed is used, so this is safe.

---

## 11. Dockerfile v2

### Decision: Single-Stage, node:22 (Not Alpine, Not Distroless)

**Rationale:**
- `better-sqlite3` requires native compilation. Alpine uses musl libc which
  causes build failures or requires additional tooling. The reference already
  solved this by using `node:22` (Debian bookworm, glibc).
- Distroless lacks a shell, which `entrypoint.sh` requires.
- Multi-stage would save ~200MB but the reference already proved that ARM64
  cross-compilation of native modules in multi-stage is fragile. Single-stage
  is reliable on both architectures.
- The image is internal (GHCR, private). Size is not a priority over
  reliability.

### Dockerfile

```dockerfile
# Single-stage: node:22 (bookworm) — needed for better-sqlite3 native compilation
FROM node:22

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Disable husky (not used in v2, but prevents accidental npm lifecycle issues)
ENV HUSKY=0

COPY package*.json ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

# Prune to production deps only
RUN npm prune --omit=dev

# Remove source and dev artifacts
RUN rm -rf src/ tsconfig.json

# Download tntc CLI binary (arch-aware)
ARG TNTC_VERSION=latest
ARG TARGETARCH
RUN if [ "$TNTC_VERSION" = "latest" ]; then \
      TNTC_VERSION=$(curl -fsSL https://api.github.com/repos/randybias/tentacular/releases/latest | grep '"tag_name"' | sed 's/.*"tag_name": *"\(.*\)".*/\1/'); \
    fi \
  && TNTC_ARCH="${TARGETARCH}" \
  && curl -fsSL "https://github.com/randybias/tentacular/releases/download/${TNTC_VERSION}/tntc_linux_${TNTC_ARCH}" -o /usr/local/bin/tntc \
  && chmod +x /usr/local/bin/tntc

# Bundle skills
COPY skills/ /app/skills/

# Entrypoint + hooks
COPY scripts/entrypoint.sh /app/scripts/entrypoint.sh
RUN chmod +x /app/scripts/entrypoint.sh
COPY kraken-hooks/ /app/kraken-hooks/
RUN chmod +x /app/kraken-hooks/pre-commit

# Data directory — owned by node user
RUN mkdir -p /app/data /app/data/workspaces && chown -R node:node /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Run as non-root node user (UID 1000)
USER node

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
```

### Diffs from Reference Dockerfile

| Line/Section | Reference | v2 |
|---|---|---|
| `COPY skills/tentacular/SKILL.md ...` | Copies skill files individually | `COPY skills/ /app/skills/` (whole directory) |
| `COPY groups/ /app/groups/` | Present (NanoClaw group model) | Removed (no groups in v2) |
| `mkdir /app/store` | Present (NanoClaw store) | Removed |
| `COPY kraken-hooks/` | Not present | Added |
| `chmod +x kraken-hooks/pre-commit` | Not present | Added |

---

## 12. Helm Chart v2

### Chart.yaml

```yaml
apiVersion: v2
name: thekraken
description: The Kraken v2 — Pi-based enclave-centric Slack bot for Tentacular
type: application
version: 0.1.0
appVersion: "2.0.0"
home: https://github.com/randybias/thekraken
sources:
  - https://github.com/randybias/thekraken
maintainers:
  - name: Randy Bias
    url: https://github.com/randybias
keywords:
  - slack
  - bot
  - tentacular
  - enclave
  - pi
```

### values.yaml

```yaml
namespace:
  create: true
  name: tentacular-kraken

replicaCount: 1

image:
  repository: ghcr.io/randybias/thekraken
  pullPolicy: IfNotPresent
  tag: ""  # Defaults to .Chart.AppVersion

imagePullSecrets: []

serviceAccount:
  create: true
  name: ""

podSecurityContext:
  fsGroup: 1000

securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: false
  capabilities:
    drop:
      - ALL

resources:
  requests:
    cpu: 500m
    memory: 1Gi
  limits:
    cpu: 4000m
    memory: 8Gi

livenessProbe:
  httpGet:
    path: /healthz
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 30
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /healthz
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 6

persistence:
  enabled: true
  size: 1Gi
  accessMode: ReadWriteOnce
  storageClass: ""

slack:
  mode: "http"

ingress:
  enabled: true
  host: "kraken.eastus-dev1.ospo-dev.miralabs.dev"
  clusterIssuer: "letsencrypt-prod"

# Secrets — set via --set or existingSecret, never committed
secrets:
  slackBotToken: ""
  slackAppToken: ""
  slackSigningSecret: ""
  anthropicApiKey: ""
  openaiApiKey: ""       # NEW: Optional, for OpenAI provider
  geminiApiKey: ""       # NEW: Optional, for Google provider
  oidcClientSecret: ""
  existingSecret: ""

mcp:
  url: "http://tentacular-mcp:8080"
  port: 8080

oidc:
  issuer: ""
  clientId: ""

# LLM provider configuration (design Section 15)
llm:
  defaultProvider: "anthropic"
  defaultModel: "claude-sonnet-4-6"
  allowedProviders: "anthropic,openai,google"
  # Format: provider:model1|model2,provider:model1|model2
  allowedModels: "anthropic:claude-sonnet-4-6|claude-opus-4-6|claude-sonnet-4-6-thinking,openai:gpt-5.3-chat-latest|gpt-5.4,google:gemini-3-pro-preview|gemini-3.1-pro"
  disallowedModels: "gpt-4o,o3,o4-mini,gpt-5-nano,gpt-5-mini,gemini-2.5-pro"

# Git-backed state — REQUIRED in v2 (no enabled toggle)
gitState:
  repoUrl: ""                 # REQUIRED — Helm template fails if empty
  branch: "main"
  credentialsSecret: ""       # REQUIRED — K8s Secret with key 'token'
  userName: "The Kraken"
  userEmail: "kraken@tentacular.dev"

networkPolicy:
  enabled: true

nodeSelector: {}
tolerations: []
affinity: {}
```

### Helm `required` Enforcement

**Decision:** Enforce `gitState.repoUrl` and `gitState.credentialsSecret` via
Helm's `required` function in the deployment template.

**Rationale:** Catching missing required values at `helm install` time is
better than having the pod crash-loop at runtime. The entrypoint also validates,
but Helm validation gives a cleaner error message before any pod is created.

In `templates/deployment.yaml`, add at the top:

```yaml
{{- $_ := required "gitState.repoUrl is required (The Kraken v2 requires git-backed state)" .Values.gitState.repoUrl -}}
{{- $_ := required "gitState.credentialsSecret is required" .Values.gitState.credentialsSecret -}}
```

### values-mirantis.yaml

```yaml
gitState:
  repoUrl: "https://github.com/randybias/mirantis-tentacle-workflows.git"
  branch: "main"
  credentialsSecret: "thekraken-git-state"

llm:
  defaultProvider: "anthropic"
  defaultModel: "claude-sonnet-4-6"
```

### What's Removed from Reference

| Reference Feature | Status | Reason |
|---|---|---|
| `gitState.enabled` toggle | Removed | Always-on in v2 |
| `config.anthropicModel` | Replaced by `llm.defaultModel` | Multi-provider support |
| `config.assistantName` | Removed | Hardcoded to "Kraken" |
| `config.timezone` | Removed | Task scheduling dropped from v2 |
| `ANTHROPIC_MODEL` in ConfigMap | Replaced by `LLM_*` vars | |
| `ASSISTANT_NAME` in ConfigMap | Removed | |
| `TZ` in ConfigMap | Removed | |
| Conditional `GIT_STATE_ENABLED` in ConfigMap | Removed | Always set |
| Volume mounts for `groups/` and `store/` | Removed | NanoClaw artifacts |

### What's Added

| Feature | Where |
|---|---|
| `llm.*` config section | values.yaml |
| `LLM_*` env vars | ConfigMap template |
| `secrets.openaiApiKey` | Secret template |
| `secrets.geminiApiKey` | Secret template |
| `GIT_STATE_USER_NAME`, `GIT_STATE_USER_EMAIL` | ConfigMap template |
| `required` validation for gitState | deployment.yaml |

### Template Changes Summary

**configmap.yaml:** Remove `ANTHROPIC_MODEL`, `ASSISTANT_NAME`, `TZ`. Remove
conditional `GIT_STATE_ENABLED`. Add `GIT_STATE_REPO_URL`, `GIT_STATE_BRANCH`,
`GIT_STATE_DIR`, `GIT_STATE_USER_NAME`, `GIT_STATE_USER_EMAIL`, `LLM_DEFAULT_PROVIDER`,
`LLM_DEFAULT_MODEL`, `LLM_ALLOWED_PROVIDERS`, `LLM_ALLOWED_MODELS`,
`LLM_DISALLOWED_MODELS`.

**secret.yaml:** Add `OPENAI_API_KEY` and `GEMINI_API_KEY` (conditional on
non-empty values).

**deployment.yaml:** Remove conditional on `gitState.enabled` for volume mount
and volume — always mount git-credentials. Remove `groups/` and `store/`
subPath mounts. Add `required` validation.

**networkpolicy.yaml:** Remove conditional on `gitState.enabled` for SSH
egress — always include it (git HTTPS uses port 443 which is already allowed,
but SSH fallback should remain available).

All other templates (_helpers.tpl, ingress.yaml, namespace.yaml, pvc.yaml,
service.yaml, serviceaccount.yaml) port unchanged from the reference.

---

## 13. CI Workflows

### .github/workflows/ci.yml

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Typecheck
        run: npx tsc --noEmit

      - name: Lint
        run: npm run lint

      - name: Format check
        run: npm run format:check

      - name: Tests
        run: npm test

      - name: Helm lint
        run: |
          curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
          helm lint charts/thekraken

      - name: Shellcheck
        run: |
          sudo apt-get install -y shellcheck
          shellcheck scripts/entrypoint.sh kraken-hooks/pre-commit
```

**Differences from reference CI:**
- Triggers on push to `main` AND pull requests (reference only triggered on
  PR).
- Node.js 22 (reference used 20).
- Added `npm run lint` step (reference omitted linting).
- Added Helm lint step.
- Added shellcheck step for entrypoint and pre-commit hook.
- Uses `npm test` instead of `npx vitest run` (both are equivalent given the
  `"test": "vitest run"` script).

### .github/workflows/docker-build.yml

```yaml
name: Docker Build and Push

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/randybias/thekraken
          tags: |
            type=ref,event=tag
            type=raw,value=latest

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

This is identical to the reference. No changes needed — it already supports
multi-arch and GHCR push.

---

## 14. OpenSpec project.md

```markdown
# The Kraken v2 — OpenSpec Project Configuration

## Change Naming Convention

Changes are named with phase-based slugs:

- `phase0-scaffold` — Scaffold + test harness + git-state infra port
- `phase1-core-loop` — Core loop (Slack + pi Agent + MCP + enclave binding)
- `phase2-auth-authz` — Auth + authz (OIDC device flow + POSIX + tool scoping)
- `phase3-commands-events` — Commands + channel events + personas
- `phase4-polish-deploy` — Polish + deploy (Block Kit, Home Tab, Helm, values overlay)
- `phase5-hardening` — Hardening (restart resilience, rate limits, observability)

Cross-repo changes use descriptive slugs: `wf-apply-requires-version`.

## Required Artifacts Per Change

Every OpenSpec change directory must contain:

| File | Owner | Required |
|------|-------|----------|
| `proposal.md` | Product Manager | Yes |
| `design.md` | Architect | Yes |
| `tasks.md` | Product Manager | Yes |
| `.openspec.yaml` | Auto-generated | Yes |
| `specs/**/spec.md` | Developer | If specs exist |

## Review Gates

Each change must pass ALL of the following before merge:

1. **Code Review** — Senior Developer or Code Reviewer. Correctness,
   completeness, maintainability.
2. **Security Review** — Senior Security Architect. Auth flows, credential
   handling, tool scoping, git operations.
3. **QA Review** — Senior QA Engineer. Test coverage, no flaky tests, scenario
   coverage where applicable.
4. **Tech Writer Review** — Senior Technical Writer. README, CLAUDE.md, skill
   docs, JSDoc quality.
5. **Codex Review** — Automated (skippable if MCP unreachable; log reason +
   timestamp in tasks.md).

## Branch Naming

```
feature/<change-slug>
```

Examples: `feature/phase0-scaffold`, `feature/phase1-core-loop`.

## Commit Convention

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

```
feat: add SQLite schema for v2 tables
fix: handle missing GIT_STATE_REPO_URL in entrypoint
test: add AIMock smoke tests
chore: configure eslint + prettier for v2
docs: add Phase 0 design document
```

## Pre-Push Gates

Every developer must pass before pushing:

```bash
npm test && npx tsc --noEmit && npm run lint && npm run format:check
```

For shell scripts:

```bash
shellcheck scripts/entrypoint.sh kraken-hooks/pre-commit
```

For Helm chart:

```bash
helm lint charts/thekraken
```

## Definition of Done (Per Change)

- [ ] OpenSpec artifacts consistent (proposal, design, tasks)
- [ ] Code implemented and committed (Conventional Commits)
- [ ] Code Reviewer sign-off
- [ ] Security Architect sign-off
- [ ] Tests passing (`npm test` green)
- [ ] Typecheck clean (`npx tsc --noEmit`)
- [ ] Lint clean (`npm run lint && npm run format:check`)
- [ ] Docs updated (README, CLAUDE.md, skill references)
- [ ] Codex review run (or skip logged)
```

---

## Decisions Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | npm, not pnpm | Matches thekraken-reference. No reason to change package managers for a rewrite. |
| D2 | `@copilotkit/aimock` is the npm package name | Confirmed via GitHub repo README. |
| D3 | AIMock: per-test setup, not globalSetup | Isolation. No shared mutable state between tests. |
| D4 | AIMock: manual setup/teardown, not vitest plugin | Vitest plugin (`useAimock()`) hides lifecycle. Explicit start/stop is more predictable and debuggable. |
| D5 | `sed` for pre-commit version bump, not `yq` | Two incompatible `yq` implementations. `sed` has zero external deps. Pattern is simple enough (`^version: \d+$`). |
| D6 | Single-stage Dockerfile with `node:22` | better-sqlite3 native compilation needs glibc. Alpine uses musl. Distroless lacks shell for entrypoint. ARM64 cross-compile in multi-stage is fragile (reference already proved this). |
| D7 | Helm `required` for `gitState.repoUrl` and `gitState.credentialsSecret` | Fail at `helm install` time rather than pod crash-loop. Defense in depth with entrypoint validation. |
| D8 | No `gitState.enabled` toggle | Design doc Section 14: git-state is mandatory. The toggle was the old design's mistake. |
| D9 | `noUncheckedIndexedAccess` in tsconfig | Catches `undefined` from index operations. Worth the minor friction of `!` assertions for known-safe access. |
| D10 | ESLint: removed broken `preserve-caught-error` rule | The rule name does not exist in `eslint-plugin-no-catch-all`. Reference had a misconfiguration that was silently ignored (ESLint does not error on unknown rule names in flat config unless plugin validation is strict). |
| D11 | Test files in `test/`, not `src/` | Clean separation. Reference mixed tests into `src/` which polluted the build output. |
| D12 | Health endpoint: dual mode (standalone server + Express handler) | Socket Mode needs standalone HTTP; HTTP mode reuses Bolt's server. Both must serve `/healthz`. |
| D13 | NetworkPolicy SSH egress: always enabled | No conditional on `gitState.enabled` since gitState is always on. SSH egress is harmless even if only HTTPS cloning is used. |
| D14 | Pi packages pinned to exact `0.66.1` (no caret) | These are lockstep dependencies. A minor version bump could break the API contract. |
| D15 | No `pino`, `yaml`, `zod`, or `cron-parser` in Phase 0 | Not needed until Phase 1+. Avoids unused dependencies in the scaffold. |
| D16 | CI triggers on push to main AND PRs | Reference only triggered on PRs. We want CI on direct pushes too (catches post-merge regressions). |
| D17 | `slack/mock.ts` from design doc Section 11 placed in `test/mocks/` instead | Test mocks do not belong in production source. Section 11 was aspirational; `test/mocks/` is the correct location. |

---

## Remaining Ambiguities

| # | Item | Status | Action |
|---|------|--------|--------|
| A1 | Pi packages v0.66.1 on npm | Unverified | Developer must verify during T01. If packages are not on npm, check pi.dev/packages or contact maintainer. Document actual resolution in package.json comment. |
| A2 | AIMock exact API surface | Partially verified | Package name confirmed. Constructor args, `addResponse` signature, and MCPMock API must be verified by reading the installed package's types during T07. The test structure in Section 8 is pseudocode. |
| A3 | `sed -i''` portability | Low risk | GNU sed in Docker (Debian). BSD sed on macOS dev machines. The `sed -i''` form works on both. If a developer reports issues on macOS, use `sed -i '' -e '...'` (with space). |
