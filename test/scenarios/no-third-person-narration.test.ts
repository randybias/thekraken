/**
 * Scenario 14: No Third-Person Narration
 *
 * Production bug from old Kraken Slack conversations:
 *
 *   User: @The Kraken are you there?
 *   Agent: Got it, working on this now.
 *   Agent: I've responded to Randy in the #tentacular-agensys Slack channel,
 *          letting him know I'm online and ready to help!
 *
 * The agent described its own action ("I've responded to Randy") instead of
 * just responding directly ("Yes, I'm here!"). This is a meta-narration bug:
 * the agent talks about what it's doing rather than just doing it.
 *
 * Three simple presence/greeting prompts test different entry points for
 * this narration pattern.
 *
 * Assert for each:
 *   - Agent responds DIRECTLY in first person
 *   - Response does NOT contain third-person narration patterns:
 *     "I've responded to <name>", "I've let <name> know",
 *     "I've replied in the <channel>", "I've informed the user",
 *     "I've sent a message to"
 *   - Response DOES contain first-person direct engagement
 *
 * If this test FAILS, it means the bug is real. DO NOT modify the assertions.
 * The jargon filter or system prompt needs updating to catch these patterns.
 *
 * Cost: ~$0.06-0.10 per run (3 variations).
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

/**
 * Check that the agent's response is direct and does not contain
 * third-person narration patterns from the production bug.
 */
function assertNoNarration(
  allText: string,
  userSlackHandle: string,
  channelName: string,
): void {
  // Must NOT contain narration patterns
  // Pattern: "I've responded to <name>"
  expect(allText).not.toMatch(/i'?ve\s+responded\s+to\s+\w/i);

  // Pattern: "I've let <name> know"
  expect(allText).not.toMatch(/i'?ve\s+let\s+\w+\s+know/i);

  // Pattern: "I've informed"
  expect(allText).not.toMatch(/i'?ve\s+informed/i);

  // Pattern: "I've sent a message to"
  expect(allText).not.toMatch(/i'?ve\s+sent\s+a\s+message\s+to/i);

  // Pattern: "I've replied in the <channel>"
  expect(allText).not.toMatch(/i'?ve\s+replied\s+in\s+the/i);

  // Pattern: "I've notified"
  expect(allText).not.toMatch(/i'?ve\s+notified/i);

  // Specific patterns from the actual bug report
  if (userSlackHandle) {
    // "letting him/her/them know I'm..."
    expect(allText).not.toMatch(/letting\s+\w+\s+know/i);
  }
  if (channelName) {
    // "in the #channel-name" (narrating the channel being responded in)
    expect(allText).not.toMatch(new RegExp(`in the #?${channelName}`, 'i'));
  }

  // Must contain SOMETHING (agent responded at all)
  expect(allText.trim().length).toBeGreaterThan(0);

  // Must contain first-person direct engagement
  // Accept a range of phrasings: "yes", "hello", "hi", "I'm here", "I can", "how can I"
  const hasDirectResponse =
    allText.includes("i'm") ||
    allText.includes('yes') ||
    allText.includes('hello') ||
    allText.includes('hi') ||
    allText.includes('how can i') ||
    allText.includes("i'm here") ||
    allText.includes('ready') ||
    allText.includes('here') ||
    allText.includes('help') ||
    allText.includes('sure');
  expect(hasDirectResponse).toBe(true);
}

// ---------------------------------------------------------------------------
// Scenario 14: No third-person narration
// ---------------------------------------------------------------------------

describe('Scenario 14: no third-person narration (production bug)', () => {
  it('"are you there?" gets a direct first-person response, no narration', async (ctx) => {
    await requireApiKey(ctx);

    const result = await runScenario({
      userMessage: 'are you there?',
      enclaveName: 'tentacular-agensys',
      mcpResponses: {},
      timeoutMs: 60000,
      minOutboundRecords: 1,
    });

    console.log(
      `[scenario:no-narration] "are you there?" duration=${result.durationMs}ms`,
    );
    if (result.outbound.length > 0) {
      console.log(
        `[scenario:no-narration] outbound[0].text: ${result.outbound[0]?.text}`,
      );
    }

    expect(result.outbound.length).toBeGreaterThanOrEqual(1);

    const allText = result.outbound
      .map((r) => r.text ?? '')
      .join('\n')
      .toLowerCase();

    assertNoNarration(allText, 'user', 'tentacular-agensys');
  }, 90000);

  it('"hello" gets a direct first-person response, no narration', async (ctx) => {
    await requireApiKey(ctx);

    const result = await runScenario({
      userMessage: 'hello',
      enclaveName: 'tentacular-agensys',
      mcpResponses: {},
      timeoutMs: 60000,
      minOutboundRecords: 1,
    });

    console.log(
      `[scenario:no-narration] "hello" duration=${result.durationMs}ms`,
    );
    if (result.outbound.length > 0) {
      console.log(
        `[scenario:no-narration] outbound[0].text: ${result.outbound[0]?.text}`,
      );
    }

    expect(result.outbound.length).toBeGreaterThanOrEqual(1);

    const allText = result.outbound
      .map((r) => r.text ?? '')
      .join('\n')
      .toLowerCase();

    assertNoNarration(allText, 'user', 'tentacular-agensys');
  }, 90000);

  it('"can you help me?" gets a direct first-person response, no narration', async (ctx) => {
    await requireApiKey(ctx);

    const result = await runScenario({
      userMessage: 'can you help me?',
      enclaveName: 'tentacular-agensys',
      mcpResponses: {},
      timeoutMs: 60000,
      minOutboundRecords: 1,
    });

    console.log(
      `[scenario:no-narration] "can you help me?" duration=${result.durationMs}ms`,
    );
    if (result.outbound.length > 0) {
      console.log(
        `[scenario:no-narration] outbound[0].text: ${result.outbound[0]?.text}`,
      );
    }

    expect(result.outbound.length).toBeGreaterThanOrEqual(1);

    const allText = result.outbound
      .map((r) => r.text ?? '')
      .join('\n')
      .toLowerCase();

    assertNoNarration(allText, 'user', 'tentacular-agensys');
  }, 90000);
});
