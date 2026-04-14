import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  initiateDeviceAuth,
  pollForToken,
  refreshAccessToken,
  OidcFlowError,
} from '../../src/auth/oidc.js';
import type { OidcConfig } from '../../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONFIG: OidcConfig = {
  issuer: 'https://keycloak.example.com/realms/tentacular',
  clientId: 'thekraken',
};

const TEST_CONFIG_CONFIDENTIAL: OidcConfig = {
  ...TEST_CONFIG,
  clientSecret: 'my-secret',
};

function makeFetchMock(
  responses: Array<{ ok: boolean; status?: number; body: unknown }>,
) {
  let callIndex = 0;
  return vi.fn().mockImplementation(async () => {
    const resp = responses[callIndex % responses.length]!;
    callIndex++;
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 400),
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    };
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// initiateDeviceAuth
// ---------------------------------------------------------------------------

describe('initiateDeviceAuth', () => {
  it('returns DeviceAuthResponse on success', async () => {
    const mockResp = {
      device_code: 'dev-code-123',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://keycloak.example.com/activate',
      expires_in: 600,
      interval: 5,
    };
    vi.stubGlobal('fetch', makeFetchMock([{ ok: true, body: mockResp }]));

    const result = await initiateDeviceAuth(TEST_CONFIG);
    expect(result.device_code).toBe('dev-code-123');
    expect(result.user_code).toBe('ABCD-EFGH');
    expect(result.expires_in).toBe(600);
  });

  it('throws OidcFlowError on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock([{ ok: false, status: 401, body: 'Unauthorized' }]),
    );
    await expect(initiateDeviceAuth(TEST_CONFIG)).rejects.toThrow(
      OidcFlowError,
    );
  });

  it('sends client_id but not client_secret for public client', async () => {
    let capturedBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: 'dc',
            user_code: 'UC',
            verification_uri: 'https://x',
            expires_in: 600,
            interval: 5,
          }),
          text: async () => '',
        };
      }),
    );

    await initiateDeviceAuth(TEST_CONFIG);
    const params = new URLSearchParams(capturedBody);
    expect(params.get('client_id')).toBe('thekraken');
    expect(params.has('client_secret')).toBe(false);
  });

  it('sends client_secret for confidential client', async () => {
    let capturedBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: 'dc',
            user_code: 'UC',
            verification_uri: 'https://x',
            expires_in: 600,
            interval: 5,
          }),
          text: async () => '',
        };
      }),
    );

    await initiateDeviceAuth(TEST_CONFIG_CONFIDENTIAL);
    const params = new URLSearchParams(capturedBody);
    expect(params.get('client_secret')).toBe('my-secret');
  });

  it('sends openid email offline_access scope', async () => {
    let capturedBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: 'dc',
            user_code: 'UC',
            verification_uri: 'https://x',
            expires_in: 600,
            interval: 5,
          }),
          text: async () => '',
        };
      }),
    );

    await initiateDeviceAuth(TEST_CONFIG);
    const params = new URLSearchParams(capturedBody);
    expect(params.get('scope')).toBe('openid email offline_access');
  });
});

// ---------------------------------------------------------------------------
// pollForToken
// ---------------------------------------------------------------------------
//
// pollForToken uses setTimeout-based sleep internally (minimum 5s interval).
// We use fake timers + vi.runAllTimersAsync() to advance time without
// actually waiting.

