import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refreshAllExpiring, _resetRefreshSweepInFlightForTesting } from '../../../src/auth/oidc.js';
import { initSecretsDatabase } from '../../../src/db/index.js';
import {
  initTokenStore,
  setUserToken,
  deleteUserToken,
} from '../../../src/auth/tokens.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { KrakenConfig } from '../../../src/config.js';

function makeConfig(dir: string): KrakenConfig {
  return {
    teamsDir: join(dir, 'teams'),
    gitState: { repoUrl: 'x', branch: 'main', dir: join(dir, 'git-state') },
  } as KrakenConfig;
}

describe('refreshAllExpiring overlap guard (rc.13)', () => {
  let dir: string;
  let origFetch: typeof globalThis.fetch;
  let origIssuer: string | undefined;
  let origClientId: string | undefined;
  let origClientSecret: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'overlap-'));
    initTokenStore(initSecretsDatabase(makeConfig(dir)));
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
    deleteUserToken('U1');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a second concurrent call short-circuits while the first is in flight', async () => {
    setUserToken('U1', {
      access_token: 'a',
      refresh_token: 'r',
      expires_at: Date.now() + 1000,
      keycloak_sub: 's',
      email: 'u@e',
    });

    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      // Slow refresh — first call is still in flight when the second
      // refreshAllExpiring is invoked.
      await new Promise((r) => setTimeout(r, 50));
      return new Response('bad', { status: 400 });
    }) as unknown as typeof globalThis.fetch;

    const p1 = refreshAllExpiring();
    const p2 = refreshAllExpiring(); // short-circuited
    await Promise.all([p1, p2]);

    // Only one fetch — the second sweep was skipped.
    expect(fetchCount).toBe(1);
  });

  it('after the first sweep completes, a subsequent sweep is allowed', async () => {
    setUserToken('U1', {
      access_token: 'a',
      refresh_token: 'r',
      expires_at: Date.now() + 1000,
      keycloak_sub: 's',
      email: 'u@e',
    });

    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return new Response('bad', { status: 400 });
    }) as unknown as typeof globalThis.fetch;

    await refreshAllExpiring();
    await refreshAllExpiring();

    // Two sweeps, two fetches — guard reset properly between calls.
    expect(fetchCount).toBe(2);
  });
});
