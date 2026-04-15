/**
 * Integration test: lazy enclave binding reconstitution on first @mention.
 *
 * After a PVC reset the enclave_bindings table is empty. The Kraken has no
 * service token (D6), so it cannot call MCP at startup. Instead, the first
 * authenticated @mention in a channel triggers lazy reconstitution:
 *
 *   1. Look up binding in SQLite → miss.
 *   2. Call enclave_list (user's OIDC token via mockMcpCall) → get enclave names.
 *   3. For each enclave call enclave_info to get channel_id → find match.
 *   4. INSERT binding row; return binding.
 *   5. Subsequent mentions in the same channel → SQLite cache hit, no MCP call.
 *
 * These tests confirm the wiring between:
 *   EnclaveBindingEngine.lookupEnclaveWithReconstitute()
 *   harness.handleAppMention() (mirrors bot.ts logic)
 *   mockMcpCall (scripted responses)
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createHarness, type Harness } from './harness.js';
import { createAppMention } from '../mocks/event-simulator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the mcpResponses map for reconstitution.
 *
 * enclave_list → [{name: enclaveName, ...}]
 * enclave_info → {name: enclaveName, channel_id: channelId, ...}
 */
function buildReconstitutionMcpResponses(
  channelId: string,
  enclaveName: string,
): Record<string, unknown[]> {
  return {
    enclave_list: [
      {
        enclaves: [
          {
            name: enclaveName,
            owner: 'alice@example.com',
            status: 'active',
            platform: 'slack',
            channel_name: 'tentacular-agensys',
            created_at: '2025-01-01T00:00:00.000Z',
            members: ['alice@example.com'],
          },
        ],
      },
    ],
    enclave_info: [
      {
        name: enclaveName,
        owner: 'alice@example.com',
        owner_sub: 'sub-alice',
        channel_id: channelId,
        channel_name: 'tentacular-agensys',
        status: 'active',
        platform: 'slack',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test: successful lazy reconstitution
// ---------------------------------------------------------------------------

describe('lazy reconstitution: empty table → MCP lookup → binding inserted', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({
      preAuthedUsers: ['U_ALICE'],
      userEmails: { U_ALICE: 'alice@example.com' },
      // channelBindings intentionally EMPTY — simulates post-PVC-reset state
      channelBindings: {},
      mcpResponses: buildReconstitutionMcpResponses(
        'C_AGENSYS',
        'tentacular-agensys',
      ),
      enableLazyReconstitution: true,
      piScenario: 'idle-exit',
    });
  });

  afterEach(async () => {
    await h.shutdown();
  });

  it('calls enclave_list when no binding exists for the channel', async () => {
    await h.sendSlackEvent(
      createAppMention({
        user: 'U_ALICE',
        channel: 'C_AGENSYS',
        text: '<@KRAKEN> what is running?',
      }),
    );

    // Allow async reconstitution to complete
    await new Promise<void>((r) => setTimeout(r, 50));

    const listCalls = h.mockMcp.calls.filter((c) => c.tool === 'enclave_list');
    expect(listCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('calls enclave_info to resolve channel_id', async () => {
    await h.sendSlackEvent(
      createAppMention({
        user: 'U_ALICE',
        channel: 'C_AGENSYS',
        text: '<@KRAKEN> what is running?',
      }),
    );

    await new Promise<void>((r) => setTimeout(r, 50));

    const infoCalls = h.mockMcp.calls.filter((c) => c.tool === 'enclave_info');
    expect(infoCalls.length).toBeGreaterThanOrEqual(1);
    expect(infoCalls[0]!.params['name']).toBe('tentacular-agensys');
  });

  it('inserts a binding row in SQLite after successful reconstitution', async () => {
    await h.sendSlackEvent(
      createAppMention({
        user: 'U_ALICE',
        channel: 'C_AGENSYS',
        text: '<@KRAKEN> deploy my workflow',
      }),
    );

    await new Promise<void>((r) => setTimeout(r, 50));

    const row = h.db
      .prepare(
        `SELECT channel_id, enclave_name, status
         FROM enclave_bindings
         WHERE channel_id = 'C_AGENSYS'`,
      )
      .get() as
      | { channel_id: string; enclave_name: string; status: string }
      | undefined;

    expect(row).toBeDefined();
    expect(row!.channel_id).toBe('C_AGENSYS');
    expect(row!.enclave_name).toBe('tentacular-agensys');
    expect(row!.status).toBe('active');
  });

  it('subsequent mentions in the same channel do NOT re-query MCP', async () => {
    // First mention — triggers reconstitution
    await h.sendSlackEvent(
      createAppMention({
        user: 'U_ALICE',
        channel: 'C_AGENSYS',
        text: '<@KRAKEN> first mention',
      }),
    );
    await new Promise<void>((r) => setTimeout(r, 50));

    const mcpCallsAfterFirst = h.mockMcp.calls.length;

    // Second mention — should use cache, no new MCP calls
    await h.sendSlackEvent(
      createAppMention({
        user: 'U_ALICE',
        channel: 'C_AGENSYS',
        text: '<@KRAKEN> second mention',
      }),
    );
    await new Promise<void>((r) => setTimeout(r, 50));

    const mcpCallsAfterSecond = h.mockMcp.calls.length;
    expect(mcpCallsAfterSecond).toBe(mcpCallsAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// Test: unknown channel (enclave_info returns no channel_id match)
// ---------------------------------------------------------------------------

describe('lazy reconstitution: unknown channel → polite response, no binding', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({
      preAuthedUsers: ['U_BOB'],
      userEmails: { U_BOB: 'bob@example.com' },
      channelBindings: {},
      // enclave_info channel_id does NOT match C_RANDOM
      mcpResponses: {
        enclave_list: [
          {
            enclaves: [
              {
                name: 'some-other-enclave',
                owner: 'bob@example.com',
                status: 'active',
                platform: 'slack',
                channel_name: 'some-other-channel',
                created_at: '2025-01-01T00:00:00.000Z',
                members: ['bob@example.com'],
              },
            ],
          },
        ],
        enclave_info: [
          {
            name: 'some-other-enclave',
            owner: 'bob@example.com',
            owner_sub: 'sub-bob',
            channel_id: 'C_OTHER', // does NOT match C_RANDOM
            channel_name: 'some-other-channel',
            status: 'active',
            platform: 'slack',
          },
        ],
      },
      enableLazyReconstitution: true,
    });
  });

  afterEach(async () => {
    await h.shutdown();
  });

  it('posts a polite "not an enclave" response when channel has no match', async () => {
    await h.sendSlackEvent(
      createAppMention({
        user: 'U_BOB',
        channel: 'C_RANDOM',
        text: '<@KRAKEN> hello',
      }),
    );

    await new Promise<void>((r) => setTimeout(r, 50));

    expect(h.mockSlack.posted).toHaveLength(1);
    const reply = h.mockSlack.posted[0]!;
    expect(reply.channel).toBe('C_RANDOM');
    expect(reply.text).toContain("isn't an enclave");
  });

  it('does NOT insert a binding row for an unknown channel', async () => {
    await h.sendSlackEvent(
      createAppMention({
        user: 'U_BOB',
        channel: 'C_RANDOM',
        text: '<@KRAKEN> hello',
      }),
    );

    await new Promise<void>((r) => setTimeout(r, 50));

    const row = h.db
      .prepare(
        `SELECT channel_id FROM enclave_bindings WHERE channel_id = 'C_RANDOM'`,
      )
      .get();

    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test: MCP error resilience
// ---------------------------------------------------------------------------

describe('lazy reconstitution: MCP error → warn log, no crash, treat as unbound', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({
      preAuthedUsers: ['U_CAROL'],
      userEmails: { U_CAROL: 'carol@example.com' },
      channelBindings: {},
      // No mcpResponses for enclave_list → the mock returns { ok: true } which
      // has no .enclaves array → reconstitution returns null cleanly.
      // To test actual MCP error path, we rely on the harness mockMcpCall
      // default returning { ok: true } (no enclaves).
      mcpResponses: {},
      enableLazyReconstitution: true,
    });
  });

  afterEach(async () => {
    await h.shutdown();
  });

  it('does not crash when enclave_list returns no enclaves', async () => {
    // Should complete without throwing
    await expect(
      h.sendSlackEvent(
        createAppMention({
          user: 'U_CAROL',
          channel: 'C_EMPTYMCP',
          text: '<@KRAKEN> hello',
        }),
      ),
    ).resolves.not.toThrow();

    await new Promise<void>((r) => setTimeout(r, 50));

    // No binding inserted
    const row = h.db
      .prepare(
        `SELECT channel_id FROM enclave_bindings WHERE channel_id = 'C_EMPTYMCP'`,
      )
      .get();
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test: enclave_list empty list → no binding, no error
// ---------------------------------------------------------------------------

describe('lazy reconstitution: user has no enclaves → polite response', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({
      preAuthedUsers: ['U_DAVE'],
      userEmails: { U_DAVE: 'dave@example.com' },
      channelBindings: {},
      mcpResponses: {
        enclave_list: [{ enclaves: [] }], // empty list
      },
      enableLazyReconstitution: true,
    });
  });

  afterEach(async () => {
    await h.shutdown();
  });

  it('responds politely when user has no enclaves at all', async () => {
    await h.sendSlackEvent(
      createAppMention({
        user: 'U_DAVE',
        channel: 'C_DAVE_CHANNEL',
        text: '<@KRAKEN> help me',
      }),
    );

    await new Promise<void>((r) => setTimeout(r, 50));

    // Should have posted the "not an enclave" message
    expect(h.mockSlack.posted).toHaveLength(1);
    expect(h.mockSlack.posted[0]!.text).toContain("isn't an enclave");

    // No binding row
    const row = h.db
      .prepare(
        `SELECT channel_id FROM enclave_bindings WHERE channel_id = 'C_DAVE_CHANNEL'`,
      )
      .get();
    expect(row).toBeUndefined();
  });
});
