# Phase 2: Auth + Authz — Design

**Change ID:** phase2-auth-authz
**Status:** DRAFT
**Created:** 2026-04-13
**Author:** Senior Architect
**Branch:** feature/phase2-auth-authz

---

## 0. Purpose

Phase 1 delivered the dispatcher + per-enclave team architecture with
NDJSON IPC. Every `MailboxRecord.userToken` field is an empty string.
Phase 2 fills those strings with real OIDC tokens, gates every action
on POSIX mode bits, constrains MCP tool calls to enclave boundaries,
and resolves the three PM-flagged ambiguities:

1. **Tool scoping hook mechanism** (Section 6)
2. **Operation classification heuristic** (Section 7)
3. **Token propagation to running subprocesses** (Section 8)

### Inviolable Constraint: D6 (User Identity Hard Partition)

Every token path in this document MUST preserve user identity. No
service tokens, no fallbacks, no shared identities. If a user's token
expires mid-task, the task FAILS and the user re-authenticates. There
is no degraded mode.

---

## 1. OIDC Device Authorization Flow

**File:** `src/auth/oidc.ts`

### 1.1 Keycloak Endpoint Construction

All endpoints derive from `OIDC_ISSUER` (Keycloak convention):

```typescript
function endpoints(issuer: string): { deviceAuth: string; token: string } {
  return {
    deviceAuth: `${issuer}/protocol/openid-connect/auth/device`,
    token: `${issuer}/protocol/openid-connect/token`,
  };
}
```

### 1.2 Types

Ported from `thekraken-reference/src/oidc.ts` with `client_secret`
removed from the required path:

```typescript
export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  id_token?: string;
}

export interface OidcError {
  error: string;
  error_description?: string;
}
```

### 1.3 initiateDeviceAuth

```typescript
/**
 * Start a device authorization request.
 *
 * Public client: client_id is always sent. client_secret is included
 * ONLY when OIDC_CLIENT_SECRET is configured (backwards compat with
 * confidential clients). For Keycloak public clients, it is omitted.
 */
export async function initiateDeviceAuth(
  config: OidcConfig,
): Promise<DeviceAuthResponse> {
  const { deviceAuth } = endpoints(config.issuer);
  const params: Record<string, string> = {
    client_id: config.clientId,
    scope: 'openid email offline_access',
  };
  if (config.clientSecret) {
    params.client_secret = config.clientSecret;
  }

  const res = await postForm(deviceAuth, params);
  if (!res.ok) {
    const body = await res.text();
    throw new OidcFlowError('device_auth_initiation', res.status, body);
  }
  return res.json() as Promise<DeviceAuthResponse>;
}
```

### 1.4 pollForToken

```typescript
/**
 * Poll the token endpoint until the user completes the device auth flow
 * or the device code expires.
 *
 * Runs in a background task — awaits for up to expiresIn seconds.
 * Caller should wrap in a timeout if tighter control is needed.
 *
 * Error handling per RFC 8628 Section 3.5:
 *   authorization_pending -> continue polling
 *   slow_down             -> increase interval by 5s, continue
 *   expired_token         -> throw (terminal)
 *   access_denied         -> throw (terminal)
 *   <any other error>     -> throw (terminal)
 */
export async function pollForToken(
  config: OidcConfig,
  deviceCode: string,
  intervalSeconds: number,
  expiresIn: number,
): Promise<TokenResponse> {
  const { token } = endpoints(config.issuer);
  const deadline = Date.now() + expiresIn * 1000;
  let effectiveIntervalMs = Math.max(intervalSeconds, 5) * 1000;

  while (Date.now() < deadline) {
    await sleep(effectiveIntervalMs);

    const params: Record<string, string> = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: config.clientId,
    };
    if (config.clientSecret) {
      params.client_secret = config.clientSecret;
    }

    const res = await postForm(token, params);
    const body = (await res.json()) as (TokenResponse & OidcError);

    if (body.error) {
      switch (body.error) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          effectiveIntervalMs += 5_000;
          continue;
        case 'expired_token':
          throw new OidcFlowError('expired_token', res.status,
            'Device code expired -- user did not complete login in time');
        case 'access_denied':
          throw new OidcFlowError('access_denied', res.status,
            'User denied the authorization request');
        default:
          throw new OidcFlowError(body.error, res.status,
            body.error_description ?? body.error);
      }
    }

    if (res.ok) return body as TokenResponse;
    throw new OidcFlowError('token_poll', res.status, 'Unexpected non-ok response');
  }

  throw new OidcFlowError('deadline_exceeded', 0,
    'Device code deadline exceeded -- user did not complete login in time');
}
```

### 1.5 refreshAccessToken

```typescript
/**
 * Refresh an expired access token using the stored refresh token.
 *
 * Error handling:
 *   400 invalid_grant      -> refresh token revoked/expired (terminal)
 *   401                    -> client auth failed (terminal)
 *   5xx                    -> transient, caller should retry
 */
export async function refreshAccessToken(
  config: OidcConfig,
  storedRefreshToken: string,
): Promise<TokenResponse> {
  const { token } = endpoints(config.issuer);
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: storedRefreshToken,
    client_id: config.clientId,
  };
  if (config.clientSecret) {
    params.client_secret = config.clientSecret;
  }

  const res = await postForm(token, params);
  if (!res.ok) {
    const body = await res.text();
    throw new OidcFlowError('token_refresh', res.status, body);
  }
  return res.json() as Promise<TokenResponse>;
}
```

