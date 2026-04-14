/**
 * T16: Integration test — cross-user token isolation.
 *
 * Verifies:
 *   1. Two users same enclave have separate tokens in the store
 *   2. User A's token is never returned when asking for User B
 *   3. User A's expiry does not affect User B
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/db/migrations.js';
import { UserTokenStore } from '../../src/auth/tokens.js';
import { authGate } from '../../src/dispatcher/auth-gate.js';
import { invalidateCache } from '../../src/enclave/authz.js';
import type { EnclaveInfo } from '../../src/enclave/authz.js';
import type { OidcConfig } from '../../src/config.js';
import type { TokenResponse } from '../../src/auth/oidc.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_KEY = Buffer.alloc(32, 0x11);
const TEST_OIDC: OidcConfig = {
  issuer: 'https://kc.example.com/realms/test',
  clientId: 'thekraken',
};

function makeJwtWithEmail(email: string): string {
  return (
    'header.' +
    Buffer.from(JSON.stringify({ email, sub: email })).toString('base64url') +
    '.sig'
  );
}

function makeToken(email: string): TokenResponse {
  return {
    access_token: makeJwtWithEmail(email),
    refresh_token: 'rt-' + email,
    expires_in: 3600,
    token_type: 'Bearer',
  };
}

function makeEnclaveInfo(overrides: Partial<EnclaveInfo> = {}): EnclaveInfo {
  return {
    owner: 'alice@example.com',
    members: ['bob@example.com'],
    mode: 'rwxrwxrwx',
    status: 'active',
    name: 'shared-enclave',
    ...overrides,
  };
}

function makeMcpCall(info: EnclaveInfo) {
  return async (_tool: string, _params: Record<string, unknown>) => info;
}

let db: Database.Database;
let store: UserTokenStore;

beforeEach(() => {
  db = createDatabase(':memory:');
  store = new UserTokenStore(db, TEST_KEY);
  invalidateCache('shared-enclave');
});

// ---------------------------------------------------------------------------
// T16.1: Separate tokens for two users
// ---------------------------------------------------------------------------

describe('T16: Separate tokens per user', () => {
  it('stores independent tokens for two users in same enclave', () => {
    const aliceTokens = makeToken('alice@example.com');
    const bobTokens = makeToken('bob@example.com');

    store.storeUserToken('U_ALICE', aliceTokens, 'alice', 'alice@example.com');
    store.storeUserToken('U_BOB', bobTokens, 'bob', 'bob@example.com');

    // Each user gets their own token
    expect(store.getValidTokenForUser('U_ALICE')).toBe(
      aliceTokens.access_token,
    );
    expect(store.getValidTokenForUser('U_BOB')).toBe(bobTokens.access_token);
  });

  it('Alice token is never returned for Bob', () => {
    const aliceTokens = makeToken('alice@example.com');
    const bobTokens = makeToken('bob@example.com');

    store.storeUserToken('U_ALICE', aliceTokens, 'alice', 'alice@example.com');
    store.storeUserToken('U_BOB', bobTokens, 'bob', 'bob@example.com');

    const aliceToken = store.getValidTokenForUser('U_ALICE')!;
    const bobToken = store.getValidTokenForUser('U_BOB')!;

    expect(aliceToken).not.toBe(bobToken);
    expect(bobToken).not.toContain('alice@example.com');
    expect(aliceToken).not.toContain('bob@example.com');
  });

  it('two users pass auth gate with separate identities', async () => {
    const aliceTokens = makeToken('alice@example.com');
    const bobTokens = makeToken('bob@example.com');

    store.storeUserToken('U_ALICE', aliceTokens, 'alice', 'alice@example.com');
    store.storeUserToken('U_BOB', bobTokens, 'bob', 'bob@example.com');

    const enclaveInfo = makeEnclaveInfo();

    const aliceResult = await authGate(
      'U_ALICE',
      'shared-enclave',
      'list workflows',
      store,
      TEST_OIDC,
      makeMcpCall(enclaveInfo),
    );
    invalidateCache('shared-enclave');

    const bobResult = await authGate(
      'U_BOB',
      'shared-enclave',
      'list workflows',
      store,
      TEST_OIDC,
      makeMcpCall(enclaveInfo),
    );
    invalidateCache('shared-enclave');

    expect(aliceResult.passed).toBe(true);
    expect(bobResult.passed).toBe(true);

    if (aliceResult.passed && bobResult.passed) {
      expect(aliceResult.email).toBe('alice@example.com');
      expect(bobResult.email).toBe('bob@example.com');
      expect(aliceResult.token).not.toBe(bobResult.token);
    }
  });
});

// ---------------------------------------------------------------------------
// T16.2: User A expiry does not affect User B
// ---------------------------------------------------------------------------

describe('T16: Independent expiry', () => {
  it("expiring User A's token does not affect User B", () => {
    const aliceTokens = makeToken('alice@example.com');
    const bobTokens = makeToken('bob@example.com');

    store.storeUserToken('U_ALICE', aliceTokens, 'alice', 'alice@example.com');
    store.storeUserToken('U_BOB', bobTokens, 'bob', 'bob@example.com');

    // Expire Alice's token
    store.markTokenExpired('U_ALICE');

    expect(store.getValidTokenForUser('U_ALICE')).toBeNull();
    // Bob's token unaffected
    expect(store.getValidTokenForUser('U_BOB')).toBe(bobTokens.access_token);
  });

  it('deleting User A does not affect User B', () => {
    const aliceTokens = makeToken('alice@example.com');
    const bobTokens = makeToken('bob@example.com');

    store.storeUserToken('U_ALICE', aliceTokens, 'alice', 'alice@example.com');
    store.storeUserToken('U_BOB', bobTokens, 'bob', 'bob@example.com');

    store.deleteUserToken('U_ALICE');

    expect(store.getValidTokenForUser('U_ALICE')).toBeNull();
    expect(store.getValidTokenForUser('U_BOB')).toBe(bobTokens.access_token);
  });

  it('auth gate returns unauthenticated for expired user, not for valid user', async () => {
    const aliceTokens = makeToken('alice@example.com');
    const bobTokens = makeToken('bob@example.com');

    store.storeUserToken('U_ALICE', aliceTokens, 'alice', 'alice@example.com');
    store.storeUserToken('U_BOB', bobTokens, 'bob', 'bob@example.com');

    store.markTokenExpired('U_ALICE');

    const enclaveInfo = makeEnclaveInfo();

    const aliceResult = await authGate(
      'U_ALICE',
      'shared-enclave',
      'list workflows',
      store,
      TEST_OIDC,
      makeMcpCall(enclaveInfo),
    );
    invalidateCache('shared-enclave');

    const bobResult = await authGate(
      'U_BOB',
      'shared-enclave',
      'list workflows',
      store,
      TEST_OIDC,
      makeMcpCall(enclaveInfo),
    );
    invalidateCache('shared-enclave');

    expect(aliceResult.passed).toBe(false);
    expect(bobResult.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T16.3: MailboxRecord token isolation
// ---------------------------------------------------------------------------

describe('T16: MailboxRecord token isolation', () => {
  it('each user gets their own token in the mailbox record', () => {
    const aliceTokens = makeToken('alice@example.com');
    const bobTokens = makeToken('bob@example.com');

    store.storeUserToken('U_ALICE', aliceTokens, 'alice', 'alice@example.com');
    store.storeUserToken('U_BOB', bobTokens, 'bob', 'bob@example.com');

    const aliceToken = store.getValidTokenForUser('U_ALICE');
    const bobToken = store.getValidTokenForUser('U_BOB');

    // Simulate what the dispatcher does: read token and put in mailbox record
    const aliceMailboxToken = aliceToken; // what would go in MailboxRecord.userToken
    const bobMailboxToken = bobToken;

    expect(aliceMailboxToken).toBe(aliceTokens.access_token);
    expect(bobMailboxToken).toBe(bobTokens.access_token);
    expect(aliceMailboxToken).not.toBe(bobMailboxToken);
  });
});
