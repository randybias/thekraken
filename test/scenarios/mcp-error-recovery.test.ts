/**
 * Scenario 9: MCP Error Recovery
 *
 * Real-LLM scenario test: user says "list my workflows" but the MCP server
 * returns an error response instead of the workflow list.
 *
 * Expected behaviour: agent handles the error gracefully and gives a
 * user-friendly explanation — no raw error text, no stack traces, no HTTP
 * status codes surfaced to the user.
 *
 * Assert:
 *   - Response does NOT contain "500", raw "error:", or stack traces
 *   - Response IS user-friendly (explains something went wrong)
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

describe('Scenario 9: MCP error recovery', () => {
  it('agent handles MCP error gracefully without exposing raw error to user', async (ctx) => {
    await requireApiKey(ctx);

    const result = await runScenario({
      userMessage: 'list my workflows',
      enclaveName: 'test-enclave',
      mcpResponses: {
        // Return an error response — simulates MCP server failure
        wf_list: [
          {
            error: 'internal server error',
            code: 500,
            message: 'Error: database connection failed at db.go:347',
            stack:
              'goroutine 42 [running]:\ngithub.com/randybias/tentacular-mcp/pkg/tools.ListWorkflows()\n\tdb.go:347 +0x1a4\n',
          },
        ],
      },
      timeoutMs: 75000,
      minOutboundRecords: 1,
      extraSystemPrompt: `## Error Handling
When a tool call returns an error, do NOT retry the same tool call.
Do NOT copy the raw error, stack trace, or HTTP status code into your response.
Instead: IMMEDIATELY write to outbound.ndjson acknowledging the issue in plain English
and suggest the user try again or contact support if it persists. Then exit.`,
    });

    console.log(
      `[scenario:mcp-error-recovery] duration=${result.durationMs}ms, exitCode=${result.exitCode}`,
    );
    if (result.outbound.length > 0) {
      console.log(
        `[scenario:mcp-error-recovery] outbound[0].text: ${result.outbound[0]?.text}`,
      );
    }

    // Agent must respond
    expect(result.outbound.length).toBeGreaterThanOrEqual(1);

    const allText = result.outbound
      .map((r) => r.text ?? '')
      .join('\n')
      .toLowerCase();

    // Must NOT expose raw error details to user
    expect(allText).not.toContain('500');
    expect(allText).not.toContain('goroutine');
    expect(allText).not.toContain('db.go');
    expect(allText).not.toMatch(/\berror: /);
    expect(allText).not.toContain('database connection failed');

    // Must give a user-friendly response
    const hasFriendlyResponse =
      allText.includes('trouble') ||
      allText.includes('issue') ||
      allText.includes('problem') ||
      allText.includes('unavailable') ||
      allText.includes('try again') ||
      allText.includes('unable') ||
      allText.includes('something went wrong') ||
      allText.includes('not available') ||
      allText.includes("can't") ||
      allText.includes('cannot') ||
      allText.includes('sorry');
    expect(hasFriendlyResponse).toBe(true);
  }, 120000);
});
