/**
 * Keycloak OIDC device authorization flow.
 *
 * Public client design: client_secret is optional. For Keycloak public clients
 * (device flow enabled), OIDC_CLIENT_SECRET should NOT be set. For backwards
 * compatibility with confidential clients, it may be set.
 *
 * Per D6: No getServiceToken(), no client_credentials grant. The Kraken has
 * no identity of its own for cluster work. Only per-user device flow tokens
 * are issued here.
 *
 * Scope: openid email offline_access (email for identity; offline_access for
 * refresh tokens that survive Keycloak session timeouts).
 */

import type { OidcConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive Keycloak OIDC endpoints from issuer URL. */
function endpoints(issuer: string): { deviceAuth: string; token: string } {
  return {
    deviceAuth: `${issuer}/protocol/openid-connect/auth/device`,
    token: `${issuer}/protocol/openid-connect/token`,
  };
}

/** POST application/x-www-form-urlencoded to a URL. */
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// initiateDeviceAuth
// ---------------------------------------------------------------------------

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
    params['client_secret'] = config.clientSecret;
  }

  const res = await postForm(deviceAuth, params);
  if (!res.ok) {
    const body = await res.text();
    throw new OidcFlowError('device_auth_initiation', res.status, body);
  }
  return res.json() as Promise<DeviceAuthResponse>;
}

// ---------------------------------------------------------------------------
// pollForToken
// ---------------------------------------------------------------------------

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
 *   expired_token         -> throw OidcFlowError (terminal)
 *   access_denied         -> throw OidcFlowError (terminal)
 *   <any other error>     -> throw OidcFlowError (terminal)
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
      params['client_secret'] = config.clientSecret;
    }

    const res = await postForm(token, params);
    const body = (await res.json()) as TokenResponse & OidcError;

    if (body.error) {
      switch (body.error) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          effectiveIntervalMs += 5_000;
          continue;
        case 'expired_token':
          throw new OidcFlowError(
            'expired_token',
            res.status,
            'Device code expired -- user did not complete login in time',
          );
        case 'access_denied':
          throw new OidcFlowError(
            'access_denied',
            res.status,
            'User denied the authorization request',
          );
        default:
          throw new OidcFlowError(
            body.error,
            res.status,
            body.error_description ?? body.error,
          );
      }
    }

    if (res.ok) return body as TokenResponse;
    throw new OidcFlowError(
      'token_poll',
      res.status,
      'Unexpected non-ok response',
    );
  }

  throw new OidcFlowError(
    'deadline_exceeded',
    0,
    'Device code deadline exceeded -- user did not complete login in time',
  );
}

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------

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
    params['client_secret'] = config.clientSecret;
  }

  const res = await postForm(token, params);
  if (!res.ok) {
    const body = await res.text();
    throw new OidcFlowError('token_refresh', res.status, body);
  }
  return res.json() as Promise<TokenResponse>;
}
