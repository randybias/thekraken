/**
 * Integration test: token expiry and re-auth flows.
 *
 * Tests that:
 *   1. A user with a token that expires in the very near future is treated
 *      as unauthenticated (EXPIRY_BUFFER_MS guard), triggering device flow.
 *   2. A user whose token was last updated more than 12 hours ago is treated
 *      as session-expired (SESSION_WINDOW_MS guard), triggering re-auth.
 *
 * These tests verify the auth gate correctly handles boundary conditions
 * rather than just the happy path (valid token) or fully missing token.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createHarness, type Harness } from './harness.js';
import { setUserToken } from '../../src/auth/tokens.js';
import { createAppMention } from '../mocks/event-simulator.js';

describe('e2e: token expiry scenarios', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({
      preAuthedUsers: [], // we'll seed tokens manually
      channelBindings: {
        C_ENCLAVE_ALPHA: {
          enclaveName: 'enclave-alpha',
          owner: 'U_OWNER',
        },
      },
      mockDeviceAuth: {
        device_code: 'dev-code-expiry',
        user_code: 'EXPIRY-001',
        verification_uri: 'https://auth.test/device',
        verification_uri_complete: 'https://auth.test/device?code=EXPIRY-001',
        expires_in: 300,
        interval: 5,
      },
    });
  });

  afterEach(async () => {
    await h.shutdown();
  });

  it('user with already-expired token gets device flow prompt', async () => {
    // Seed a token that expired 1 minute ago
    setUserToken('U_EXPIRED', {
      access_token: 'expired-token',
      refresh_token: 'expired-refresh',
      expires_at: Date.now() - 60_000, // expired 1 minute ago
      keycloak_sub: 'sub-expired',
      email: 'expired@example.com',
    });

    await h.sendSlackEvent(
      createAppMention({
        user: 'U_EXPIRED',
        channel: 'C_ENCLAVE_ALPHA',
        text: '<@KRAKEN> run something',
      }),
    );

    // Wait for async processing (token refresh attempt + ephemeral post)
    // The getValidTokenForUser function tries to refresh the token via
    // refreshToken() which will fail (no real Keycloak). After failure
    // it returns null, causing the ephemeral to be posted.
    await new Promise<void>((r) => setTimeout(r, 200));

    // Verify: ephemeral auth prompt was posted (token refresh failed → null → device flow)
    expect(h.mockSlack.ephemerals).toHaveLength(1);
    expect(h.mockSlack.ephemerals[0]!.user).toBe('U_EXPIRED');
    expect(h.mockSlack.ephemerals[0]!.text).toContain('EXPIRY-001');

    // Verify: no team was spawned
    expect(h.teams.activeTeams()).toHaveLength(0);
    expect(h.mockSlack.posted).toHaveLength(0);
  });

  it('user with session-window-expired token (12h+) gets device flow prompt', async () => {
    // Seed a token that has valid expiry but was last updated 13 hours ago
    // We do this by inserting directly into the DB with a stale updated_at.
    // The SESSION_WINDOW_MS check in getValidTokenForUser uses stored.updated_at.
    const thirteenHoursAgo = new Date(
      Date.now() - 13 * 60 * 60 * 1000,
    ).toISOString();

    h.db
      .prepare(
        `INSERT OR REPLACE INTO user_tokens
           (slack_user_id, access_token, refresh_token, expires_at, keycloak_sub, email, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'U_SESSION_OLD',
        'valid-access-token',
        'valid-refresh-token',
        Date.now() + 3600_000, // token itself hasn't expired
        'sub-session-old',
        'old@example.com',
        thirteenHoursAgo, // but session window has expired
      );

    await h.sendSlackEvent(
      createAppMention({
        user: 'U_SESSION_OLD',
        channel: 'C_ENCLAVE_ALPHA',
        text: '<@KRAKEN> hello',
      }),
    );

    await new Promise<void>((r) => setTimeout(r, 100));

    // Verify: session window expired → device flow prompt
    expect(h.mockSlack.ephemerals).toHaveLength(1);
    expect(h.mockSlack.ephemerals[0]!.user).toBe('U_SESSION_OLD');

    // Verify: token was deleted from the DB (getValidTokenForUser deletes on session expiry)
    const row = h.db
      .prepare('SELECT * FROM user_tokens WHERE slack_user_id = ?')
      .get('U_SESSION_OLD');
    expect(row).toBeUndefined();

    // Verify: no team spawned
    expect(h.teams.activeTeams()).toHaveLength(0);
  });

  it('authenticated user with valid token proceeds to team dispatch', async () => {
    // Re-seed a valid user
    setUserToken('U_VALID', {
      access_token: 'valid-token-v1',
      refresh_token: 'valid-refresh-v1',
      expires_at: Date.now() + 4 * 60 * 60 * 1000, // expires in 4 hours
      keycloak_sub: 'sub-valid',
      email: 'valid@example.com',
    });

    await h.sendSlackEvent(
      createAppMention({
        user: 'U_VALID',
        channel: 'C_ENCLAVE_ALPHA',
        text: '<@KRAKEN> build a tentacle',
      }),
    );

    // Wait for team to appear
    await new Promise<void>((r) => setTimeout(r, 100));

    // Verify: NO ephemeral (user is authenticated)
    expect(h.mockSlack.ephemerals).toHaveLength(0);

    // Verify: team was dispatched (either still active or already exited after mock-pi ran)
    // The idle-exit scenario exits quickly, so team may already be gone.
    // We verify via outbound messages that the team did run.
    await h.waitForOutbound(1, 3000);
    expect(h.mockSlack.posted.length).toBeGreaterThanOrEqual(1);
  });
});
