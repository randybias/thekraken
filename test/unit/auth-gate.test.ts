import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/db/migrations.js';
import { UserTokenStore } from '../../src/auth/tokens.js';
import { authGate, classifyOperation } from '../../src/dispatcher/auth-gate.js';
import type { OidcConfig } from '../../src/config.js';
import type { TokenResponse } from '../../src/auth/oidc.js';
import type { EnclaveInfo } from '../../src/enclave/authz.js';
import { invalidateCache } from '../../src/enclave/authz.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_KEY = Buffer.alloc(32, 0xee);

const TEST_OIDC: OidcConfig = {
  issuer: 'https://kc.example.com/realms/test',
  clientId: 'thekraken',
};

// A minimal JWT with email embedded (base64url payload)
function makeJwtWithEmail(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email, sub: 'sub-1' })).toString(
    'base64url',
  );
  return `header.${payload}.sig`;
}

function makeTokenResponse(
  accessToken: string,
  expiresIn = 3600,
): TokenResponse {
  return {
    access_token: accessToken,
    refresh_token: 'rt',
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

function makeMcpCall(
  info: EnclaveInfo | null,
): (tool: string, params: Record<string, unknown>) => Promise<unknown> {
  return async (_tool, _params) => {
    if (info === null) throw new Error('not found');
    return info;
  };
}

let db: Database.Database;
let store: UserTokenStore;

beforeEach(() => {
  db = createDatabase(':memory:');
  store = new UserTokenStore(db, TEST_KEY);
  invalidateCache('test-enclave');
  invalidateCache('frozen-enclave');
});

// ---------------------------------------------------------------------------
// classifyOperation
// ---------------------------------------------------------------------------

describe('classifyOperation', () => {
  it('classifies deploy as write', () => {
    expect(classifyOperation('deploy the sentiment analyzer')).toBe('write');
  });

  it('classifies create as write', () => {
    expect(classifyOperation('create a new tentacle')).toBe('write');
  });

  it('classifies delete as write', () => {
    expect(classifyOperation('delete the workflow')).toBe('write');
  });

  it('classifies run as execute', () => {
    expect(classifyOperation('run the processor')).toBe('execute');
  });

  it('classifies trigger as execute', () => {
    expect(classifyOperation('trigger the pipeline')).toBe('execute');
  });

  it('classifies status as read', () => {
    expect(classifyOperation('show me the status')).toBe('read');
  });

  it('classifies list as read', () => {
    expect(classifyOperation('list all workflows')).toBe('read');
  });

  it('defaults to read for ambiguous text', () => {
    expect(classifyOperation('what is going on here?')).toBe('read');
    expect(classifyOperation('')).toBe('read');
    expect(classifyOperation('hello')).toBe('read');
  });

  it('classifies scale as write', () => {
    expect(classifyOperation('scale the deployment to 3 replicas')).toBe(
      'write',
    );
  });

  it('classifies start as execute', () => {
    expect(classifyOperation('start the job')).toBe('execute');
  });

  it('classifies restart as execute', () => {
    expect(classifyOperation('restart the service')).toBe('execute');
  });
});

// ---------------------------------------------------------------------------
// authGate — unauthenticated
// ---------------------------------------------------------------------------

describe('authGate — unauthenticated', () => {
  it('returns unauthenticated when no token stored', async () => {
    const result = await authGate(
      'U001',
      'test-enclave',
      'deploy something',
      store,
      TEST_OIDC,
      makeMcpCall(makeEnclaveInfo()),
    );
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.reason).toBe('unauthenticated');
    }
  });

  it('returns unauthenticated when token has no email claim', async () => {
    // Store a JWT without email claim
    const tokenWithoutEmail =
      'header.' +
      Buffer.from(JSON.stringify({ sub: 'sub-1' })).toString('base64url') +
      '.sig';
    store.storeUserToken(
      'U001',
      makeTokenResponse(tokenWithoutEmail),
      'sub-1',
      'alice@example.com',
    );

    const result = await authGate(
      'U001',
      'test-enclave',
      'list workflows',
      store,
      TEST_OIDC,
      makeMcpCall(makeEnclaveInfo()),
    );
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.reason).toBe('unauthenticated');
  });
});

// ---------------------------------------------------------------------------
// authGate — authenticated + authorized
// ---------------------------------------------------------------------------

describe('authGate — authenticated and authorized', () => {
  it('passes for owner with valid token', async () => {
    const token = makeJwtWithEmail('alice@example.com');
    store.storeUserToken(
      'U001',
      makeTokenResponse(token),
      'sub-1',
      'alice@example.com',
    );

    const result = await authGate(
      'U001',
      'test-enclave',
      'deploy the analyzer',
      store,
      TEST_OIDC,
      makeMcpCall(makeEnclaveInfo()),
    );
    invalidateCache('test-enclave');
    expect(result.passed).toBe(true);
    if (result.passed) {
      expect(result.token).toBe(token);
      expect(result.email).toBe('alice@example.com');
      expect(result.role).toBe('owner');
    }
  });

  it('passes for member with read permission', async () => {
    const token = makeJwtWithEmail('bob@example.com');
    store.storeUserToken(
      'U002',
      makeTokenResponse(token),
      'sub-2',
      'bob@example.com',
    );

    const result = await authGate(
      'U002',
      'test-enclave',
      'list workflows',
      store,
      TEST_OIDC,
      makeMcpCall(makeEnclaveInfo()),
    );
    invalidateCache('test-enclave');
    expect(result.passed).toBe(true);
    if (result.passed) {
      expect(result.role).toBe('member');
    }
  });
});

// ---------------------------------------------------------------------------
// authGate — denied by authz
// ---------------------------------------------------------------------------

describe('authGate — denied by authz', () => {
  it('returns denied when visitor tries to write in restricted enclave', async () => {
    const token = makeJwtWithEmail('eve@example.com');
    store.storeUserToken(
      'U003',
      makeTokenResponse(token),
      'sub-3',
      'eve@example.com',
    );

    const result = await authGate(
      'U003',
      'test-enclave',
      'delete the workflow',
      store,
      TEST_OIDC,
      makeMcpCall(makeEnclaveInfo({ mode: 'rwxrwx---' })),
    );
    invalidateCache('test-enclave');
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.reason).toBe('denied');
    }
  });

  it('returns denied for frozen enclave write', async () => {
    const token = makeJwtWithEmail('bob@example.com');
    store.storeUserToken(
      'U002',
      makeTokenResponse(token),
      'sub-2',
      'bob@example.com',
    );

    const result = await authGate(
      'U002',
      'frozen-enclave',
      'deploy something',
      store,
      TEST_OIDC,
      makeMcpCall(makeEnclaveInfo({ status: 'frozen', mode: 'rwxrwxrwx' })),
    );
    invalidateCache('frozen-enclave');
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.reason).toBe('denied');
    }
  });
});

// ---------------------------------------------------------------------------
// authGate — expired token
// ---------------------------------------------------------------------------

describe('authGate — expired token', () => {
  it('returns unauthenticated for expired token', async () => {
    const token = makeJwtWithEmail('alice@example.com');
    store.storeUserToken(
      'U001',
      makeTokenResponse(token),
      'sub-1',
      'alice@example.com',
    );
    // Expire the token
    store.markTokenExpired('U001');

    const result = await authGate(
      'U001',
      'test-enclave',
      'list workflows',
      store,
      TEST_OIDC,
      makeMcpCall(makeEnclaveInfo()),
    );
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.reason).toBe('unauthenticated');
  });
});
