/**
 * Integration test: channel lifecycle events.
 *
 * Tests the channel event path:
 *   member_left_channel → EnclaveBindingEngine.lookupEnclave →
 *   users.info (email resolution) → enclave_info (membership check) →
 *   enclave_sync (remove_members)
 *
 * This path does NOT go through the auth gate (channel events have no user
 * token). The wiring bug to catch: email resolution fails silently if
 * users.info returns no profile.email — verify the guard works correctly.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createHarness, type Harness } from './harness.js';
import {
  createMemberLeftChannel,
  createChannelArchive,
} from '../mocks/event-simulator.js';

describe('e2e: member_left_channel → resolve email → enclave_sync remove', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({
      userEmails: {
        U_BOB: 'bob@example.com',
      },
      channelBindings: {
        C_ENCLAVE_ALPHA: {
          enclaveName: 'enclave-alpha',
          owner: 'U_OWNER',
        },
      },
      enclaveInfo: {
        owner: 'owner@example.com',
        members: ['bob@example.com'],
        mode: 'rwxrwx---',
      },
    });
  });

  afterEach(async () => {
    await h.shutdown();
  });

  it('handles member_left_channel: resolves email → enclave_sync remove', async () => {
    await h.sendSlackEvent(
      createMemberLeftChannel({
        user: 'U_BOB',
        channel: 'C_ENCLAVE_ALPHA',
      }),
    );

    // Wait for async processing (MCP calls are async)
    await new Promise<void>((r) => setTimeout(r, 100));

    // Verify: users.info was called to resolve U_BOB's email
    expect(h.mockSlack.usersInfoCalls).toContain('U_BOB');

    // Verify: enclave_info was called to check membership
    const infoCalls = h.mockMcp.calls.filter((c) => c.tool === 'enclave_info');
    expect(infoCalls).toHaveLength(1);

    // Verify: enclave_sync called with remove_members
    const syncCalls = h.mockMcp.calls.filter((c) => c.tool === 'enclave_sync');
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0]!.params['remove_members']).toEqual(['bob@example.com']);
    expect(syncCalls[0]!.params['name']).toBe('enclave-alpha');
  });

  it('does NOT call enclave_sync when leaving user is the owner', async () => {
    // Re-configure: U_BOB is the owner
    await h.shutdown();
    h = await createHarness({
      userEmails: {
        U_BOB: 'owner@example.com', // Bob is the owner
      },
      channelBindings: {
        C_ENCLAVE_ALPHA: {
          enclaveName: 'enclave-alpha',
          owner: 'U_BOB',
        },
      },
      enclaveInfo: {
        owner: 'owner@example.com',
        members: ['alice@example.com'],
        mode: 'rwxrwx---',
      },
    });

    await h.sendSlackEvent(
      createMemberLeftChannel({
        user: 'U_BOB',
        channel: 'C_ENCLAVE_ALPHA',
      }),
    );

    await new Promise<void>((r) => setTimeout(r, 100));

    // Owner left — should NOT call enclave_sync (guard in drift.ts)
    const syncCalls = h.mockMcp.calls.filter((c) => c.tool === 'enclave_sync');
    expect(syncCalls).toHaveLength(0);
  });

  it('does NOT call enclave_sync when leaving user has no email', async () => {
    // Re-configure: no email mapping for U_STRANGER
    await h.shutdown();
    h = await createHarness({
      userEmails: {}, // empty — no email resolution
      channelBindings: {
        C_ENCLAVE_ALPHA: {
          enclaveName: 'enclave-alpha',
          owner: 'U_OWNER',
        },
      },
      enclaveInfo: {
        owner: 'owner@example.com',
        members: ['alice@example.com'],
        mode: 'rwxrwx---',
      },
    });

    await h.sendSlackEvent(
      createMemberLeftChannel({
        user: 'U_STRANGER',
        channel: 'C_ENCLAVE_ALPHA',
      }),
    );

    await new Promise<void>((r) => setTimeout(r, 100));

    // No email → no sync call
    const syncCalls = h.mockMcp.calls.filter((c) => c.tool === 'enclave_sync');
    expect(syncCalls).toHaveLength(0);
  });

  it('ignores member_left_channel in unbound channel', async () => {
    await h.sendSlackEvent(
      createMemberLeftChannel({
        user: 'U_BOB',
        channel: 'C_NOT_BOUND',
      }),
    );

    await new Promise<void>((r) => setTimeout(r, 50));

    // Unbound channel: no MCP calls at all
    expect(h.mockMcp.calls).toHaveLength(0);
  });
});

describe('e2e: channel_archive → enclave_sync frozen', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({
      channelBindings: {
        C_ENCLAVE_ALPHA: {
          enclaveName: 'enclave-alpha',
          owner: 'U_OWNER',
        },
      },
    });
  });

  afterEach(async () => {
    await h.shutdown();
  });

  it('handles channel_archive: calls enclave_sync with new_status frozen', async () => {
    await h.sendSlackEvent(
      createChannelArchive({
        channel: 'C_ENCLAVE_ALPHA',
      }),
    );

    await new Promise<void>((r) => setTimeout(r, 100));

    // Verify: enclave_sync called with frozen status
    const syncCalls = h.mockMcp.calls.filter((c) => c.tool === 'enclave_sync');
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0]!.params['new_status']).toBe('frozen');
    expect(syncCalls[0]!.params['name']).toBe('enclave-alpha');
  });
});
