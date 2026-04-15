/**
 * Scenario 7: Non-Existent Workflow
 *
 * Real-LLM scenario test: user asks about a workflow that doesn't exist.
 * Mock wf_describe returns a 404-like error. Mock wf_list returns the
 * available workflows.
 *
 * Expected behaviour: agent gracefully handles the error, does NOT surface
 * raw error text to the user, and suggests available alternatives.
 *
 * Assert:
 *   - Response does NOT contain "404" or raw error strings
 *   - Response mentions available workflow names as alternatives
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

describe('Scenario 7: non-existent workflow', () => {
  it('agent handles 404-like error and offers available alternatives', async (ctx) => {
    await requireApiKey(ctx);

    const result = await runScenario({
      userMessage: 'Tell me about the pr-review-v999 workflow',
      enclaveName: 'test-enclave',
      mcpResponses: {
        wf_describe: [
          {
            error: 'workflow not found',
            code: 404,
            message: 'No workflow named pr-review-v999 in enclave test-enclave',
          },
        ],
        wf_list: [
          [
            { name: 'pr-review', ready: true },
            { name: 'sentiment', ready: false },
            { name: 'data-pipeline', ready: true },
          ],
        ],
      },
      timeoutMs: 60000,
      minOutboundRecords: 1,
      extraSystemPrompt: `## Error Handling
When a tool returns an error (e.g., "not found"), do NOT display the raw error to the user.
Instead: explain in plain English that the workflow wasn't found, then list available workflows as alternatives.`,
    });

    console.log(
      `[scenario:non-existent-workflow] duration=${result.durationMs}ms, exitCode=${result.exitCode}`,
    );
    console.log(
      `[scenario:non-existent-workflow] mcpCalls: ${JSON.stringify(result.mcpCalls.map((c) => c.tool))}`,
    );
    if (result.outbound.length > 0) {
      console.log(
        `[scenario:non-existent-workflow] outbound[0].text: ${result.outbound[0]?.text}`,
      );
    }

    // Agent must respond
    expect(result.outbound.length).toBeGreaterThanOrEqual(1);

    const allText = result.outbound
      .map((r) => r.text ?? '')
      .join('\n')
      .toLowerCase();

    // Must NOT expose raw 404 / error string to user
    expect(allText).not.toContain('404');
    expect(allText).not.toMatch(/error:/i);

    // Must mention that the workflow wasn't found (user-friendly)
    // Accept a range of phrasings the LLM might use
    const hasNotFoundMessage =
      allText.includes("couldn't find") ||
      allText.includes('could not find') ||
      allText.includes('not found') ||
      allText.includes("doesn't exist") ||
      allText.includes('does not exist') ||
      allText.includes('no workflow') ||
      allText.includes("wasn't found") ||
      allText.includes('was not found') ||
      allText.includes("can't find") ||
      allText.includes('cannot find') ||
      allText.includes('unable to find') ||
      allText.includes('no workflow named') ||
      allText.includes('pr-review-v999') || // agent echoed the unknown name back
      allText.includes('not exist') ||
      allText.includes("doesn't seem to exist");
    expect(hasNotFoundMessage).toBe(true);

    // Must mention at least one alternative workflow
    const mentionsAlternative =
      allText.includes('pr-review') ||
      allText.includes('sentiment') ||
      allText.includes('data-pipeline');
    expect(mentionsAlternative).toBe(true);
  }, 90000);
});
