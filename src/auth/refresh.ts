/**
 * Background token refresh loop.
 *
 * Proactively refreshes user tokens that are approaching expiry.
 * Runs on a 60-second interval (faster than the reference 5-minute loop
 * to handle short-lived Keycloak access tokens — see design A10).
 *
 * Refresh heuristic: refresh tokens expiring within the next 15 minutes
 * (the "25% of lifetime remaining" window for a 1-hour Keycloak token).
 *
 * A concurrent-refresh guard prevents double-refreshing the same user if
 * a sweep overlaps with a slow Keycloak response.
 *
 * On refresh failure: token is marked expired. Next auth gate hit will
 * detect null from getValidTokenForUser() and trigger re-auth (D6).
 */

import { createChildLogger } from '../logger.js';
import type { OidcConfig } from '../config.js';
import { refreshAccessToken } from './oidc.js';
import { UserTokenStore } from './tokens.js';

const log = createChildLogger({ module: 'token-refresh' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Check for expiring tokens every 60 seconds. */
export const REFRESH_LOOP_INTERVAL_MS = 60_000;

/**
 * Lookahead window for token refresh.
 * Tokens expiring within the next 15 minutes are refreshed proactively.
 * For a 1-hour token: 75% of lifetime = 45 minutes into the token.
 * At 60 minutes - 15 minutes = 45 minutes, we refresh.
 */
export const REFRESH_LOOKAHEAD_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let refreshTimer: NodeJS.Timeout | null = null;
/** Guard against concurrent refresh of the same user's token. */
const refreshingUsers = new Set<string>();

// ---------------------------------------------------------------------------
// JWT claim extraction
// ---------------------------------------------------------------------------

/**
 * Extract the email claim from a JWT payload (base64url-encoded).
 * Returns empty string on parse failure.
 */
export function extractEmailFromToken(token: string): string {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1]!, 'base64url').toString(),
    );
    return (payload.email as string) ?? '';
  } catch {
    return '';
  }
}

/**
 * Extract the sub claim from a JWT payload (base64url-encoded).
 * Returns empty string on parse failure.
 */
export function extractSubFromToken(token: string): string {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1]!, 'base64url').toString(),
    );
    return (payload.sub as string) ?? '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Refresh sweep
// ---------------------------------------------------------------------------

/**
 * Run one refresh sweep: find tokens expiring soon, refresh them.
 *
 * Exported for testing. Not intended for direct production use outside
 * of the refresh loop.
 */
export async function runRefreshSweep(
  store: UserTokenStore,
  config: OidcConfig,
): Promise<{ refreshed: number; failed: number }> {
  const candidates = store.getRefreshableTokens(REFRESH_LOOKAHEAD_MS);
  let refreshed = 0;
  let failed = 0;

  for (const { slackUserId, refreshToken } of candidates) {
    // Skip if already being refreshed by a concurrent sweep
    if (refreshingUsers.has(slackUserId)) continue;
    refreshingUsers.add(slackUserId);

    try {
      const tokens = await refreshAccessToken(config, refreshToken);
      // Re-store with the SAME created_at (session window doesn't reset on refresh).
      // The store's UPDATE path preserves created_at automatically.
      store.storeUserToken(
        slackUserId,
        tokens,
        extractSubFromToken(tokens.access_token),
        extractEmailFromToken(tokens.access_token),
      );
      refreshed++;
    } catch (err) {
      log.warn({ slackUserId, err }, 'token refresh failed, marking expired');
      store.markTokenExpired(slackUserId);
      failed++;
    } finally {
      refreshingUsers.delete(slackUserId);
    }
  }

  if (refreshed > 0 || failed > 0) {
    log.info(
      { refreshed, failed, candidates: candidates.length },
      'token refresh sweep complete',
    );
  }

  return { refreshed, failed };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the background token refresh loop.
 *
 * Idempotent — calling twice has no effect.
 * Runs an immediate sweep on startup to catch tokens that expired while
 * the pod was down.
 */
export function startTokenRefreshLoop(
  store: UserTokenStore,
  config: OidcConfig,
): void {
  if (refreshTimer) return; // idempotent

  // Immediate sweep on startup
  runRefreshSweep(store, config).catch((err) =>
    log.error({ err }, 'initial refresh sweep failed'),
  );

  refreshTimer = setInterval(() => {
    runRefreshSweep(store, config).catch((err) =>
      log.error({ err }, 'refresh sweep failed'),
    );
  }, REFRESH_LOOP_INTERVAL_MS);

  // Allow clean process exit — do not keep the event loop alive
  refreshTimer.unref();
}

/**
 * Stop the background token refresh loop.
 * Called on graceful shutdown.
 */
export function stopTokenRefreshLoop(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  refreshingUsers.clear();
}
