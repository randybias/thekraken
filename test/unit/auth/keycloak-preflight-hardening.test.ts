import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runKeycloakPreflight } from '../../../src/auth/oidc.js';

describe('Keycloak preflight hardening (rc.13)', () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  // Give 15s so the 5s AbortSignal fires well within the vitest timeout
  it('honors AbortSignal timeout on issuer fetch (no infinite hang)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (_url, init: RequestInit | undefined) => {
        // Slow endpoint that respects abort
        await new Promise((resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
          setTimeout(resolve, 30_000);
        });
        throw new Error('should have aborted');
      }) as unknown as typeof globalThis.fetch;

    const start = Date.now();
    const result = await runKeycloakPreflight('https://slow');
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    // Should abort well under 30s — production timeout is 5s
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it('returns ok=false when jwks_uri returns 503', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            device_authorization_endpoint: 'd',
            scopes_supported: ['openid', 'offline_access'],
            jwks_uri: 'https://kc/jwks',
          }),
          { status: 200 },
        );
      }
      // jwks endpoint
      return new Response('down', { status: 503 });
    }) as unknown as typeof globalThis.fetch;

    const result = await runKeycloakPreflight('https://issuer');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/jwks/i);
    expect(result.reason).toMatch(/503/);
  });

  it('returns ok=false when jwks_uri fetch throws', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            device_authorization_endpoint: 'd',
            scopes_supported: ['openid', 'offline_access'],
            jwks_uri: 'https://kc/jwks',
          }),
          { status: 200 },
        );
      }
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const result = await runKeycloakPreflight('https://issuer');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/jwks/i);
  });

  it('passes when issuer + jwks both reachable', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            device_authorization_endpoint: 'd',
            scopes_supported: ['openid', 'offline_access'],
            jwks_uri: 'https://kc/jwks',
          }),
          { status: 200 },
        );
      }
      // jwks reachable
      return new Response(
        JSON.stringify({ keys: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await runKeycloakPreflight('https://issuer');
    expect(result.ok).toBe(true);
  });
});
