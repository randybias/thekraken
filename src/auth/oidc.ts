/**
 * Per-user OIDC device authorization flow for thekraken.
 * Ported from thekraken-reference/src/oidc.ts with these changes:
 *   - Import storage functions from ./tokens.js (not ./db.js)
 *   - storeTokenForUser extracts keycloak_sub and email from JWT payload
 *     (required by the token schema)
 *   - getServiceToken() removed — D6: no service identities for enclave work
 *   - extractEmailFromToken() added for authz layer use
 *
 * Endpoint URLs are derived directly from OIDC_ISSUER (Keycloak convention):
 *   device auth: {OIDC_ISSUER}/protocol/openid-connect/auth/device
 *   token:       {OIDC_ISSUER}/protocol/openid-connect/token
 *
 * Public API:
 *   initiateDeviceAuth()                       — start device auth, returns DeviceAuthResponse
 *   pollForToken(deviceCode, interval, expiry) — poll until complete, returns TokenResponse
 *   refreshToken(storedRefreshToken)            — refresh expired token, returns TokenResponse
 *   storeTokenForUser(slackUserId, tokens)      — persist TokenResponse to SQLite
 *   getValidTokenForUser(slackUserId)           — return access token or null
 *   extractEmailFromToken(token)                — extract email claim from JWT, returns string | undefined
 */

import {
  getUserToken,
  setUserToken,
  getAllUserTokens,
  deleteUserToken,
} from './tokens.js';
import { logger } from '../logger.js';

// --- Config helpers ---

function getConfig(): {
  issuer: string;
  clientId: string;
  clientSecret: string;
} {
  // Read from process.env at call time so that:
  //  (a) tests can control values by setting/deleting process.env keys, and
  //  (b) production deployments provide values via K8s ConfigMap/Secret env vars.
  // OIDC_CLIENT_SECRET is set by the K8s Secret and is not inherited by agent
  // subprocesses because agent-manager uses an explicit env allowlist.
  const issuer = process.env.OIDC_ISSUER ?? '';
  const clientId = process.env.OIDC_CLIENT_ID ?? '';
  const clientSecret = process.env.OIDC_CLIENT_SECRET ?? '';

  if (!issuer) throw new Error('OIDC_ISSUER env var is required');
  if (!clientId) throw new Error('OIDC_CLIENT_ID env var is required');
  if (!clientSecret) throw new Error('OIDC_CLIENT_SECRET env var is required');

  return { issuer, clientId, clientSecret };
}

function endpoints(issuer: string): { deviceAuth: string; token: string } {
  return {
    deviceAuth: `${issuer}/protocol/openid-connect/auth/device`,
    token: `${issuer}/protocol/openid-connect/token`,
  };
}

// --- HTTP helper ---

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

// --- Public types ---

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

// How many ms before expiry to treat a token as expired (clock skew buffer)
const EXPIRY_BUFFER_MS = 30_000;

// Background refresh: proactively refresh tokens expiring within this window
const REFRESH_AHEAD_MS = 10 * 60 * 1000; // 10 minutes

// Background refresh interval
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Session window: tokens older than this are expired regardless of Keycloak state.
// Users authenticate once per day; sessions last 12 hours.
const SESSION_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours

// --- Device auth flow ---

/**
 * Start a device authorization request.
 * Endpoint: {OIDC_ISSUER}/protocol/openid-connect/auth/device
 */
export async function initiateDeviceAuth(): Promise<DeviceAuthResponse> {
  const { issuer, clientId, clientSecret } = getConfig();
  const { deviceAuth } = endpoints(issuer);

  const res = await postForm(deviceAuth, {
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'openid email offline_access',
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Device auth initiation failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<DeviceAuthResponse>;
}

/**
 * Poll the token endpoint until the user completes the device auth flow
 * or the device code expires.
 *
 * Arguments: deviceCode, intervalSeconds, expiresIn (seconds).
 * Returns the raw TokenResponse on success.
 * Throws on terminal error codes or deadline expiry.
 *
 * NOTE: Run this in a background task — it awaits for up to expiresIn seconds.
 */
export async function pollForToken(
  deviceCode: string,
  intervalSeconds: number,
  expiresIn: number,
): Promise<TokenResponse> {
  const { issuer, clientId, clientSecret } = getConfig();
  const { token } = endpoints(issuer);

  const deadline = Date.now() + expiresIn * 1000;
  let effectiveIntervalMs = Math.max(intervalSeconds, 5) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, effectiveIntervalMs));

    const params: Record<string, string> = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: clientId,
      client_secret: clientSecret,
    };

    const res = await postForm(token, params);
    const body = (await res.json()) as TokenResponse & {
      error?: string;
      error_description?: string;
    };

    if (body.error) {
      if (body.error === 'authorization_pending') {
        continue;
      }
      if (body.error === 'slow_down') {
        effectiveIntervalMs += 5_000;
        continue;
      }
      if (body.error === 'expired_token') {
        throw new Error(
          'Device code expired — user did not complete login in time',
        );
      }
      if (body.error === 'access_denied') {
        throw new Error('User denied the authorization request');
      }
      throw new Error(body.error_description ?? body.error);
    }

    if (res.ok) {
      return body as TokenResponse;
    }

    throw new Error(`Token poll failed (${res.status})`);
  }

  throw new Error(
    'Device code deadline exceeded — user did not complete login in time',
  );
}

