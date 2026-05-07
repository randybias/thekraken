import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  refreshAllExpiring,
  getRefreshLoopStatus,
  _resetRefreshLoopStatusForTesting,
  _resetRefreshSweepInFlightForTesting,
} from '../../../src/auth/oidc.js';
import {
  initTokenStore,
  setUserToken,
  deleteUserToken,
} from '../../../src/auth/tokens.js';

function makeInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_tokens (
      slack_user_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      keycloak_sub TEXT NOT NULL,
      email TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  return db;
}

describe('refresh loop status (rc.11)', () => {
  let origFetch: typeof globalThis.fetch;
  let origIssuer: string | undefined;
  let origClientId: string | undefined;
  let origClientSecret: string | undefined;

  beforeEach(() => {
    const db = makeInMemoryDb();
    initTokenStore(db);
    _resetRefreshLoopStatusForTesting();
    _resetRefreshSweepInFlightForTesting();
    origFetch = globalThis.fetch;
    origIssuer = process.env.OIDC_ISSUER;
    origClientId = process.env.OIDC_CLIENT_ID;
    origClientSecret = process.env.OIDC_CLIENT_SECRET;
    process.env.OIDC_ISSUER = 'https://kc.test/realms/test';
    process.env.OIDC_CLIENT_ID = 'kraken';
    process.env.OIDC_CLIENT_SECRET = 'secret';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origIssuer === undefined) delete process.env.OIDC_ISSUER;
    else process.env.OIDC_ISSUER = origIssuer;
    if (origClientId === undefined) delete process.env.OIDC_CLIENT_ID;
    else process.env.OIDC_CLIENT_ID = origClientId;
    if (origClientSecret === undefined) delete process.env.OIDC_CLIENT_SECRET;
    else process.env.OIDC_CLIENT_SECRET = origClientSecret;
    // Clean up any rows the test may have created
    deleteUserToken('U1');
  });

  it('returns lastSweepAt=null with zero counts before any sweep', () => {
    const s = getRefreshLoopStatus();
    expect(s.lastSweepAt).toBeNull();
    expect(s.lastSweepRefreshed).toBe(0);
    expect(s.lastSweepFailed).toBe(0);
    expect(s.lastSweepDeleted).toBe(0);
  });

  it('updates status fields after a sweep with failures', async () => {
    setUserToken('U1', {
      access_token: 'a',
      refresh_token: 'r',
      // Expires in 1 second (well within REFRESH_AHEAD_MS = 10 min).
      expires_at: Date.now() + 1000,
      keycloak_sub: 's',
      email: 'u@e',
    });

    // Mock fetch to return a 400 — refreshToken throws, sweep counts a failure.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('bad', { status: 400 }),
      ) as unknown as typeof globalThis.fetch;

    await refreshAllExpiring();

    const s = getRefreshLoopStatus();
    expect(s.lastSweepAt).not.toBeNull();
    expect(s.lastSweepFailed).toBe(1);
    expect(s.lastSweepRefreshed).toBe(0);
  });

  it('updates status fields with refreshed count on success', async () => {
    setUserToken('U1', {
      access_token: 'a',
      refresh_token: 'r',
      expires_at: Date.now() + 1000,
      keycloak_sub: 's',
      email: 'u@e',
    });

    // Return a valid token-refresh response. expires_in lets storeTokenForUser
    // compute a future expires_at.
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'eyJ.eyJzdWIiOiJzIn0.x',
          refresh_token: 'r2',
          expires_in: 300,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof globalThis.fetch;

    await refreshAllExpiring();

    const s = getRefreshLoopStatus();
    expect(s.lastSweepFailed).toBe(0);
    expect(s.lastSweepRefreshed).toBe(1);
  });
});
