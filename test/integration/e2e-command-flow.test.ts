/**
 * Integration test: @kraken command flows.
 *
 * Tests the command router path:
 *   @mention → auth gate → parseCommand → executeCommand → MCP call → Slack reply
 *
 * The command router path bypasses the team dispatcher entirely — commands
 * are deterministic and handled synchronously. This test verifies that:
 *   1. The command is parsed correctly from the mention text.
 *   2. The correct MCP tool is called with the right parameters.
 *   3. The email resolution (users.info) is called for the target user.
 *   4. The confirmation message is posted back to the channel.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createHarness, type Harness } from './harness.js';
import { createAppMention } from '../mocks/event-simulator.js';

describe('e2e: @kraken add @user command (authz → enclave_sync → confirmation)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({
      preAuthedUsers: ['U_OWNER'],
      userEmails: {
        U_OWNER: 'owner@example.com',
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
        members: ['alice@example.com'],
        mode: 'rwxrwx---',
      },
    });
  });

  afterEach(async () => {
    await h.shutdown();
  });

  it('executes @kraken add @user command: resolves email → enclave_sync → confirmation', async () => {
    await h.sendSlackEvent(
      createAppMention({
        user: 'U_OWNER',
        channel: 'C_ENCLAVE_ALPHA',
        text: '<@KRAKEN> add <@U_BOB>',
      }),
    );

    // Wait for async command execution
    await new Promise<void>((r) => setTimeout(r, 100));

    // Verify: enclave_info was called to check ownership
    const infoCalls = h.mockMcp.calls.filter((c) => c.tool === 'enclave_info');
    expect(infoCalls.length).toBeGreaterThanOrEqual(1);

    // Verify: users.info called to resolve U_OWNER (sender) and U_BOB (target)
    expect(h.mockSlack.usersInfoCalls).toContain('U_BOB');
    expect(h.mockSlack.usersInfoCalls).toContain('U_OWNER');

    // Verify: enclave_sync called with add_members
    const syncCalls = h.mockMcp.calls.filter((c) => c.tool === 'enclave_sync');
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0]!.params['add_members']).toEqual(['bob@example.com']);
    expect(syncCalls[0]!.params['name']).toBe('enclave-alpha');

    // Verify: confirmation message posted
    expect(h.mockSlack.posted).toHaveLength(1);
    expect(h.mockSlack.posted[0]!.text).toContain('bob@example.com');
  });

  it('add command in unbound channel is silently ignored', async () => {
    await h.sendSlackEvent(
      createAppMention({
        user: 'U_OWNER',
        channel: 'C_NOT_BOUND',
        text: '<@KRAKEN> add <@U_BOB>',
      }),
    );

    await new Promise<void>((r) => setTimeout(r, 50));

    // Unbound channel: no MCP calls, no Slack messages
    expect(h.mockMcp.calls).toHaveLength(0);
    expect(h.mockSlack.posted).toHaveLength(0);
    expect(h.mockSlack.ephemerals).toHaveLength(0);
  });
});

describe('e2e: @kraken members command', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({
      preAuthedUsers: ['U_OWNER'],
      userEmails: { U_OWNER: 'owner@example.com' },
      channelBindings: {
        C_ENCLAVE_ALPHA: {
          enclaveName: 'enclave-alpha',
          owner: 'U_OWNER',
        },
      },
      enclaveInfo: {
        owner: 'owner@example.com',
        members: ['alice@example.com', 'bob@example.com'],
        mode: 'rwxrwx---',
      },
    });
  });

  afterEach(async () => {
    await h.shutdown();
  });

  it('lists enclave members via MCP enclave_info', async () => {
    await h.sendSlackEvent(
      createAppMention({
        user: 'U_OWNER',
        channel: 'C_ENCLAVE_ALPHA',
        text: '<@KRAKEN> members',
      }),
    );

    await new Promise<void>((r) => setTimeout(r, 100));

    // Verify: enclave_info was called
    const infoCalls = h.mockMcp.calls.filter((c) => c.tool === 'enclave_info');
    expect(infoCalls.length).toBeGreaterThanOrEqual(1);

    // Verify: reply contains member info
    expect(h.mockSlack.posted).toHaveLength(1);
    const reply = h.mockSlack.posted[0]!.text;
    expect(reply).toContain('owner@example.com');
    expect(reply).toContain('alice@example.com');
    expect(reply).toContain('bob@example.com');
  });
});
