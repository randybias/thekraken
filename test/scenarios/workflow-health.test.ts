/**
 * Scenario 2: Workflow Health
 *
 * Real-LLM scenario test: spawns the actual pi-coding-agent with a real
 * Anthropic API key, sends "what's the health of my workflows?", and asserts:
 *   - Agent called appropriate health tools (wf_health_enclave and/or wf_describe)
 *   - Response is user-friendly (no pod/container/namespace jargon)
 *   - Response acknowledges the health status of workflows
 *
 * This test costs ~$0.01-$0.05 per run (Anthropic API). Do not add to
 * default `npm test`. Run with: npm run test:scenarios
 */

import { describe, it, expect } from 'vitest';
import type { TaskContext } from 'vitest';
import { getApiKey, runScenario } from './harness.js';

/**
 * Skip the test if ANTHROPIC_API_KEY is not available.
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
// Scenario 2: Workflow health
// ---------------------------------------------------------------------------

describe('Scenario 2: workflow health', () => {
  it('agent calls health tools and responds with user-friendly status', async (ctx) => {
    await requireApiKey(ctx);

    const result = await runScenario({
      userMessage: "what's the health of my workflows?",
      enclaveName: 'test-enclave',
      mcpResponses: {
        wf_health_enclave: [
          {
            workflows: [
              {
                name: 'pr-review',
                healthy: true,
                message: 'All components running normally',
              },
              {
                name: 'sentiment',
                healthy: false,
                message: 'Waiting for resources',
              },
            ],
          },
        ],
        wf_list: [
          [
            { name: 'pr-review', ready: true },
            { name: 'sentiment', ready: false },
          ],
        ],
      },
      timeoutMs: 60000,
      minOutboundRecords: 1,
    });

    console.log(
      `[scenario:workflow-health] duration=${result.durationMs}ms, exitCode=${result.exitCode}`,
    );
    console.log(
      `[scenario:workflow-health] mcpCalls: ${JSON.stringify(result.mcpCalls.map((c) => c.tool))}`,
    );
    if (result.outbound.length > 0) {
      console.log(
        `[scenario:workflow-health] outbound[0].text: ${result.outbound[0]?.text}`,
      );
    }

    // Agent must have written at least one outbound record
    expect(result.outbound.length).toBeGreaterThanOrEqual(1);

    // Agent must have called at least one health-related tool
    const healthToolCalls = result.mcpCalls.filter(
      (c) =>
        c.tool === 'wf_health_enclave' ||
        c.tool === 'wf_describe' ||
        c.tool === 'wf_list',
    );
    expect(healthToolCalls.length).toBeGreaterThanOrEqual(1);

    // Outbound text must contain health-related information
    const allText = result.outbound
      .map((r) => r.text ?? '')
      .join('\n')
      .toLowerCase();

    // Must mention the workflows by name
    expect(allText).toContain('pr-review');
    expect(allText).toContain('sentiment');

    // Must not use Kubernetes jargon in user-facing text
    expect(allText).not.toContain('namespace');
    expect(allText).not.toContain('kubectl');
    expect(allText).not.toContain('pod/');

    // Should convey that one workflow is healthy and one is not
    const hasHealthyIndicator =
      allText.includes('healthy') ||
      allText.includes('running') ||
      allText.includes('ok') ||
      allText.includes('good') ||
      allText.includes('normal');
    const hasUnhealthyIndicator =
      allText.includes('unhealthy') ||
      allText.includes('not') ||
      allText.includes('issue') ||
      allText.includes('waiting') ||
      allText.includes('problem') ||
      allText.includes('down') ||
      allText.includes('fail');

    expect(hasHealthyIndicator).toBe(true);
    expect(hasUnhealthyIndicator).toBe(true);
  }, 90000);

  it('health tools are called with correct enclave parameter', async (ctx) => {
    await requireApiKey(ctx);

    const result = await runScenario({
      userMessage: 'are my workflows running okay?',
      enclaveName: 'staging-enclave',
      mcpResponses: {
        wf_health_enclave: [
          {
            workflows: [
              { name: 'batch-processor', healthy: true, message: 'Running' },
            ],
          },
        ],
        wf_list: [[{ name: 'batch-processor', ready: true }]],
      },
      timeoutMs: 60000,
    });

    expect(result.outbound.length).toBeGreaterThanOrEqual(1);

    // Any health tool called must use the correct enclave name
    const healthCalls = result.mcpCalls.filter(
      (c) => c.tool === 'wf_health_enclave' || c.tool === 'wf_list',
    );
    expect(healthCalls.length).toBeGreaterThanOrEqual(1);

    for (const call of healthCalls) {
      expect(call.params['enclave']).toBe('staging-enclave');
    }
  }, 90000);
});