### 1.6 Error Type

```typescript
export class OidcFlowError extends Error {
  constructor(
    public readonly phase: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(`OIDC ${phase} failed (${httpStatus}): ${message}`);
    this.name = 'OidcFlowError';
  }
}
```

### 1.7 No Service Tokens

The reference Kraken's `getServiceToken()` (client_credentials grant) is
deliberately NOT ported. Per D6, the Kraken has no identity of its own for
cluster work. The only non-user token is the Slack bot token, which is used
for Slack API calls only.

### 1.8 postForm Helper

```typescript
async function postForm(
  url: string,
  params: Record<string, string>,
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

---

## 2. Token Encryption

**File:** `src/auth/crypto.ts`

AES-256-GCM column-level encryption for access_token and refresh_token
at rest in SQLite. Key sourced from K8s Secret via
`KRAKEN_TOKEN_ENCRYPTION_KEY` env var.

### 2.1 Key Parsing

```typescript
/**
 * Parse a 32-byte encryption key from hex or base64 encoding.
 * Throws if the decoded key is not exactly 32 bytes.
 */
export function parseEncryptionKey(raw: string): Buffer {
  // Try hex first (64 hex chars = 32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // Try base64
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `Encryption key must be exactly 32 bytes; got ${buf.length} ` +
      `(input length: ${raw.length} chars). Use 64 hex chars or 44 base64 chars.`
    );
  }
  return buf;
}
```

### 2.2 Encrypt

```typescript
import { createCipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypt plaintext with AES-256-GCM.
 *
 * Returns hex-encoded string: iv:ciphertext:authTag
 *   - iv: 12 random bytes (24 hex chars)
 *   - ciphertext: variable length
 *   - authTag: 16 bytes (32 hex chars)
 *
 * A fresh random IV is generated per call. Never reuse IVs.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${authTag.toString('hex')}`;
}
```

### 2.3 Decrypt

```typescript
import { createDecipheriv } from 'node:crypto';

/**
 * Decrypt a ciphertext produced by encrypt().
 *
 * Throws on:
 *   - Malformed ciphertext (wrong number of colon-separated parts)
 *   - Tampered ciphertext (auth tag verification failure)
 *   - Wrong key
 */
export function decrypt(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed ciphertext: expected iv:ciphertext:authTag');
  }
  const [ivHex, dataHex, tagHex] = parts;
  const iv = Buffer.from(ivHex!, 'hex');
  const data = Buffer.from(dataHex!, 'hex');
  const authTag = Buffer.from(tagHex!, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
```

---

## 3. Token Storage

**File:** `src/auth/tokens.ts`

Class wrapping the `user_tokens` table with encryption at every
read/write boundary.

### 3.1 UserTokenStore API

```typescript
export class UserTokenStore {
  constructor(
    private readonly db: Database.Database,
    private readonly encryptionKey: Buffer,
  ) {}

  /**
   * Store a token set for a Slack user. Encrypts access_token and
   * refresh_token before writing.
   *
   * Uses INSERT OR REPLACE — if the user already has a row, it is
   * overwritten. This is correct because each user has exactly one
   * active session.
   */
  storeUserToken(
    slackUserId: string,
    tokens: TokenResponse,
    keycloakSub: string,
    email: string,
  ): void;

  /**
   * Return a valid (non-expired) access token for a Slack user, or null.
   *
   * Checks:
   *   1. Row exists
   *   2. created_at within 12-hour session window
   *   3. expires_at not past (with 30s buffer)
   *
   * If check 2 fails -> delete row, return null (session expired).
   * If check 3 fails -> return null (caller should attempt refresh).
   *
   * Decrypts access_token before returning.
   */
  getValidTokenForUser(slackUserId: string): string | null;

  /**
   * Return all rows where the access token is expiring within the
   * given threshold AND the session window has not elapsed.
   *
   * Used by the refresh loop. Returns decrypted refresh_tokens.
   */
  getRefreshableTokens(thresholdMs: number): Array<{
    slackUserId: string;
    refreshToken: string;
    expiresAt: number;
    createdAt: number;
  }>;

  /**
   * Delete a user's token row entirely.
   * Called on session window expiry or explicit logout.
   */
  deleteUserToken(slackUserId: string): void;

  /**
   * Mark a token as expired by setting expires_at to now.
   * Called when refresh fails — the row stays for audit but
   * getValidTokenForUser will return null.
   */
  markTokenExpired(slackUserId: string): void;
}
```

### 3.2 Storage Format

All times stored as ISO 8601 strings in SQLite TEXT columns (same
convention as Phase 0 schema). The `expires_at` is computed as:
`new Date(Date.now() + tokens.expires_in * 1000).toISOString()`.

The `access_token` and `refresh_token` columns contain the
`iv:ciphertext:authTag` hex string from `encrypt()`, not plaintext.

### 3.3 Session Window Check

The 12-hour session window is enforced in `getValidTokenForUser`:

```typescript
const createdAt = new Date(row.created_at).getTime();
if (Date.now() - createdAt > SESSION_WINDOW_MS) {
  this.deleteUserToken(slackUserId);
  return null;
}
```

The window is measured from `created_at` (when the token was first
issued via device flow), NOT from `updated_at` (which would reset on
every refresh). This means a user re-authenticates at most once per
12-hour shift, regardless of how many token refreshes happen.

**Design choice vs reference:** The old Kraken used `updated_at` for
the session window, which meant aggressive refresh effectively extended
the session indefinitely. Using `created_at` gives a hard 12-hour cap.
This is intentional — it limits blast radius if a token is compromised.

---

## 4. Token Refresh Background Loop

**File:** `src/auth/refresh.ts`

### 4.1 Constants

```typescript
const REFRESH_THRESHOLD_RATIO = 0.75; // Refresh at 75% of token lifetime
const REFRESH_LOOP_INTERVAL_MS = 60_000; // Check every 60 seconds
const SESSION_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours
```

### 4.2 Timer Setup

```typescript
let refreshTimer: NodeJS.Timeout | null = null;
const refreshingUsers = new Set<string>(); // concurrent-refresh guard

export function startTokenRefreshLoop(
  store: UserTokenStore,
  config: OidcConfig,
): void {
  if (refreshTimer) return; // idempotent

  // Immediate sweep on startup (catch tokens that expired while pod was down)
  runRefreshSweep(store, config).catch(err =>
    log.error({ err }, 'initial refresh sweep failed'));

  refreshTimer = setInterval(() => {
    runRefreshSweep(store, config).catch(err =>
      log.error({ err }, 'refresh sweep failed'));
  }, REFRESH_LOOP_INTERVAL_MS);
  refreshTimer.unref(); // allow clean process exit
}

export function stopTokenRefreshLoop(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  refreshingUsers.clear();
}
```

### 4.3 Refresh Sweep

```typescript
async function runRefreshSweep(
  store: UserTokenStore,
  config: OidcConfig,
): Promise<void> {
  // Get tokens that will expire within their 75% threshold.
  // The store handles session window filtering internally.
  //
  // For a 1-hour Keycloak access token:
  //   75% threshold = 45 minutes
  //   We ask for tokens expiring in the next 15 minutes
  //   (100% - 75% = 25% of lifetime, which we don't know exactly,
  //    so we use a generous 15-minute lookahead)
  const candidates = store.getRefreshableTokens(15 * 60 * 1000);
  let refreshed = 0;
  let failed = 0;

  for (const { slackUserId, refreshToken } of candidates) {
    // Concurrent-refresh guard: skip if another sweep is already
    // refreshing this user's token
    if (refreshingUsers.has(slackUserId)) continue;
    refreshingUsers.add(slackUserId);

    try {
      const tokens = await refreshAccessToken(config, refreshToken);
      // Re-store with same created_at (session window doesn't reset)
      store.storeUserToken(
        slackUserId,
        tokens,
        extractSubFromToken(tokens.access_token),
        extractEmailFromToken(tokens.access_token),
      );
      refreshed++;
    } catch (err) {
      log.warn({ slackUserId, err }, 'token refresh failed, marking expired');
      store.markTokenExpired(slackUserId);
      failed++;
    } finally {
      refreshingUsers.delete(slackUserId);
    }
  }

  if (refreshed > 0 || failed > 0) {
    log.info({ refreshed, failed, candidates: candidates.length },
      'token refresh sweep complete');
  }
}
```

### 4.4 JWT Claim Extraction

```typescript
export function extractEmailFromToken(token: string): string {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1]!, 'base64url').toString(),
    );
    return (payload.email as string) ?? '';
  } catch {
    return '';
  }
}

export function extractSubFromToken(token: string): string {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1]!, 'base64url').toString(),
    );
    return (payload.sub as string) ?? '';
  } catch {
    return '';
  }
}
```

---

## 5. POSIX Mode Authorization Engine

**File:** `src/enclave/authz.ts`

Ported from `thekraken-reference/src/authz.ts` with these changes:
- Receives enclave info via MCP call (same as reference)
- Cache is a simple `Map<string, { info: EnclaveInfo; fetchedAt: number }>`
  with 60-second TTL (same as reference)
- Denial messages use first-person friendly language (same as reference)

### 5.1 Types

```typescript
export type Role = 'owner' | 'member' | 'visitor';
export type Operation = 'read' | 'write' | 'execute';

export interface EnclaveInfo {
  owner: string;        // email
  members: string[];    // emails
  mode: string;         // 9-char rwx string, e.g. "rwxrwxr-x"
  status: string;       // "active" | "frozen"
  name: string;
}

export interface AuthzDecision {
  allowed: boolean;
  role: Role;
  reason?: string;      // human-friendly denial (no jargon)
}
```

### 5.2 Role Resolution

```typescript
export function resolveRole(userEmail: string, info: EnclaveInfo): Role {
  const normalized = userEmail.toLowerCase();
  if (normalized === info.owner.toLowerCase()) return 'owner';
  if (info.members.some(m => m.toLowerCase() === normalized)) return 'member';
  return 'visitor';
}
```

### 5.3 Mode Bit Check

```typescript
/**
 * Parse mode string and check if an operation is allowed for a role.
 * Mode string: 9 chars, "rwxrwxr-x"
 *   chars 0-2: owner bits
 *   chars 3-5: member/group bits
 *   chars 6-8: visitor/other bits
 *
 * Owner ALWAYS bypasses mode checks (returns true regardless of bits).
 */
export function checkModeBit(
  mode: string,
  role: Role,
  operation: Operation,
): boolean {
  if (role === 'owner') return true;
  const offset = role === 'member' ? 3 : 6;
  const bitIdx = operation === 'read' ? 0 : operation === 'write' ? 1 : 2;
  const char = mode[offset + bitIdx];
  return char !== '-' && char !== undefined;
}
```

### 5.4 Cache Implementation

```typescript
const CACHE_TTL_MS = 60_000; // 60 seconds

const cache = new Map<string, { info: EnclaveInfo; fetchedAt: number }>();

export function invalidateCache(enclaveName: string): void {
  cache.delete(enclaveName);
}

function getCached(enclaveName: string): EnclaveInfo | undefined {
  const entry = cache.get(enclaveName);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(enclaveName);
    return undefined;
  }
  return entry.info;
}
```

### 5.5 checkAccess

```typescript
/**
 * Check whether a user may perform an operation in an enclave.
 *
 * mcpCall: function that calls a tentacular-mcp tool. The caller
 * provides this — it carries the user's Bearer token per D6.
 *
 * If enclave_info fails (channel not bound), returns allowed=true
 * so non-enclave channels degrade gracefully.
 */
export async function checkAccess(
  userEmail: string,
  enclaveName: string,
  operation: Operation,
  mcpCall: (tool: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<AuthzDecision> {
  const info = await fetchEnclaveInfo(enclaveName, mcpCall);
  if (!info) return { allowed: true, role: 'visitor' };

  const role = resolveRole(userEmail, info);
  if (role === 'owner') return { allowed: true, role };

  // Frozen enclave: only owners can write/execute
  if (info.status === 'frozen' && (operation === 'write' || operation === 'execute')) {
    return { allowed: false, role, reason: DENIAL_FROZEN };
  }

  const allowed = checkModeBit(info.mode, role, operation);
  if (!allowed) {
    return { allowed: false, role, reason: buildDenial(role, operation) };
  }
  return { allowed: true, role };
}
```

### 5.6 Denial Message Templates

```typescript
const DENIAL_FROZEN =
  'This enclave is currently frozen. No new tasks can be started until the owner unfreezes it.';

function buildDenial(role: Role, operation: Operation): string {
  if (role === 'visitor') {
    return "You're visiting this enclave but don't have permission to " +
      `${operation === 'execute' ? 'run tasks' : operation} here. ` +
      'Ask the owner to add you as a member.';
  }
  if (role === 'member') {
    if (operation === 'execute')
      return "Members of this enclave don't have permission to run tasks. " +
        'Ask the owner to change the access level.';
    if (operation === 'write')
      return 'Members of this enclave have read-only access. ' +
        'Ask the owner to change the access level.';
    return "You don't have permission to perform this action. " +
      'Ask the owner to adjust the access level.';
  }
  return "You don't have permission to perform this action in this enclave.";
}
```

---

## 6. Tool Scoping (Pi Extension)

**File:** `src/extensions/tool-scoping.ts`

### 6.1 Ambiguity #1 Resolution: Hook Mechanism

**Finding from pi source code inspection:**

Pi-coding-agent's `AgentSession._installAgentToolHooks()` (at
`pi-mono/packages/coding-agent/src/core/agent-session.ts:363`) bridges the
two APIs:

