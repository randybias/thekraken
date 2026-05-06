import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runKeycloakPreflight } from '../../../src/auth/oidc.js';

describe('Keycloak preflight (rc.11)', () => {
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('returns ok=true when issuer is reachable + has device endpoint + offline_access + jwks_uri', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_authorization_endpoint: 'https://k/device',
          scopes_supported: ['openid', 'email', 'offline_access'],
          jwks_uri: 'https://k/jwks',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof globalThis.fetch;

    const result = await runKeycloakPreflight('https://issuer/realms/r');
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns ok=false (not throwing) on unreachable issuer', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof globalThis.fetch;
    const result = await runKeycloakPreflight('https://nope');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unreachable|ECONNREFUSED/i);
  });

  it('returns ok=false on non-2xx response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('boom', { status: 500 }),
    ) as unknown as typeof globalThis.fetch;
    const result = await runKeycloakPreflight('https://issuer');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/500/);
  });

  it('returns ok=false when device_authorization_endpoint is missing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          scopes_supported: ['openid', 'offline_access'],
          jwks_uri: 'j',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof globalThis.fetch;
    const result = await runKeycloakPreflight('https://issuer');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/device/i);
  });

  it('returns ok=false when offline_access not in scopes_supported', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_authorization_endpoint: 'd',
          scopes_supported: ['openid', 'email'],
          jwks_uri: 'j',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof globalThis.fetch;
    const result = await runKeycloakPreflight('https://issuer');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/offline_access/);
  });

  it('returns ok=false when jwks_uri is missing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_authorization_endpoint: 'd',
          scopes_supported: ['openid', 'offline_access'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof globalThis.fetch;
    const result = await runKeycloakPreflight('https://issuer');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/jwks_uri/i);
  });
});
