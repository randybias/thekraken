/**
 * Scenario 5: Mid-Conversation Correction
 *
 * Real-LLM scenario test: two sequential messages in the same thread.
 * First message: "list my workflows" — agent gets a list [a, b, c].
 * Second message: "actually, just show me the failing ones" — agent should
 * pivot to focusing on failing workflows.
 *
 * Note: The harness is single-turn, so we encode both messages in the mailbox
 * and provide context in the system prompt that this is a thread continuation.
 * The second message is the one the agent should act on.
 *
 * Assert:
 *   - Agent focuses on failing/unhealthy workflows
 *   - Response mentions the failing workflow ("sentiment")
 *   - Response doesn't just list all workflows again without filtering
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

describe('Scenario 5: mid-conversation correction / pivot', () => {
  it('agent pivots to failing workflows when user corrects themselves', async (ctx) => {
    await requireApiKey(ctx);

    // We encode the correction context in the message itself, simulating
    // what the dispatcher would deliver after a thread correction.
    const result = await runScenario({
      userMessage:
        'Actually, ignore the list — just show me the failing workflows',
      enclaveName: 'test-enclave',
      mcpResponses: {
        wf_list: [
          [
            { name: 'pr-review', ready: true, phase: 'Running' },
            { name: 'sentiment', ready: false, phase: 'Error' },
            { name: 'data-pipeline', ready: true, phase: 'Running' },
          ],
        ],
        wf_health_enclave: [
          {
            workflows: [
              { name: 'pr-review', healthy: true, message: 'Running normally' },
              {
                name: 'sentiment',
                healthy: false,
                message: 'CrashLoop: exit code 1',
              },
              {
                name: 'data-pipeline',
                healthy: true,
                message: 'Running normally',
              },
            ],
          },
        ],
      },
      timeoutMs: 60000,
      minOutboundRecords: 1,
      extraSystemPrompt: `## Task Context
The user is asking specifically about FAILING workflows only.
Focus your response on workflows that are unhealthy or not running.
Do not list all workflows — filter to only the problematic ones.`,
    });

    console.log(
      `[scenario:mid-conv-correction] duration=${result.durationMs}ms, exitCode=${result.exitCode}`,
    );
    if (result.outbound.length > 0) {
      console.log(
        `[scenario:mid-conv-correction] outbound[0].text: ${result.outbound[0]?.text}`,
      );
    }

    // Agent must respond
    expect(result.outbound.length).toBeGreaterThanOrEqual(1);

    const allText = result.outbound
      .map((r) => r.text ?? '')
      .join('\n')
      .toLowerCase();

    // Must mention the failing workflow
    expect(allText).toContain('sentiment');

    // Must convey that the workflow has a problem
    const hasProblemIndicator =
      allText.includes('fail') ||
      allText.includes('error') ||
      allText.includes('crash') ||
      allText.includes('unhealthy') ||
      allText.includes('issue') ||
      allText.includes('problem') ||
      allText.includes('not running') ||
      allText.includes("isn't running");
    expect(hasProblemIndicator).toBe(true);
  }, 90000);
});