1. **`pi-agent-core` Agent.beforeToolCall** — a callback on the `Agent`
   class (`AgentLoopConfig.beforeToolCall`). Receives `BeforeToolCallContext`
   (with `toolCall.name`, `args`, `context`). Returns
   `BeforeToolCallResult` with `{ block?: boolean; reason?: string }`.

2. **`pi-coding-agent` extension `tool_call` event** — registered via
   `pi.on("tool_call", handler)` in an extension factory function. Receives
   `ToolCallEvent` (with `toolName`, `toolCallId`, `input`). Returns
   `ToolCallEventResult` with `{ block?: boolean; reason?: string }`.

**The bridge:** `AgentSession._installAgentToolHooks()` sets
`this.agent.beforeToolCall` to a function that calls
`runner.emitToolCall()` which iterates over all extension `tool_call`
handlers. This means:

- **Extensions using `pi.on("tool_call", ...)` DO hook into
  `Agent.beforeToolCall`.** They are not separate mechanisms; the extension
  event IS the hook, wired by `AgentSession`.
- **`event.input` is mutable.** The extension can modify tool arguments
  in place (e.g., inject `namespace`). Per the type doc: "Mutate it in
  place to patch tool arguments before execution. Later `tool_call`
  handlers see earlier mutations."
- **Returning `{ block: true, reason }` prevents execution.** The agent
  loop emits an error tool result with the reason text.

