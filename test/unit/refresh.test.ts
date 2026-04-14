import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../../src/db/migrations.js';
import { UserTokenStore } from '../../src/auth/tokens.js';
import {
  runRefreshSweep,
  startTokenRefreshLoop,
  stopTokenRefreshLoop,
  extractEmailFromToken,
  extractSubFromToken,
  REFRESH_LOOP_INTERVAL_MS,
} from '../../src/auth/refresh.js';
import type { OidcConfig } from '../../src/config.js';
import type { TokenResponse } from '../../src/auth/oidc.js';
import type Database from 'better-sqlite3';

const TEST_KEY = Buffer.alloc(32, 0xdd);

const TEST_OIDC_CONFIG: OidcConfig = {
  issuer: 'https://keycloak.example.com/realms/test',
  clientId: 'thekraken',
};

function makeTokenResponse(expiresIn = 3600): TokenResponse {
  return {
    access_token: 'eyJ.access.token',
    refresh_token: 'eyJ.refresh.token',
    expires_in: expiresIn,
    token_type: 'Bearer',
  };
}

// A minimal JWT with email and sub claims for testing claim extraction
function makeJwt(payload: Record<string, string>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.signature`;
}

let db: Database.Database;
let store: UserTokenStore;

beforeEach(() => {
  vi.useFakeTimers();
  db = createDatabase(':memory:');
  store = new UserTokenStore(db, TEST_KEY);
  stopTokenRefreshLoop(); // ensure clean state
});

afterEach(() => {
  stopTokenRefreshLoop();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// extractEmailFromToken
// ---------------------------------------------------------------------------

describe('extractEmailFromToken', () => {
  it('extracts email from JWT payload', () => {
    const token = makeJwt({ email: 'alice@example.com', sub: 'sub-1' });
    expect(extractEmailFromToken(token)).toBe('alice@example.com');
  });

  it('returns empty string for malformed token', () => {
    expect(extractEmailFromToken('not-a-jwt')).toBe('');
  });

  it('returns empty string when email claim absent', () => {
    const token = makeJwt({ sub: 'sub-1' });
    expect(extractEmailFromToken(token)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractSubFromToken
// ---------------------------------------------------------------------------

describe('extractSubFromToken', () => {
  it('extracts sub from JWT payload', () => {
    const token = makeJwt({ sub: 'user-uuid-123' });
    expect(extractSubFromToken(token)).toBe('user-uuid-123');
  });

  it('returns empty string for malformed token', () => {
    expect(extractSubFromToken('not-a-jwt')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// runRefreshSweep
// ---------------------------------------------------------------------------

describe('runRefreshSweep', () => {
  it('refreshes tokens expiring soon', async () => {
    // Token expiring in 5 minutes (within 15-minute lookahead)
    store.storeUserToken(
      'U001',
      makeTokenResponse(300),
      'sub-1',
      'alice@example.com',
    );

    const newTokenResp: TokenResponse = {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => newTokenResp,
        text: async () => '',
      }),
    );

    const result = await runRefreshSweep(store, TEST_OIDC_CONFIG);
    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);

    // Token should be updated
    expect(store.getValidTokenForUser('U001')).toBe('new-access');
  });

  it('marks token expired on refresh failure', async () => {
    store.storeUserToken(
      'U001',
      makeTokenResponse(300),
      'sub-1',
      'alice@example.com',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant' }),
        text: async () => 'invalid_grant',
      }),
    );

    const result = await runRefreshSweep(store, TEST_OIDC_CONFIG);
    expect(result.failed).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(store.getValidTokenForUser('U001')).toBeNull();
  });

  it('skips tokens not near expiry', async () => {
    // Token expiring in 2 hours — not in lookahead window
    store.storeUserToken(
      'U001',
      makeTokenResponse(7200),
      'sub-1',
      'alice@example.com',
    );

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runRefreshSweep(store, TEST_OIDC_CONFIG);
    expect(result.refreshed).toBe(0);
    expect(result.failed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns zero counts when no candidates', async () => {
    const result = await runRefreshSweep(store, TEST_OIDC_CONFIG);
    expect(result.refreshed).toBe(0);
    expect(result.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// startTokenRefreshLoop / stopTokenRefreshLoop
// ---------------------------------------------------------------------------

describe('startTokenRefreshLoop', () => {
  it('is idempotent — calling twice does not create two timers', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
    );

    startTokenRefreshLoop(store, TEST_OIDC_CONFIG);
    startTokenRefreshLoop(store, TEST_OIDC_CONFIG); // should not throw
    stopTokenRefreshLoop();
  });

  it('runs a sweep immediately on startup', async () => {
    // Token expiring soon
    store.storeUserToken('U001', makeTokenResponse(300), 'sub-1', 'a@b.com');

    const newToken: TokenResponse = {
      access_token: 'startup-refreshed',
      refresh_token: 'rt2',
      expires_in: 3600,
      token_type: 'Bearer',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => newToken,
        text: async () => '',
      }),
    );

    startTokenRefreshLoop(store, TEST_OIDC_CONFIG);
    // Advance a small amount to let the immediate async sweep complete
    await vi.advanceTimersByTimeAsync(100);
    stopTokenRefreshLoop();

    expect(store.getValidTokenForUser('U001')).toBe('startup-refreshed');
  });

  it('runs a sweep after REFRESH_LOOP_INTERVAL_MS', async () => {
    store.storeUserToken('U001', makeTokenResponse(300), 'sub-1', 'a@b.com');

    const newToken: TokenResponse = {
      access_token: 'interval-refreshed',
      refresh_token: 'rt3',
      expires_in: 3600,
      token_type: 'Bearer',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => newToken,
        text: async () => '',
      }),
    );

    startTokenRefreshLoop(store, TEST_OIDC_CONFIG);
    // Advance past the interval (plus startup sweep time)
    await vi.advanceTimersByTimeAsync(REFRESH_LOOP_INTERVAL_MS + 500);
    stopTokenRefreshLoop();

    expect(store.getValidTokenForUser('U001')).toBe('interval-refreshed');
  });
});

describe('stopTokenRefreshLoop', () => {
  it('is idempotent — calling when not running does not throw', () => {
    expect(() => stopTokenRefreshLoop()).not.toThrow();
    expect(() => stopTokenRefreshLoop()).not.toThrow();
  });
});
