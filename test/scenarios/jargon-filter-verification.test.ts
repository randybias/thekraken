/**
 * Scenario 10: Jargon Filter Verification
 *
 * Real-LLM scenario test: the mock MCP server returns data laden with
 * Kubernetes jargon (pod, container, namespace, replicas, CrashLoopBackOff).
 * The agent's response should translate these to user-friendly terms.
 *
 * Assert:
 *   - Response does NOT contain "pod", "namespace", "container", "kubectl"
 *   - Response DOES contain friendly terms like "workflow", "enclave", "running"
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

describe('Scenario 10: jargon filter verification', () => {
  it('agent translates k8s jargon to friendly terms in response', async (ctx) => {
    await requireApiKey(ctx);

    const result = await runScenario({
      userMessage: "what's the health of my workflows?",
      enclaveName: 'test-enclave',
      mcpResponses: {
        wf_health_enclave: [
          {
            // Data intentionally laden with k8s jargon to test the filter
            namespace: 'test-enclave',
            pods: [
              {
                pod: 'pr-review-pod-abc123',
                container: 'main',
                replicas: 2,
                readyReplicas: 2,
                phase: 'Running',
                healthy: true,
                // User-friendly name provided alongside jargon
                workflowName: 'pr-review',
              },
              {
                pod: 'sentiment-pod-xyz789',
                container: 'main',
                replicas: 1,
                readyReplicas: 0,
                phase: 'CrashLoopBackOff',
                healthy: false,
                workflowName: 'sentiment',
              },
            ],
          },
        ],
      },
      timeoutMs: 60000,
      minOutboundRecords: 1,
    });

    console.log(
      `[scenario:jargon-filter] duration=${result.durationMs}ms, exitCode=${result.exitCode}`,
    );
    if (result.outbound.length > 0) {
      console.log(
        `[scenario:jargon-filter] outbound[0].text: ${result.outbound[0]?.text}`,
      );
    }

    // Agent must respond
    expect(result.outbound.length).toBeGreaterThanOrEqual(1);

    const allText = result.outbound
      .map((r) => r.text ?? '')
      .join('\n')
      .toLowerCase();

    // Must NOT use Kubernetes jargon
    expect(allText).not.toContain('namespace');
    expect(allText).not.toContain('kubectl');
    expect(allText).not.toContain('crashloopbackoff');
    // "pod" as a standalone word — allow "pr-review" which contains no jargon
    expect(allText).not.toMatch(/\bpod\b/);
    expect(allText).not.toMatch(/\bcontainer\b/);
    expect(allText).not.toMatch(/\breplicas\b/);

    // MUST contain user-friendly terms
    expect(allText).toContain('pr-review');
    expect(allText).toContain('sentiment');

    // Must convey health status in friendly language
    const hasHealthStatus =
      allText.includes('running') ||
      allText.includes('healthy') ||
      allText.includes('ok') ||
      allText.includes('good') ||
      allText.includes('fine') ||
      allText.includes('issue') ||
      allText.includes('problem') ||
      allText.includes('down') ||
      allText.includes('fail') ||
      allText.includes('unhealthy');
    expect(hasHealthStatus).toBe(true);
  }, 90000);
});
