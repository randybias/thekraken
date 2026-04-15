/**
 * Scenario 8: Workflow Troubleshooting via Logs
 *
 * Real-LLM scenario test: user says "The pr-review workflow didn't fire. Why?"
 * Mock wf_logs returns realistic error logs mentioning GITHUB_TOKEN missing.
 *
 * Expected behaviour: agent fetches logs, identifies the root cause (missing
 * env var), and suggests how to fix it.
 *
 * Assert:
 *   - Agent calls wf_logs
 *   - Response mentions GITHUB_TOKEN (the root cause from logs)
 *   - Response includes a suggestion / next step
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

describe('Scenario 8: workflow troubleshooting via logs', () => {
  it('agent fetches logs, identifies missing env var, and suggests fix', async (ctx) => {
    await requireApiKey(ctx);

    const result = await runScenario({
      userMessage: "The pr-review workflow didn't fire. Why?",
      enclaveName: 'test-enclave',
      mcpResponses: {
        wf_list: [
          [
            {
              name: 'pr-review',
              ready: false,
              phase: 'Error',
              message: 'CrashLoopBackOff',
            },
          ],
        ],
        wf_logs: [
          {
            lines: [
              '2026-04-14T10:00:00Z INFO  Starting pr-review workflow v1.2.0',
              '2026-04-14T10:00:01Z INFO  Loading configuration...',
              '2026-04-14T10:00:01Z ERROR Error: missing required environment variable: GITHUB_TOKEN',
              '2026-04-14T10:00:01Z ERROR Workflow startup failed: configuration incomplete',
              '2026-04-14T10:00:01Z FATAL Exiting with code 1',
            ],
          },
        ],
        wf_describe: [
          {
            name: 'pr-review',
            enclave: 'test-enclave',
            status: 'error',
            requiredSecrets: ['GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET'],
          },
        ],
      },
      timeoutMs: 60000,
      minOutboundRecords: 1,
      extraSystemPrompt: `## Troubleshooting Guidance
When a user asks why a workflow isn't running, fetch its logs with wf_logs.
Identify any error messages in the logs and explain the root cause in plain language.
Suggest concrete next steps to fix the issue.`,
    });

    console.log(
      `[scenario:workflow-troubleshooting] duration=${result.durationMs}ms, exitCode=${result.exitCode}`,
    );
    console.log(
      `[scenario:workflow-troubleshooting] mcpCalls: ${JSON.stringify(result.mcpCalls.map((c) => c.tool))}`,
    );
    if (result.outbound.length > 0) {
      console.log(
        `[scenario:workflow-troubleshooting] outbound[0].text: ${result.outbound[0]?.text}`,
      );
    }

    // Agent must respond
    expect(result.outbound.length).toBeGreaterThanOrEqual(1);

    // Agent must have called wf_logs
    const logCalls = result.mcpCalls.filter((c) => c.tool === 'wf_logs');
    expect(logCalls.length).toBeGreaterThanOrEqual(1);

    const allText = result.outbound.map((r) => r.text ?? '').join('\n');

    // Must identify the root cause from the logs
    expect(allText.toUpperCase()).toContain('GITHUB_TOKEN');

    // Must suggest a fix (not just describe the problem)
    const hasSuggestion =
      allText.toLowerCase().includes('set') ||
      allText.toLowerCase().includes('add') ||
      allText.toLowerCase().includes('configure') ||
      allText.toLowerCase().includes('secret') ||
      allText.toLowerCase().includes('environment') ||
      allText.toLowerCase().includes('missing') ||
      allText.toLowerCase().includes('need') ||
      allText.toLowerCase().includes('require');
    expect(hasSuggestion).toBe(true);
  }, 90000);
});
