/**
 * T14: Integration test — full authentication flow.
 *
 * Tests the complete auth flow from unauthenticated user through device flow
 * to authenticated dispatch. Mocks Keycloak HTTP and Slack WebClient.
 *
 * Scenarios:
 *   1. Unauthenticated -> auth card posted -> auth NOT forwarded
 *   2. Valid token -> auth gate passes -> forwarded
 *   3. Expired token -> re-auth card -> NOT forwarded
 *   4. Denied by authz -> denial message -> NOT forwarded
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../../src/db/migrations.js';
import { UserTokenStore } from '../../src/auth/tokens.js';
import { authGate } from '../../src/dispatcher/auth-gate.js';
import { initiateDeviceAuth, pollForToken } from '../../src/auth/oidc.js';
import { invalidateCache } from '../../src/enclave/authz.js';
import type { EnclaveInfo } from '../../src/enclave/authz.js';
import type { OidcConfig } from '../../src/config.js';
import type { TokenResponse } from '../../src/auth/oidc.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_KEY = Buffer.alloc(32, 0xff);
const TEST_OIDC: OidcConfig = {
  issuer: 'https://kc.example.com/realms/test',
  clientId: 'thekraken',
};

function makeJwtWithEmail(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email, sub: 'sub-1' })).toString(
    'base64url',
  );
  return `header.${payload}.sig`;
}

function makeToken(email: string, expiresIn = 3600): TokenResponse {
  return {
    access_token: makeJwtWithEmail(email),
    refresh_token: 'rt-' + email,
    expires_in: expiresIn,
    token_type: 'Bearer',
  };
}

function makeEnclaveInfo(overrides: Partial<EnclaveInfo> = {}): EnclaveInfo {
  return {
    owner: 'alice@example.com',
    members: ['bob@example.com'],
    mode: 'rwxrwxr-x',
    status: 'active',
    name: 'test-enclave',
    ...overrides,
  };
}

function makeMcpCall(info: EnclaveInfo) {
  return async (_tool: string, _params: Record<string, unknown>) => info;
}

let db: Database.Database;
let store: UserTokenStore;

beforeEach(() => {
  vi.useFakeTimers();
  db = createDatabase(':memory:');
  store = new UserTokenStore(db, TEST_KEY);
  invalidateCache('test-enclave');
  invalidateCache('restricted-enclave');
});

afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  invalidateCache('test-enclave');
  invalidateCache('restricted-enclave');
});

// ---------------------------------------------------------------------------
// Scenario 1: Unauthenticated user -> auth gate fails
// ---------------------------------------------------------------------------

describe('T14: Unauthenticated user', () => {
  it('auth gate returns unauthenticated when no token stored', async () => {
    const result = await authGate(
      'U_ALICE',
      'test-enclave',
      'deploy the processor',
      store,
      TEST_OIDC,
      makeMcpCall(makeEnclaveInfo()),
    );
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.reason).toBe('unauthenticated');
  });

  it('device flow initiates correctly', async () => {
    const deviceAuthResp = {
      device_code: 'dev-code-1',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://kc.example.com/activate',
      expires_in: 600,
      interval: 5,
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => deviceAuthResp,
        text: async () => '',
      }),
    );

    const resp = await initiateDeviceAuth(TEST_OIDC);
    expect(resp.device_code).toBe('dev-code-1');
    expect(resp.user_code).toBe('ABCD-EFGH');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Authenticated user -> auth gate passes -> forwarded
// ---------------------------------------------------------------------------

describe('T14: Authenticated user', () => {
  it('auth gate passes with valid token and returns token + email', async () => {
    const tokens = makeToken('alice@example.com');
    store.storeUserToken('U_ALICE', tokens, 'sub-1', 'alice@example.com');

    const result = await authGate(
      'U_ALICE',
      'test-enclave',
      'list all workflows',
      store,
      TEST_OIDC,
      makeMcpCall(makeEnclaveInfo()),
    );
    expect(result.passed).toBe(true);
    if (result.passed) {
      expect(result.token).toBe(tokens.access_token);
      expect(result.email).toBe('alice@example.com');
      expect(result.role).toBe('owner');
    }
  });

  it('valid member token passes for read operation', async () => {
    const tokens = makeToken('bob@example.com');
    store.storeUserToken('U_BOB', tokens, 'sub-2', 'bob@example.com');

    const result = await authGate(
      'U_BOB',
      'test-enclave',
      'show me the workflow status',
      store,
      TEST_OIDC,
      makeMcpCall(makeEnclaveInfo()),
    );
    expect(result.passed).toBe(true);
    if (result.passed) expect(result.role).toBe('member');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Token completion via device flow -> stored -> gate passes
// ---------------------------------------------------------------------------

describe('T14: Device flow completion -> token stored -> gate passes', () => {
  it('stores token after successful device flow and passes auth gate', async () => {
    const tokenResp = makeToken('charlie@example.com');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => tokenResp,
        text: async () => '',
      }),
    );

    // Simulate device flow completing
    const pollPromise = pollForToken(TEST_OIDC, 'dev-code', 5, 60);
    await vi.advanceTimersByTimeAsync(5_100);
    const tokens = await pollPromise;

    // Store the tokens (as the auth flow handler would do)
    store.storeUserToken('U_CHARLIE', tokens, 'sub-3', 'charlie@example.com');

    // Now the auth gate should pass
    const result = await authGate(
      'U_CHARLIE',
      'test-enclave',
      'list workflows',
      store,
      TEST_OIDC,
      makeMcpCall(makeEnclaveInfo({ members: ['charlie@example.com'] })),
    );
    expect(result.passed).toBe(true);
    if (result.passed) expect(result.role).toBe('member');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Denied by authz
// ---------------------------------------------------------------------------

describe('T14: Denied by authz', () => {
  it('auth gate returns denied when member tries write on restricted enclave', async () => {
    const tokens = makeToken('bob@example.com');
    store.storeUserToken('U_BOB', tokens, 'sub-2', 'bob@example.com');

    // Member has no write permission
    const result = await authGate(
      'U_BOB',
      'restricted-enclave',
      'deploy the processor',
      store,
      TEST_OIDC,
      makeMcpCall(makeEnclaveInfo({ mode: 'rwxr--r--' })),
    );
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.reason).toBe('denied');
  });

  it('expired token requires re-auth (not denied)', async () => {
    const tokens = makeToken('alice@example.com');
    store.storeUserToken('U_ALICE', tokens, 'sub-1', 'alice@example.com');
    store.markTokenExpired('U_ALICE');

    const result = await authGate(
      'U_ALICE',
      'test-enclave',
      'list workflows',
      store,
      TEST_OIDC,
      makeMcpCall(makeEnclaveInfo()),
    );
    // Expired token = unauthenticated (trigger re-auth), NOT denied
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.reason).toBe('unauthenticated');
  });
});
