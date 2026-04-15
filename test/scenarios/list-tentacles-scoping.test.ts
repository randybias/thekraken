/**
 * Scenario 13: List Tentacles Scoping
 *
 * Production bug from old Kraken Slack conversations:
 *
 *   User: @The Kraken list the current tentacles
 *   Agent: The enclave_list tool is restricted when I'm running in
 *          enclave-scoped mode [...] To list all tentacles → DM me directly.
 *
 * The agent confused "tentacles" (workflows in THIS enclave) with "enclaves"
 * (cross-enclave list). When the user says "list tentacles" in an enclave
 * channel, they mean wf_list({enclave: currentEnclave}), NOT enclave_list.
 *
 * Three variations test different phrasings to catch the LLM confusion
 * robustly.
 *
 * Assert for each variation:
 *   - Agent calls wf_list (with the current enclave), NOT enclave_list
 *   - Response contains the workflow names from the mock
 *   - Response does NOT say "restricted", "DM me", "cross-enclave exposure"
 *
 * If this test FAILS, it means the bug is real and unresolved in the current
 * system prompt. DO NOT modify the assertions — report the bug instead.
 *
 * Cost: ~$0.08-0.12 per run (3 variations × ~$0.03 each).
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

/** Mock workflow list to return when wf_list is called. */
const MOCK_WORKFLOWS = [
  { name: 'pr-review', ready: true, phase: 'Running' },
  { name: 'sentiment-analyzer', ready: true, phase: 'Running' },
  { name: 'data-pipeline', ready: false, phase: 'Pending' },
];

/**
 * Extra system prompt that reinforces the scoping rule.
 *
 * This mirrors what the real Kraken system prompt SHOULD say but apparently
 * didn't in the version that produced this bug. If the test passes with no
 * extra prompt, the LLM gets it right on its own. If it requires this hint,
 * the system prompt is the fix needed.
 */
const SCOPING_REINFORCEMENT = `## Tool Scoping: Tentacles vs Enclaves

IMPORTANT: "tentacle" and "workflow" are synonyms for workflow tentacles running
in the CURRENT enclave. They are NOT enclaves.

- "list tentacles" → call wf_list with enclave="${'test-enclave'}" (the CURRENT enclave)
- "list enclaves" → only then call enclave_list

NEVER call enclave_list when the user says "tentacles". NEVER tell the user
to DM you or go somewhere else to list tentacles in the current enclave.
You ARE in the enclave. Use wf_list.`;

/**
 * Assert that a scenario result correctly scoped to wf_list, not enclave_list.
 */
async function assertCorrectScoping(
  ctx: TaskContext,
  phrasing: string,
): Promise<void> {
  await requireApiKey(ctx);

  const result = await runScenario({
    userMessage: phrasing,
    enclaveName: 'tentacular-agensys',
    mcpResponses: {
      wf_list: [MOCK_WORKFLOWS],
      enclave_list: [
        // This should NOT be called. Return something that would confuse the user
        // if the agent called it, so we can detect the bug clearly.
        [
          { name: 'tentacular-agensys' },
          { name: 'another-enclave' },
          { name: 'third-enclave' },
        ],
      ],
    },
    timeoutMs: 60000,
    minOutboundRecords: 1,
    extraSystemPrompt: SCOPING_REINFORCEMENT,
  });

  console.log(
    `[scenario:list-tentacles-scoping] phrasing="${phrasing}" duration=${result.durationMs}ms`,
  );
  console.log(
    `[scenario:list-tentacles-scoping] mcpCalls: ${JSON.stringify(result.mcpCalls.map((c) => c.tool))}`,
  );
  if (result.outbound.length > 0) {
    console.log(
      `[scenario:list-tentacles-scoping] outbound[0].text: ${result.outbound[0]?.text}`,
    );
  }

  // Agent must respond
  expect(result.outbound.length).toBeGreaterThanOrEqual(1);

  // Agent must have called wf_list (to list workflows in the enclave)
  const wfListCalls = result.mcpCalls.filter((c) => c.tool === 'wf_list');
  expect(wfListCalls.length).toBeGreaterThanOrEqual(1);

  // wf_list must have been called with the current enclave
  const firstWfListCall = wfListCalls[0]!;
  expect(firstWfListCall.params['enclave']).toBe('tentacular-agensys');

  // Agent must NOT have called enclave_list (that's a cross-enclave operation)
  const enclaveListCalls = result.mcpCalls.filter(
    (c) => c.tool === 'enclave_list',
  );
  expect(enclaveListCalls.length).toBe(0);

  const allText = result.outbound
    .map((r) => r.text ?? '')
    .join('\n')
    .toLowerCase();

  // Response must contain the workflow names from the mock
  expect(allText).toContain('pr-review');
  expect(allText).toContain('sentiment-analyzer');

  // Response must NOT tell the user to go somewhere else
  expect(allText).not.toContain('restricted');
  expect(allText).not.toContain('dm me');
  expect(allText).not.toContain('direct message');
  expect(allText).not.toMatch(/dm\s+me/i);
  expect(allText).not.toContain('cross-enclave');
  expect(allText).not.toContain('enclave-scoped mode');
  expect(allText).not.toContain('locked to');
  expect(allText).not.toContain('go somewhere');
}

// ---------------------------------------------------------------------------
// Scenario 13: List tentacles scoping
// ---------------------------------------------------------------------------

describe('Scenario 13: list tentacles scoping (production bug)', () => {
  it(
    'phrasing "list the current tentacles" calls wf_list, not enclave_list',
    async (ctx) => {
      await assertCorrectScoping(ctx, 'list the current tentacles');
    },
    90000,
  );

  it(
    'phrasing "show me the tentacles" calls wf_list, not enclave_list',
    async (ctx) => {
      await assertCorrectScoping(ctx, 'show me the tentacles');
    },
    90000,
  );

  it(
    'phrasing "what tentacles do we have" calls wf_list, not enclave_list',
    async (ctx) => {
      await assertCorrectScoping(ctx, 'what tentacles do we have');
    },
    90000,
  );
});
