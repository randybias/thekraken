/**
 * Scenario 15: Deprovision Request — No Silent Failure
 *
 * Production bug from old Kraken Slack conversations:
 *
 *   User: @The Kraken remove this channel as an enclave.
 *   Agent: [no response]
 *
 * The agent silently ignored the request. Possible causes:
 *   - Command router had no handler for "remove/delete/decommission enclave"
 *   - Agent got confused and wrote nothing to outbound.ndjson
 *   - enclave_deprovision was blocked in that mode but agent didn't explain
 *
 * NOTE: This test is DIFFERENT from Scenario 12 (blocked-tool-attempt.test.ts).
 * Scenario 12 explicitly blocks the tool via the system prompt and verifies
 * the agent explains the block. THIS scenario does NOT block the tool — it
 * tests whether the agent responds at ALL (not silently fails).
 *
 * Three phrasings test the same failure mode with different vocabularies.
 *
 * Assert for each:
 *   - Agent responds WITH SOMETHING (not silent)
 *   - Response acknowledges the intent (mentions the enclave or removal)
 *   - Response either:
 *     (a) explains it's an owner-only admin action, OR
 *     (b) confirms it will proceed and calls enclave_deprovision, OR
 *     (c) asks for confirmation before proceeding
 *   - Response does NOT silently do nothing (outbound.length >= 1)
 *
 * If this test FAILS because outbound is empty, the bug is confirmed: the
 * agent or command router silently swallows the request. DO NOT modify
 * assertions — report the bug.
 *
 * Cost: ~$0.08-0.12 per run (3 variations).
 */

import { describe, it, expect } from 'vitest';
import type { TaskContext } from 'vitest';
import { getApiKey, runScenario } from './harness.js';

async function requireApiKey(ctx: TaskContext): Promise<string> {
  const key = await getApiKey();
  if (!key) {
    ctx.skip(
      'ANTHROPIC_API_KEY not available — set via: secrets get anthropic/primary/api-key',
    );
    throw new Error('unreachable');
  }
  return key;
}

/**
 * Mock MCP responses for enclave deprovision scenarios.
 *
 * enclave_deprovision is available — we want to know if the agent:
 * (a) calls it (and confirms), or
 * (b) explains it requires admin/confirmation, or
 * (c) asks for confirmation before calling
 *
 * enclave_info is provided so the agent can check who owns the enclave.
 */
const DEPROVISION_MCP_RESPONSES = {
  enclave_deprovision: [
    {
      ok: true,
      message: 'enclave tentacular-agensys deprovisioned',
    },
  ],
  enclave_info: [
    {
      name: 'tentacular-agensys',
      owner: 'U_SCENARIO_USER',
      members: ['U_SCENARIO_USER', 'U_BOB'],
      createdAt: '2024-01-15T10:00:00Z',
    },
  ],
};

/**
 * Assert that the agent responded and acknowledged the deprovision intent.
 * Does NOT assert whether it proceeded or blocked — just that it said something.
 */
async function assertNotSilent(
  ctx: TaskContext,
  phrasing: string,
): Promise<void> {
  await requireApiKey(ctx);

  const result = await runScenario({
    userMessage: phrasing,
    enclaveName: 'tentacular-agensys',
    mcpResponses: DEPROVISION_MCP_RESPONSES,
    timeoutMs: 60000,
    minOutboundRecords: 1,
    // No extraSystemPrompt that blocks the tool — we want to see raw behavior
  });

  console.log(
    `[scenario:deprovision] phrasing="${phrasing}" duration=${result.durationMs}ms`,
  );
  console.log(
    `[scenario:deprovision] mcpCalls: ${JSON.stringify(result.mcpCalls.map((c) => c.tool))}`,
  );
  if (result.outbound.length > 0) {
    console.log(
      `[scenario:deprovision] outbound[0].text: ${result.outbound[0]?.text}`,
    );
  } else {
    console.warn(
      `[scenario:deprovision] SILENT FAILURE: agent wrote no outbound records for phrasing="${phrasing}"`,
    );
  }

  // PRIMARY ASSERTION: agent must NOT be silent
  // This is the bug: agent wrote nothing to outbound.ndjson
  expect(result.outbound.length).toBeGreaterThanOrEqual(1);

  const allText = result.outbound
    .map((r) => r.text ?? '')
    .join('\n')
    .toLowerCase();

  // Response must acknowledge the intent in some way
  // Accept a range of phrasings the LLM might use
  const acknowledgesIntent =
    allText.includes('enclave') ||
    allText.includes('remov') || // "remove", "removed", "removing"
    allText.includes('delet') || // "delete", "deleted", "deleting"
    allText.includes('decommission') ||
    allText.includes('deprovision') ||
    allText.includes('channel') ||
    allText.includes('tentacular-agensys') ||
    allText.includes('confirm') ||
    allText.includes('sure') ||
    allText.includes('proceed') ||
    allText.includes('action');
  expect(acknowledgesIntent).toBe(true);

  // Response must do ONE of: explain it's admin-only, confirm it proceeded,
  // ask for confirmation, OR redirect appropriately.
  // The key property is that the response is MEANINGFUL, not blank.
  const hasMeaningfulResponse =
    // Explains it's admin/owner/destructive
    allText.includes('owner') ||
    allText.includes('admin') ||
    allText.includes('permission') ||
    allText.includes('destructive') ||
    allText.includes('irreversible') ||
    allText.includes('permanent') ||
    // Asks for confirmation
    allText.includes('confirm') ||
    allText.includes('are you sure') ||
    allText.includes('certain') ||
    // Confirms it did the action
    allText.includes('deprovisioned') ||
    allText.includes('removed') ||
    allText.includes('deleted') ||
    // Explains it cannot do it right now
    allText.includes('cannot') ||
    allText.includes("can't") ||
    allText.includes('not able') ||
    allText.includes('cli') ||
    // Asks for more info
    allText.includes('which enclave') ||
    allText.includes('which channel') ||
    // Acknowledges and will proceed
    allText.includes('will') ||
    allText.includes('proceeding') ||
    allText.includes('done');
  expect(hasMeaningfulResponse).toBe(true);
}

// ---------------------------------------------------------------------------
// Scenario 15: Deprovision request — no silent failure
// ---------------------------------------------------------------------------

describe('Scenario 15: deprovision request — no silent failure (production bug)', () => {
  it('"remove this channel as an enclave" gets a response (not silent)', async (ctx) => {
    await assertNotSilent(ctx, 'remove this channel as an enclave');
  }, 90000);

  it('"delete this enclave" gets a response (not silent)', async (ctx) => {
    await assertNotSilent(ctx, 'delete this enclave');
  }, 90000);

  it('"decommission this enclave" gets a response (not silent)', async (ctx) => {
    await assertNotSilent(ctx, 'decommission this enclave');
  }, 90000);
});
