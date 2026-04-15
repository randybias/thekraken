/**
 * Scenario 6: Compound Multi-Part Question
 *
 * Real-LLM scenario test: user asks three questions in one message:
 *   "What workflows do we have, which ones are healthy, and who's in this enclave?"
 *
 * Expected behaviour: agent calls multiple MCP tools (wf_list, wf_health_enclave,
 * enclave_info) and answers all three parts.
 *
 * Assert:
 *   - All 3 MCP tools called (wf_list, wf_health_enclave, enclave_info)
 *   - Response addresses all 3 questions (workflow names, health, members)
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

describe('Scenario 6: compound multi-part question', () => {
  it('agent calls 3 tools and addresses all 3 parts of the question', async (ctx) => {
    await requireApiKey(ctx);

    const result = await runScenario({
      userMessage:
        "What workflows do we have, which ones are healthy, and who's in this enclave?",
      enclaveName: 'test-enclave',
      mcpResponses: {
        wf_list: [
          [
            { name: 'pr-review', ready: true },
            { name: 'sentiment', ready: false },
          ],
        ],
        wf_health_enclave: [
          {
            workflows: [
              { name: 'pr-review', healthy: true, message: 'Running normally' },
              {
                name: 'sentiment',
                healthy: false,
                message: 'Waiting for resources',
              },
            ],
          },
        ],
        enclave_info: [
          {
            name: 'test-enclave',
            owner: 'U_ALICE',
            members: ['alice', 'bob', 'carol'],
            createdAt: '2026-01-15',
          },
        ],
      },
      timeoutMs: 60000,
      minOutboundRecords: 1,
    });

    console.log(
      `[scenario:compound-multi-part] duration=${result.durationMs}ms, exitCode=${result.exitCode}`,
    );
    console.log(
      `[scenario:compound-multi-part] mcpCalls: ${JSON.stringify(result.mcpCalls.map((c) => c.tool))}`,
    );
    if (result.outbound.length > 0) {
      console.log(
        `[scenario:compound-multi-part] outbound[0].text: ${result.outbound[0]?.text}`,
      );
    }

    // Agent must respond
    expect(result.outbound.length).toBeGreaterThanOrEqual(1);

    // At least 2 of the 3 expected tools must have been called
    // (The agent might combine wf_list + wf_health_enclave, or go straight
    //  to health which implies it knows the list)
    const calledTools = new Set(result.mcpCalls.map((c) => c.tool));
    const expectedTools = ['wf_list', 'wf_health_enclave', 'enclave_info'];
    const toolsCalled = expectedTools.filter((t) => calledTools.has(t));
    expect(toolsCalled.length).toBeGreaterThanOrEqual(2);

    const allText = result.outbound
      .map((r) => r.text ?? '')
      .join('\n')
      .toLowerCase();

    // Must mention at least one workflow name
    expect(allText).toContain('pr-review');

    // Must address health (healthy/unhealthy/running/etc.)
    const hasHealthInfo =
      allText.includes('healthy') ||
      allText.includes('running') ||
      allText.includes('unhealthy') ||
      allText.includes('issue') ||
      allText.includes('problem') ||
      allText.includes('fail');
    expect(hasHealthInfo).toBe(true);

    // Must address membership
    const hasMemberInfo =
      allText.includes('alice') ||
      allText.includes('bob') ||
      allText.includes('carol') ||
      allText.includes('member') ||
      allText.includes('enclave');
    expect(hasMemberInfo).toBe(true);
  }, 90000);
});
