/**
 * Scenario 1: List Workflows
 *
 * Real-LLM scenario test: spawns the actual pi-coding-agent with a real
 * Anthropic API key, sends "list my workflows in this enclave", and asserts:
 *   - Agent called wf_list with enclave='test-enclave'
 *   - Outbound message contains "pr-review" and "sentiment"
 *   - Outbound message does NOT contain Kubernetes jargon
 *
 * This test costs ~$0.01-$0.05 per run (Anthropic API). Do not add to
 * default `npm test`. Run with: npm run test:scenarios
 */

import { describe, it, expect } from 'vitest';
import type { TaskContext } from 'vitest';
import { getApiKey, runScenario } from './harness.js';

/**
 * Skip the test if ANTHROPIC_API_KEY is not available.
 * Checks at runtime so the skip message is clear.
 */
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

// ---------------------------------------------------------------------------
// Scenario 1: List workflows
// ---------------------------------------------------------------------------

describe('Scenario 1: list workflows', () => {
  it('agent calls wf_list and returns workflow names in friendly language', async (ctx) => {
    await requireApiKey(ctx);

    const result = await runScenario({
      userMessage: 'list my workflows in this enclave',
      enclaveName: 'test-enclave',
      mcpResponses: {
        wf_list: [
          [
            { name: 'pr-review', ready: true, phase: 'Running' },
            { name: 'sentiment', ready: false, phase: 'CrashLoopBackOff' },
          ],
        ],
      },
      timeoutMs: 60000,
      minOutboundRecords: 1,
    });

    console.log(
      `[scenario:list-workflows] duration=${result.durationMs}ms, exitCode=${result.exitCode}`,
    );
    console.log(
      `[scenario:list-workflows] mcpCalls: ${JSON.stringify(result.mcpCalls.map((c) => c.tool))}`,
    );
    if (result.outbound.length > 0) {
      console.log(
        `[scenario:list-workflows] outbound[0].text: ${result.outbound[0]?.text}`,
      );
    }

    // Agent must have written at least one outbound record
    expect(result.outbound.length).toBeGreaterThanOrEqual(1);

    // Agent must have called wf_list
    const wfListCalls = result.mcpCalls.filter((c) => c.tool === 'wf_list');
    expect(wfListCalls.length).toBeGreaterThanOrEqual(1);

    // wf_list must have been called with the correct enclave
    const firstCall = wfListCalls[0]!;
    expect(firstCall.params['enclave']).toBe('test-enclave');

    // Outbound text must mention both workflow names
    const allText = result.outbound
      .map((r) => r.text ?? '')
      .join('\n')
      .toLowerCase();
    expect(allText).toContain('pr-review');
    expect(allText).toContain('sentiment');

    // Outbound must NOT contain Kubernetes jargon in user-facing text
    expect(allText).not.toContain('namespace');
    expect(allText).not.toContain('kubectl');
    expect(allText).not.toContain('crashloopbackoff');
  }, 90000); // 90s total (60s scenario + overhead)

  it('outbound records contain text and reference the workflow', async (ctx) => {
    await requireApiKey(ctx);

    const result = await runScenario({
      userMessage: 'show me my workflows',
      enclaveName: 'test-enclave',
      mcpResponses: {
        wf_list: [[{ name: 'data-pipeline', ready: true }]],
      },
      timeoutMs: 60000,
    });

    expect(result.outbound.length).toBeGreaterThanOrEqual(1);

    // The outbound record must have text content
    const firstRecord = result.outbound[0]!;
    expect(firstRecord.text).toBeTruthy();
    expect(typeof firstRecord.text).toBe('string');

    // The text should mention the workflow name
    const text = (firstRecord.text ?? '').toLowerCase();
    expect(text).toContain('data-pipeline');

    // The outbound record type should be a message type
    // (either slack_message or message — the agent may use either)
    if (firstRecord.type !== undefined) {
      expect(['slack_message', 'message', 'reply']).toContain(firstRecord.type);
    }
  }, 90000);
});