**Decision: Use pi extension `tool_call` event (D8-compliant).**

The team subprocesses run `pi-coding-agent` via `createAgentSession()`.
Extensions are loaded via `session.bindExtensions()`. The tool-scoping
extension is a standard pi extension factory function. This is exactly
what D8 mandates.

The dispatcher does NOT need tool scoping — it does not call MCP tools
directly (it routes to teams). Only team subprocesses need the extension.

### 6.2 Extension Factory

```typescript
import type { ExtensionFactory } from '@mariozechner/pi-coding-agent';

/**
 * Tool scoping extension for enclave-bound team subprocesses.
 *
 * Loaded by team manager/builder/deployer via session.bindExtensions().
 * Reads enclave context from KRAKEN_ENCLAVE_NAME env var (set at spawn).
 *
 * Four tool categories (ported from thekraken-reference/src/mcp-scope.ts):
 */

const MCP_PREFIX = 'mcp__tentacular__';

/** Tools scoped to an enclave namespace. Value = parameter name. */
const ENCLAVE_SCOPED: Record<string, string> = {
  wf_list: 'namespace',
  wf_describe: 'namespace',
  wf_status: 'namespace',
  wf_pods: 'namespace',
  wf_logs: 'namespace',
  wf_events: 'namespace',
  wf_jobs: 'namespace',
  wf_health: 'namespace',
  wf_health_ns: 'namespace',
  wf_apply: 'namespace',
  wf_run: 'namespace',
  wf_restart: 'namespace',
  wf_remove: 'namespace',
  enclave_info: 'name',
  enclave_sync: 'name',
  permissions_get: 'namespace',
  permissions_set: 'namespace',
  ns_permissions_get: 'namespace',
  ns_permissions_set: 'namespace',
};

/** Tools blocked in enclave mode (admin/platform only). */
const BLOCKED_IN_ENCLAVE = new Set([
  'ns_create', 'ns_update', 'ns_delete', 'ns_list',
  'enclave_provision', 'enclave_deprovision', 'enclave_list',
  'cluster_preflight', 'cluster_profile',
  'audit_rbac', 'audit_netpol', 'audit_psa',
  'gvisor_check', 'exo_status', 'exo_registration', 'exo_list',
  'proxy_status',
]);

/** Tools allowed in DM mode (read-only). */
const DM_ALLOWED = new Set([
  'wf_list', 'wf_describe', 'wf_status', 'wf_pods', 'wf_logs',
  'wf_events', 'wf_jobs', 'wf_health', 'wf_health_ns',
  'health_cluster_summary', 'health_nodes', 'health_ns_usage',
  'enclave_info', 'enclave_list',
  'permissions_get', 'ns_permissions_get',
]);

/** Unscoped tools always allowed (cluster-wide read). */
const ALWAYS_ALLOWED = new Set([
  'health_cluster_summary', 'health_nodes', 'health_ns_usage',
]);

const toolScoping: ExtensionFactory = (pi) => {
  pi.on('tool_call', async (event) => {
    // Only scope tentacular MCP tools
    if (!event.toolName.startsWith(MCP_PREFIX)) return undefined;

    const shortName = event.toolName.slice(MCP_PREFIX.length);
    const enclaveName = process.env['KRAKEN_ENCLAVE_NAME'] ?? null;

    // --- DM mode (enclaveName is null) ---
    if (enclaveName === null) {
      if (!DM_ALLOWED.has(shortName)) {
        return {
          block: true,
          reason: `Tool "${shortName}" requires an enclave context. ` +
            'Use this from an enclave Slack channel, not a DM.',
        };
      }
      return undefined; // allowed, no namespace injection in DM
    }

    // --- Enclave mode ---
    if (BLOCKED_IN_ENCLAVE.has(shortName)) {
      return {
        block: true,
        reason: `Tool "${shortName}" is not available in enclave mode. ` +
          getBlockedHint(shortName),
      };
    }

    if (ALWAYS_ALLOWED.has(shortName)) return undefined;

    const paramName = ENCLAVE_SCOPED[shortName];
    if (paramName) {
      const input = event.input as Record<string, unknown>;
      const requested = input[paramName];
      if (requested && requested !== enclaveName) {
        return {
          block: true,
          reason: `You can only operate within enclave "${enclaveName}". ` +
            `Cannot access "${requested}".`,
        };
      }
      // Inject enclave namespace (mutable input per pi contract)
      input[paramName] = enclaveName;
      return undefined;
    }

    // Unknown tentacular tool -> block for safety
    return {
      block: true,
      reason: `Tool "${shortName}" is not recognized. Contact your platform admin.`,
    };
  });
};

export default toolScoping;
```