/**
 * Refresh an expired access token using the stored refresh token.
 * Returns the raw TokenResponse on success.
 * Throws on HTTP error or non-ok response.
 */
export async function refreshToken(
  storedRefreshToken: string,
): Promise<TokenResponse> {
  const { issuer, clientId, clientSecret } = getConfig();
  const { token } = endpoints(issuer);

  const res = await postForm(token, {
    grant_type: 'refresh_token',
    refresh_token: storedRefreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<TokenResponse>;
}

// --- JWT helpers ---

/**
 * Extract the email claim from a JWT access token.
 * Returns undefined if the token is malformed or the claim is absent.
 */
export function extractEmailFromToken(token: string): string | undefined {
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString());
    return payload.email as string | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract a JWT payload as a plain object.
 * Returns null if the token is malformed.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

// --- High-level accessors ---

/**
 * Persist a raw TokenResponse (OAuth2 wire format) for a Slack user.
 * Computes expires_at as a ms timestamp from expires_in.
 * Extracts keycloak_sub and email from the access token JWT payload.
 */
export function storeTokenForUser(
  slackUserId: string,
  tokens: TokenResponse,
): void {
  const expiresAt = Date.now() + tokens.expires_in * 1000;
  const payload = decodeJwtPayload(tokens.access_token);
  const keycloakSub = (payload?.sub as string | undefined) ?? '';
  const email = (payload?.email as string | undefined) ?? '';

  setUserToken(slackUserId, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    keycloak_sub: keycloakSub,
    email,
  });
  logger.debug(
    { slackUserId, expiresAt: new Date(expiresAt).toISOString() },
    'Stored OIDC token for user',
  );
}

/**
 * Return a valid access token for a Slack user, or null.
 *
 * - Returns the stored access token if it is not expired (with EXPIRY_BUFFER_MS buffer).
 * - If the token is expired, attempts a refresh via refreshToken().
 *   On success, stores the new tokens and returns the new access token.
 *   On failure, swallows the error and returns null.
 * - Returns null if no token is stored.
 *
 * Callers that receive null should call initiateDeviceAuth() to start a new
 * device auth flow and prompt the user to authenticate.
 */
export async function getValidTokenForUser(
  slackUserId: string,
): Promise<string | null> {
  const stored = getUserToken(slackUserId);
  if (!stored) return null;

  // Enforce 12-hour session window: if the token was last updated more than
  // SESSION_WINDOW_MS ago, treat it as expired and require re-authentication.
  const updatedAt = new Date(stored.updated_at).getTime();
  if (Date.now() - updatedAt > SESSION_WINDOW_MS) {
    logger.info(
      { slackUserId },
      'Session window expired (12h) — user must re-authenticate',
    );
    deleteUserToken(slackUserId);
    return null;
  }

  const now = Date.now();
  if (stored.expires_at - now > EXPIRY_BUFFER_MS) {
    return stored.access_token;
  }

  // Token expired — attempt refresh
  logger.debug({ slackUserId }, 'Access token expired, attempting refresh');
  try {
    const tokens = await refreshToken(stored.refresh_token);
    storeTokenForUser(slackUserId, tokens);
    return tokens.access_token;
  } catch (err) {
    logger.warn(
      { slackUserId, err },
      'Token refresh failed — user must re-authenticate',
    );
    return null;
  }
}

// --- Background token refresh ---

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Proactively refresh all user tokens that are expiring soon.
 * Runs on a 5-minute interval. Tokens within REFRESH_AHEAD_MS of expiry
 * are refreshed. Tokens past the 12-hour session window are deleted.
 * Errors are logged but never thrown — this is a best-effort background task.
 */
export async function refreshAllExpiring(): Promise<void> {
  const allTokens = getAllUserTokens();
  const now = Date.now();
  let refreshed = 0;
  let expired = 0;

  for (const row of allTokens) {
    const updatedAt = new Date(row.updated_at).getTime();
    if (now - updatedAt > SESSION_WINDOW_MS) {
      deleteUserToken(row.slack_user_id);
      expired++;
      continue;
    }

    const timeUntilExpiry = row.expires_at - now;
    if (timeUntilExpiry < REFRESH_AHEAD_MS) {
      try {
        const tokens = await refreshToken(row.refresh_token);
        storeTokenForUser(row.slack_user_id, tokens);
        refreshed++;
      } catch (err) {
        logger.warn(
          { slackUserId: row.slack_user_id, err },
          'Background token refresh failed',
        );
      }
    }
  }

  if (refreshed > 0 || expired > 0) {
    logger.info(
      { refreshed, expired, total: allTokens.length },
      'Background token refresh sweep complete',
    );
  }
}

/**
 * Start the background token refresh loop.
 * Call once at startup after initDatabase().
 */
export function startTokenRefreshLoop(): void {
  if (refreshTimer) return;
  // Run immediately on startup to catch tokens that expired while the pod was down
  refreshAllExpiring().catch((err) =>
    logger.error({ err }, 'Initial token refresh sweep failed'),
  );
  refreshTimer = setInterval(() => {
    refreshAllExpiring().catch((err) =>
      logger.error({ err }, 'Background token refresh sweep failed'),
    );
  }, REFRESH_INTERVAL_MS);
  logger.info(
    { intervalMs: REFRESH_INTERVAL_MS, sessionWindowMs: SESSION_WINDOW_MS },
    'Background token refresh loop started',
  );
}

/**
 * Stop the background token refresh loop. Call on shutdown.
 */
export function stopTokenRefreshLoop(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