describe('pollForToken', () => {
  it('returns TokenResponse on success', async () => {
    const tokenResp = {
      access_token: 'at-123',
      refresh_token: 'rt-123',
      expires_in: 3600,
      token_type: 'Bearer',
    };
    vi.stubGlobal('fetch', makeFetchMock([{ ok: true, body: tokenResp }]));

    const pollPromise = pollForToken(TEST_CONFIG, 'dev-code', 5, 60);
    // Advance past the 5s interval
    await vi.runAllTimersAsync();
    const result = await pollPromise;
    expect(result.access_token).toBe('at-123');
    expect(result.refresh_token).toBe('rt-123');
  });

  it('retries on authorization_pending then succeeds', async () => {
    const pendingResp = { error: 'authorization_pending' };
    const tokenResp = {
      access_token: 'at-456',
      refresh_token: 'rt-456',
      expires_in: 3600,
      token_type: 'Bearer',
    };
    vi.stubGlobal(
      'fetch',
      makeFetchMock([
        { ok: false, status: 400, body: pendingResp },
        { ok: true, body: tokenResp },
      ]),
    );

    const pollPromise = pollForToken(TEST_CONFIG, 'dev-code', 5, 60);
    await vi.runAllTimersAsync();
    const result = await pollPromise;
    expect(result.access_token).toBe('at-456');
  });

  it('throws OidcFlowError on access_denied', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock([
        { ok: false, status: 400, body: { error: 'access_denied' } },
      ]),
    );
    const pollPromise = pollForToken(TEST_CONFIG, 'dev-code', 5, 60);
    // Run timers and catch rejection concurrently to avoid unhandled rejection
    const [, result] = await Promise.allSettled([
      vi.runAllTimersAsync(),
      pollPromise,
    ]);
    expect(result!.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
      OidcFlowError,
    );
  });

  it('throws OidcFlowError on expired_token', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock([
        { ok: false, status: 400, body: { error: 'expired_token' } },
      ]),
    );
    const pollPromise = pollForToken(TEST_CONFIG, 'dev-code', 5, 60);
    const [, result] = await Promise.allSettled([
      vi.runAllTimersAsync(),
      pollPromise,
    ]);
    expect(result!.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
      OidcFlowError,
    );
  });

  it('throws OidcFlowError with error_description on unknown error', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock([
        {
          ok: false,
          status: 400,
          body: { error: 'server_error', error_description: 'Internal error' },
        },
      ]),
    );
    const pollPromise = pollForToken(TEST_CONFIG, 'dev-code', 5, 60);
    const [, result] = await Promise.allSettled([
      vi.runAllTimersAsync(),
      pollPromise,
    ]);
    expect(result!.status).toBe('rejected');
    const err = (result as PromiseRejectedResult).reason as OidcFlowError;
    expect(err).toBeInstanceOf(OidcFlowError);
    expect(err.message).toContain('Internal error');
  });

  it('throws OidcFlowError when deadline exceeded immediately', async () => {
    // expiresIn=0 means the deadline is already in the past on entry
    vi.stubGlobal('fetch', vi.fn());
    // No timer advance needed — the while condition fails immediately
    await expect(pollForToken(TEST_CONFIG, 'dev-code', 5, 0)).rejects.toThrow(
      OidcFlowError,
    );
  });

  it('increases interval on slow_down then succeeds', async () => {
    const tokenResp = {
      access_token: 'at-789',
      refresh_token: 'rt-789',
      expires_in: 3600,
      token_type: 'Bearer',
    };
    vi.stubGlobal(
      'fetch',
      makeFetchMock([
        { ok: false, status: 400, body: { error: 'slow_down' } },
        { ok: true, body: tokenResp },
      ]),
    );

    const pollPromise = pollForToken(TEST_CONFIG, 'dev-code', 5, 60);
    await vi.runAllTimersAsync();
    const result = await pollPromise;
    expect(result.access_token).toBe('at-789');
  });
});

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------

describe('refreshAccessToken', () => {
  it('returns new TokenResponse on success', async () => {
    const tokenResp = {
      access_token: 'new-at',
      refresh_token: 'new-rt',
      expires_in: 3600,
      token_type: 'Bearer',
    };
    vi.stubGlobal('fetch', makeFetchMock([{ ok: true, body: tokenResp }]));

    const result = await refreshAccessToken(TEST_CONFIG, 'old-refresh-token');
    expect(result.access_token).toBe('new-at');
    expect(result.refresh_token).toBe('new-rt');
  });

  it('throws OidcFlowError on 400 invalid_grant', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock([{ ok: false, status: 400, body: 'invalid_grant' }]),
    );
    await expect(refreshAccessToken(TEST_CONFIG, 'expired-rt')).rejects.toThrow(
      OidcFlowError,
    );
  });

  it('throws OidcFlowError on 401', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock([{ ok: false, status: 401, body: 'Unauthorized' }]),
    );
    await expect(refreshAccessToken(TEST_CONFIG, 'bad-rt')).rejects.toThrow(
      OidcFlowError,
    );
  });

  it('sends grant_type=refresh_token', async () => {
    let capturedBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'at',
            refresh_token: 'rt',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          text: async () => '',
        };
      }),
    );

    await refreshAccessToken(TEST_CONFIG, 'my-refresh-token');
    const params = new URLSearchParams(capturedBody);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('my-refresh-token');
    expect(params.get('client_id')).toBe('thekraken');
  });
});

// ---------------------------------------------------------------------------
// OidcFlowError
// ---------------------------------------------------------------------------

describe('OidcFlowError', () => {
  it('is an instance of Error', () => {
    const err = new OidcFlowError('test_phase', 400, 'test message');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OidcFlowError);
  });

  it('exposes phase and httpStatus', () => {
    const err = new OidcFlowError('device_auth', 401, 'unauthorized');
    expect(err.phase).toBe('device_auth');
    expect(err.httpStatus).toBe(401);
    expect(err.name).toBe('OidcFlowError');
  });

  it('includes phase and status in message', () => {
    const err = new OidcFlowError('token_refresh', 400, 'invalid_grant');
    expect(err.message).toContain('token_refresh');
    expect(err.message).toContain('400');
    expect(err.message).toContain('invalid_grant');
  });
});