### 6.3 How It Gets Loaded

In `src/teams/lifecycle.ts`, when spawning a team subprocess, the
pi invocation includes the extension path. Pi-coding-agent loads
extensions from the filesystem via `jiti` dynamic import.

The extension file is at a known path relative to the project root:
`src/extensions/tool-scoping.ts` (compiled to `dist/extensions/tool-scoping.js`).

The subprocess env includes `PI_EXTENSIONS` pointing to the extension:

```typescript
// In spawnTeam(), added to subprocessEnv:
PI_EXTENSIONS: resolve(import.meta.dirname, '..', 'extensions', 'tool-scoping.js'),
```

Alternatively, if pi-coding-agent supports `--extension` CLI flag, pass it
as a spawn argument. The developer should verify which mechanism
pi-coding-agent uses for non-interactive extension loading and choose
accordingly. Both paths result in the extension's `tool_call` handler
being wired into `Agent.beforeToolCall` by `AgentSession`.

### 6.4 Pure Function for Testing

The `evaluateToolCall` logic is also exported as a pure function for
unit testing without pi infrastructure:

```typescript
export interface ScopeDecision {
  allowed: true;
  updatedInput?: Record<string, unknown>;
} | {
  allowed: false;
  reason: string;
};

export function evaluateToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  enclaveName: string | null,
): ScopeDecision;
```

This mirrors the reference's `evaluateToolCall()` exactly.

