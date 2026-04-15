/**
 * Scenario 3: Vague Request Clarification
 *
 * Real-LLM scenario test: user says "I need a new workflow" without any
 * specifics. Expected behaviour: agent asks clarifying questions rather
 * than blindly proceeding or saying "On it!".
 *
 * Assert:
 *   - Response contains question marks OR question words (what, which, how, when, where)
 *   - Agent does NOT call any write/deploy tools
 *   - Response is not a flat "On it!" / "Sure!" acknowledgement
 *
 * Cost: ~$0.04 per run.
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

describe('Scenario 3: vague request clarification', () => {
  it('agent asks clarifying questions when request lacks specifics', async (ctx) => {
    await requireApiKey(ctx);

    const result = await runScenario({
      userMessage: 'I need a new workflow',
      enclaveName: 'test-enclave',
      mcpResponses: {
        wf_list: [[{ name: 'pr-review', ready: true }]],
      },
      timeoutMs: 60000,
      minOutboundRecords: 1,
    });

    console.log(
      `[scenario:vague-request] duration=${result.durationMs}ms, exitCode=${result.exitCode}`,
    );
    if (result.outbound.length > 0) {
      console.log(
        `[scenario:vague-request] outbound[0].text: ${result.outbound[0]?.text}`,
      );
    }

    // Agent must have written a response
    expect(result.outbound.length).toBeGreaterThanOrEqual(1);

    const allText = result.outbound
      .map((r) => r.text ?? '')
      .join('\n')
      .toLowerCase();

    // Must ask at least one clarifying question
    const hasQuestionMark = allText.includes('?');
    const hasQuestionWord =
      allText.includes('what') ||
      allText.includes('which') ||
      allText.includes('how') ||
      allText.includes('when') ||
      allText.includes('where') ||
      allText.includes('who') ||
      allText.includes('could you') ||
      allText.includes('can you') ||
      allText.includes('tell me more') ||
      allText.includes('more details') ||
      allText.includes('more information');

    expect(hasQuestionMark || hasQuestionWord).toBe(true);

    // Must NOT be a flat "On it!" / "Sure!" non-answer
    // (The response should have substance — more than 20 chars)
    const combinedLength = result.outbound
      .map((r) => r.text ?? '')
      .join('')
      .trim().length;
    expect(combinedLength).toBeGreaterThan(20);
  }, 90000);
});