---

## 7. Auth Gate in Dispatcher

**File:** `src/dispatcher/auth-gate.ts`

### 7.1 Ambiguity #2 Resolution: Operation Classification

**Decision: Simple keyword list. No LLM needed.**

The reference Kraken's `classifyOperation()` uses regex keyword matching
and defaults to `read`. This is correct for three reasons:

1. False positives (classifying read as write) only means an extra
   authz check — the user still succeeds if they have write permission.
2. False negatives (classifying write as read) are caught by the MCP
   server's own authz layer — defense in depth.
3. The LLM alternative adds latency, cost, and non-determinism to
   every message. Not worth it for a classification that is 95%
   correct from keywords.

### 7.2 classifyOperation

```typescript
/**
 * Classify a user message as read, write, or execute.
 *
 * Default: read (least restrictive for ambiguous messages).
 * This is the first check — MCP server enforces its own authz
 * as defense in depth.
 */
export function classifyOperation(text: string): Operation {
  const lower = text.toLowerCase();

  // Execute: running/triggering tentacles
  if (/\b(run|trigger|execute|start|restart|kick off|fire)\b/.test(lower))
    return 'execute';

  // Write: deployment, config, permission changes
  if (/\b(deploy|create|delete|remove|destroy|configure|update|set|change|modify|add|install|uninstall|scale)\b/.test(lower))
    return 'write';

  // Explicit read patterns (for clarity, though default is read)
  if (/\b(list|show|get|describe|status|what|who|how|when|where|check|view|inspect|logs?|history)\b/.test(lower))
    return 'read';

  // Default: read
  return 'read';
}
```

### 7.3 Auth Gate Flow

The auth gate runs in the dispatcher BEFORE writing to the team's
mailbox. Sequence:

```
InboundEvent
  |
  v
routeEvent() -> deterministic: spawn_and_forward / forward_to_active_team
  |
  v
authGate(event, config, tokenStore, authzEngine)
  |
  +-- getValidTokenForUser(event.userId)
  |     |
  |     +-- null? -> postAuthCard(event) -> STOP (no forward)
  |     +-- token? -> continue
  |
  +-- extractEmailFromToken(token)
  |
  +-- classifyOperation(event.text)
  |
  +-- checkAccess(email, enclaveName, operation, mcpCall)
  |     |
  |     +-- denied? -> postDenialMessage(event, decision) -> STOP
  |     +-- allowed? -> continue
  |
  v
sendToTeam(enclaveName, mailboxRecord with real token)
```

### 7.4 Auth Gate Function

```typescript
export interface AuthGateResult {
  passed: true;
  token: string;
  email: string;
  role: Role;
} | {
  passed: false;
  reason: 'unauthenticated' | 'denied';
}

export async function authGate(
  userId: string,
  enclaveName: string,
  messageText: string,
  tokenStore: UserTokenStore,
  config: OidcConfig,
  mcpCall: (tool: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<AuthGateResult> {
  // Step 1: Check for valid token
  const token = tokenStore.getValidTokenForUser(userId);
  if (!token) {
    return { passed: false, reason: 'unauthenticated' };
  }

  // Step 2: Extract identity from JWT
  const email = extractEmailFromToken(token);
  if (!email) {
    return { passed: false, reason: 'unauthenticated' };
  }

  // Step 3: Classify + check authz
  const operation = classifyOperation(messageText);
  const decision = await checkAccess(email, enclaveName, operation, mcpCall);
  if (!decision.allowed) {
    return { passed: false, reason: 'denied' };
  }

  return { passed: true, token, email, role: decision.role };
}
```

---

## 8. Token Propagation to Running Subprocesses

### 8.1 Ambiguity #3 Resolution

**Decision: Option A — mailbox record carries the latest token.**

Rationale:

- **Simplest.** The `userToken` field already exists in `MailboxRecord`.
  Every message the dispatcher sends to a team carries the user's
  current token. No new IPC mechanism needed.
- **No race condition.** The token in `MailboxRecord` is read from
  `UserTokenStore` at dispatch time, which always returns the latest
  refreshed token. If the background refresh loop updated the token
  between two dispatches, the next dispatch carries the new one.
- **Manager reads token from every record.** The manager subprocess
  updates its own `TNTC_ACCESS_TOKEN` env var (and any in-memory MCP
  auth state) from each mailbox record it processes.
- **Multi-user correct.** Different users can interact with the same
  enclave team. Each mailbox record carries that specific user's token.
  The manager uses the token from the record for that user's request.

Option B (special `token_refresh` record type) was rejected because it
adds complexity to the mailbox protocol without benefit — the token is
already in every record.

Option C (manager refreshes its own token) was rejected because it
violates separation of concerns and would require giving the manager
subprocess access to `OIDC_CLIENT_ID` and the refresh token, leaking
auth infrastructure into the team layer.

### 8.2 Manager Token Update

When the manager reads a `MailboxRecord`, it MUST:

```typescript
// In manager's mailbox reader loop:
function processMailboxRecord(record: MailboxRecord): void {
  // Update the env for subsequent tntc CLI calls
  if (record.userToken) {
    process.env['TNTC_ACCESS_TOKEN'] = record.userToken;
  }
  // ... proceed with request using record.userToken for MCP calls
}
```

### 8.3 Stale Token Handling

If a user's token expires and the background refresh loop fails, the
token store returns `null` from `getValidTokenForUser()`. The auth gate
blocks the dispatch and posts an auth card. No stale token reaches the
mailbox.

If a token expires AFTER it was written to the mailbox but BEFORE the
manager processes it (unlikely but possible), the MCP server will reject
the call with 401. The manager should:

1. Write an error to `outbound.ndjson` for that thread
2. NOT retry with a different token (D6 — only the user's token)
3. The dispatcher sees the 401 in outbound, posts an auth card

This is the "fail + re-auth, never fallback" pattern from D6.

---

## 9. Ephemeral Auth Card

**File:** `src/slack/auth-card.ts`

### 9.1 Posting

```typescript
import type { WebClient } from '@slack/web-api';

export interface AuthCardParams {
  channel: string;
  userId: string;
  verificationUri: string;
  userCode: string;
  expiresIn: number; // seconds
}

/**
 * Post an ephemeral auth card to a Slack channel.
 *
 * Ephemeral = visible only to the target user. Other channel members
 * do not see the auth prompt.
 *
 * Uses chat.postEphemeral (not chat.postMessage).
 */
export async function postAuthCard(
  client: WebClient,
  params: AuthCardParams,
): Promise<void> {
  await client.chat.postEphemeral({
    channel: params.channel,
    user: params.userId,
    text: `Please authenticate: visit ${params.verificationUri} and enter code ${params.userCode}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':lock: *Authentication Required*\n\n' +
            'I need to verify your identity before I can help. ' +
            'This only takes a moment.',
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Step 1:* Visit <${params.verificationUri}|this link>`,
          },
          {
            type: 'mrkdwn',
            text: `*Step 2:* Enter code \`${params.userCode}\``,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `This code expires in ${Math.floor(params.expiresIn / 60)} minutes.`,
          },
        ],
      },
    ],
  });
}
```

### 9.2 Success Confirmation

After `pollForToken()` succeeds:

```typescript
export async function postAuthSuccess(
  client: WebClient,
  channel: string,
  userId: string,
): Promise<void> {
  await client.chat.postEphemeral({
    channel,
    user: userId,
    text: 'You are now authenticated. Your session will last 12 hours.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':white_check_mark: *Authenticated*\n\n' +
            "You're all set. Your session lasts 12 hours. " +
            "Go ahead and ask me anything.",
        },
      },
    ],
  });
}
```

### 9.3 Timeout Message

If `pollForToken()` throws `expired_token` or `deadline_exceeded`:

```typescript
export async function postAuthTimeout(
  client: WebClient,
  channel: string,
  userId: string,
): Promise<void> {
  await client.chat.postEphemeral({
    channel,
    user: userId,
    text: 'Authentication timed out. Please try again by sending me a message.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':hourglass: *Authentication Timed Out*\n\n' +
            "The login code expired before you completed it. " +
            "Just send me another message and I'll start a new one.",
        },
      },
    ],
  });
}
```

---

## 10. Schema Changes

**File:** `src/db/schema.ts`

### 10.1 Add created_at to user_tokens

The existing schema has no `created_at` on `user_tokens`. Add it for
the 12-hour session window (Section 3.3).

```sql
-- In SCHEMA_V1, replace the user_tokens CREATE TABLE with:
CREATE TABLE IF NOT EXISTS user_tokens (
  slack_user_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  keycloak_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

This is safe because:
- Phase 2 is on a fresh schema (v2.0 — no migration history needed)
- The Phase 0 design doc explicitly states "Applied once on fresh install.
  No migration history needed for v2.0."
- Adding a column with a DEFAULT does not break existing INSERT
  statements that omit it

If backwards compatibility with an already-deployed Phase 1 database
is needed (unlikely — v2 is pre-release), use:

```sql
ALTER TABLE user_tokens ADD COLUMN created_at TEXT
  NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
```

---

## 11. Helm Chart Changes

### 11.1 values.yaml Additions

```yaml
# Token encryption — REQUIRED for Phase 2
tokenEncryption:
  # K8s Secret containing the 32-byte encryption key
  secretName: ""        # REQUIRED
  # Key within the Secret that holds the value
  key: "encryption-key"
```

### 11.2 secret.yaml Changes

Make `OIDC_CLIENT_SECRET` conditional (F5):

```yaml
  {{- if .Values.secrets.oidcClientSecret }}
  OIDC_CLIENT_SECRET: {{ .Values.secrets.oidcClientSecret | quote }}
  {{- end }}
```

### 11.3 deployment.yaml Changes

Add the encryption key volume mount:

```yaml
# Under containers[0].env (after envFrom):
{{- if .Values.tokenEncryption.secretName }}
env:
  - name: KRAKEN_TOKEN_ENCRYPTION_KEY
    valueFrom:
      secretKeyRef:
        name: {{ .Values.tokenEncryption.secretName }}
        key: {{ .Values.tokenEncryption.key | default "encryption-key" }}
{{- end }}
```

### 11.4 Generating the Key

Operator generates a 32-byte random key and stores it in a K8s Secret:

```bash
# Generate key
KEY=$(openssl rand -hex 32)

# Create K8s Secret
kubectl create secret generic kraken-token-encryption \
  --from-literal=encryption-key=$KEY \
  -n thekraken

# Reference in Helm values
helm upgrade thekraken charts/thekraken \
  --set tokenEncryption.secretName=kraken-token-encryption
```

### 11.5 Required Validation

Add to deployment.yaml:

```yaml
{{- $_ := required "tokenEncryption.secretName is required (Phase 2)" .Values.tokenEncryption.secretName -}}
```

---

## 12. Config Changes

### 12.1 OidcConfig Update

```typescript
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;  // Changed from required to optional (F5)
}
```

### 12.2 New Config Field

```typescript
export interface KrakenConfig {
  // ... existing fields ...
  /** 32-byte encryption key for token-at-rest (hex or base64). Required. */
  tokenEncryptionKey: Buffer;
}
```

### 12.3 loadConfig Changes

```typescript
// OIDC — clientSecret now optional
const oidcClientSecret = process.env['OIDC_CLIENT_SECRET'] ?? undefined;

// Token encryption key — required
const encryptionKeyRaw = required('KRAKEN_TOKEN_ENCRYPTION_KEY');
let tokenEncryptionKey: Buffer = Buffer.alloc(0);
if (encryptionKeyRaw) {
  try {
    tokenEncryptionKey = parseEncryptionKey(encryptionKeyRaw);
  } catch (err) {
    errors.push(`KRAKEN_TOKEN_ENCRYPTION_KEY: ${(err as Error).message}`);
  }
}
```

---

## 13. Decisions Log

| # | Decision | Rationale |
|---|----------|-----------|
| A1 | `tool_call` pi extension event, not raw `Agent.beforeToolCall` | D8 compliance; `AgentSession` bridges them automatically |
| A2 | Keyword regex for operation classification, not LLM | Deterministic, fast, 95% accurate, defense-in-depth with MCP server |
| A3 | Mailbox record carries latest token (Option A) | Simplest, no new IPC, already have the field, multi-user correct |
| A4 | `created_at` for session window, not `updated_at` | Hard 12-hour cap, limits blast radius, intentional change from reference |
| A5 | No `getServiceToken()` port | D6: Kraken has no identity for cluster work |
| A6 | `client_secret` included only when configured | Public client by default, backwards compat with confidential clients |
| A7 | Extension reads `KRAKEN_ENCLAVE_NAME` from env | Set at spawn time, immutable per team, no file I/O needed |
| A8 | Encryption key from K8s Secret via env var | Standard K8s pattern, no key file on disk, rotation deferred to Phase 5 |
| A9 | `evaluateToolCall` exported as pure function | Unit testable without pi infrastructure |
| A10 | Refresh loop runs every 60s, not 5 min (reference) | More responsive; with 1-hour Keycloak tokens, 5-min intervals risk missing the window |
| A11 | Manager updates env from every mailbox record | Handles multi-user enclaves; each request uses the requesting user's token |
| A12 | Auth gate in dispatcher, before mailbox write | Fail fast; never send unauthenticated/unauthorized requests to teams |

---

## 14. Data Flow Diagram

```
Slack Event
  |
  v
[Dispatcher: routeEvent()]
  |
  +-- deterministic: spawn_and_forward / forward_to_active_team
  |
  v
[Dispatcher: authGate()]
  |
  +-- tokenStore.getValidTokenForUser(userId)
  |     |
  |     +-- null -> initiateDeviceAuth() -> postAuthCard() -> STOP
  |     |           pollForToken() (background)
  |     |           on success: tokenStore.storeUserToken()
  |     |                       postAuthSuccess()
  |     |           on timeout: postAuthTimeout()
  |     |
  |     +-- token (decrypted)
  |
  +-- classifyOperation(text) -> read|write|execute
  |
  +-- checkAccess(email, enclave, op, mcpCall) -> allowed|denied
  |     |
  |     +-- denied -> postDenialMessage() -> STOP
  |
  v
[Dispatcher: sendToTeam()]
  MailboxRecord { ..., userToken: <real token> }
  |
  v
[Manager subprocess reads mailbox.ndjson]
  process.env.TNTC_ACCESS_TOKEN = record.userToken
  |
  +-- MCP tool calls with Bearer: record.userToken
  +-- tntc CLI with TNTC_ACCESS_TOKEN env var
  |
  +-- [tool-scoping extension hooks tool_call]
        |
        +-- Inject namespace, block cross-enclave, block admin tools
```

---

## 15. Security Considerations for Review

1. **Token at rest:** AES-256-GCM with per-row random IV. Key in K8s
   Secret. No key rotation in Phase 2 (deferred to Phase 5).

2. **Mailbox file permissions:** `0o600` (already implemented in Phase 1).
   Contains cleartext tokens in transit. Acceptable because the pod's
   filesystem is not shared and pods run as non-root.

3. **Subprocess env:** Only `TNTC_ACCESS_TOKEN` carries auth. No
   `OIDC_CLIENT_SECRET`, no `SLACK_BOT_TOKEN` leakage. Builder
   subprocess has bash access — the allow-listed env is the security
   boundary.

4. **JWT validation:** Phase 2 does NOT validate JWT signatures. The
   Kraken trusts Keycloak's device flow and the MCP server's JWT
   validation. Adding local JWT validation (with JWKS fetch) is a
   Phase 5 hardening item.

5. **Session window:** 12-hour hard cap from `created_at`. Even if
   refresh keeps succeeding, the user must re-authenticate after 12
   hours. This limits the window of exposure for a compromised token.
