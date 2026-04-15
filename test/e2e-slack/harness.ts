/**
 * E2E test harness for The Kraken.
 *
 * Boots a SlackDriver with real credentials (or a mock for compile/sanity
 * checks), knows the Kraken bot user ID, and provides helpers used by
 * run-all.ts to execute scenario definitions.
 *
 * Credentials come from the secrets CLI at runtime:
 *   - slack/tentacular-e2e/user-token  (xoxp-... Randy's user token)
 *   - slack/thekraken/bot-token        (xoxb-... Kraken bot token)
 *
 * The Kraken bot user ID is derived at startup via Slack's auth.test API
 * using the bot token. No separate secret is required.
 *
 * If any credential is missing, run() returns a SKIP result.
 *
 * The KRAKEN_E2E_DRY_RUN env var (set to "1") bypasses real Slack calls
 * and uses a mock driver for compile/sanity checks.
 */

import {
  createSlackDriver,
  getSecret,
  type SlackDriver,
} from './slack-driver.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHANNELS = {
  /** Existing enclave channel — auth/scoping/command tests. */
  enclave: 'tentacular-agensys',
  /** New channel for provisioning/deprovisioning tests. */
  test: 'newkraken-test',
} as const;

export const DEFAULT_TIMEOUT_MS = 60_000; // 60s per scenario

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScenarioStatus = 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';

export interface ScenarioResult {
  id: string;
  name: string;
  status: ScenarioStatus;
  durationMs: number;
  notes: string;
  /** The actual reply text from the Kraken (for inspection). */
  replyText?: string;
}

export interface HarnessContext {
  driver: SlackDriver;
  botUserId: string;
  /** Channel IDs (resolved from names at harness boot). */
  channelIds: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Mock driver (for dry-run / compile sanity)
// ---------------------------------------------------------------------------

/**
 * A mock SlackDriver that records calls without hitting real Slack.
 * Used when KRAKEN_E2E_DRY_RUN=1.
 */
export function createMockDriver(
  krakenBotUserId: string = 'U_MOCK_KRAKEN',
): SlackDriver & { calls: string[] } {
  const calls: string[] = [];
  let messageCounter = 0;

  return {
    calls,
    async postAsUser(
      channel: string,
      text: string,
      threadTs?: string,
    ): Promise<string> {
      messageCounter++;
      const ts = `${Date.now()}.${String(messageCounter).padStart(6, '0')}`;
      calls.push(`postAsUser(${channel}, "${text}", ${threadTs ?? 'root'})`);
      return ts;
    },

    async waitForKrakenReply(
      channel: string,
      threadTs: string,
      _timeoutMs: number,
    ): Promise<string> {
      calls.push(`waitForKrakenReply(${channel}, ${threadTs})`);
      // Return a canned response broad enough to pass most scenario pattern checks.
      // Real Kraken responses are evaluated against the live bot in post-deploy runs.
      return (
        `[mock] Here are your workflows in the ${krakenBotUserId} enclave: ` +
        `otel-echo (running), video-ingest (running). ` +
        `You are authenticated as randy. ` +
        `Members: randy@mirantis.com, alice@mirantis.com. ` +
        `Mode updated to team. ` +
        `Logs for otel-echo: [2026-04-14] starting up. ` +
        `Status hello-world: running (deployed). ` +
        `hello-world started. ` +
        `Workflow hello-world logs: no output yet. ` +
        `nonexistent-workflow-xyz-99 not found. ` +
        `I can't show secret values — I can list secret names only. ` +
        `Not an enclave channel. You can provision a new enclave here. ` +
        `Deprovision: to remove this channel as an enclave, confirm with /kraken remove. ` +
        `Build scaffold for hello-world: I'll scaffold that for you.`
      );
    },

    async waitForKrakenReplies(
      channel: string,
      threadTs: string,
      count: number,
      _timeoutMs: number,
    ): Promise<string[]> {
      calls.push(
        `waitForKrakenReplies(${channel}, ${threadTs}, count=${count})`,
      );
      return Array.from({ length: count }, (_, i) => `[mock] Reply ${i + 1}`);
    },

    async resolveBotUserId(): Promise<string> {
      calls.push('resolveBotUserId()');
      return krakenBotUserId;
    },
  };
}

// ---------------------------------------------------------------------------
// Channel ID resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a channel name to its Slack channel ID using conversations.list.
 * Returns null if not found.
 *
 * NOTE: The user token must have channels:read scope. Public channels are
 * readable; private channels require groups:read scope.
 */
async function resolveChannelId(
  driver: SlackDriver,
  channelName: string,
): Promise<string | null> {
  // We reach into the driver's underlying WebClient via a workaround:
  // the driver doesn't expose conversations.list, so we import directly.
  // In dry-run mode this isn't called.
  const { WebClient } = await import('@slack/web-api');
  const token = process.env['KRAKEN_E2E_USER_TOKEN'];
  if (!token) return null;
  const client = new WebClient(token);
  void driver; // driver passed for consistency, not used here

  try {
    const result = await client.conversations.list({
      types: 'public_channel,private_channel',
      limit: 200,
    });
    if (!result.ok || !result.channels) return null;
    const found = result.channels.find((c) => c.name === channelName);
    return found?.id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Harness boot
// ---------------------------------------------------------------------------

export interface HarnessBootResult {
  ctx: HarnessContext | null;
  /** Reason harness could not boot (credentials missing, dry-run, etc.). */
  skipReason?: string;
}

/**
 * Boot the E2E harness.
 *
 * Returns ctx=null with a skipReason if credentials are unavailable or
 * KRAKEN_E2E_DRY_RUN=1 is set (dry-run uses mock driver).
 *
 * When ctx is null and skipReason is absent, it means dry-run mode is
 * active and a mock context was returned.
 */
export async function bootHarness(): Promise<HarnessBootResult> {
  const isDryRun = process.env['KRAKEN_E2E_DRY_RUN'] === '1';

  if (isDryRun) {
    const mockDriver = createMockDriver('U_MOCK_KRAKEN');
    const ctx: HarnessContext = {
      driver: mockDriver,
      botUserId: 'U_MOCK_KRAKEN',
      channelIds: {
        [CHANNELS.enclave]: 'C_MOCK_ENCLAVE',
        [CHANNELS.test]: 'C_MOCK_TEST',
      },
    };
    return { ctx };
  }

  // Retrieve credentials from secrets CLI
  const [userToken, botToken] = await Promise.all([
    getSecret('slack/tentacular-e2e/user-token'),
    getSecret('slack/thekraken/bot-token'),
  ]);

  if (!userToken) {
    return {
      ctx: null,
      skipReason:
        'slack/tentacular-e2e/user-token not available — run `secrets get slack/tentacular-e2e/user-token` to verify',
    };
  }

  if (!botToken) {
    return {
      ctx: null,
      skipReason:
        'slack/thekraken/bot-token not available — run `secrets get slack/thekraken/bot-token` to verify',
    };
  }

  // Derive the bot user ID via auth.test — one round-trip, <500ms.
  let botUserId: string;
  try {
    const { WebClient } = await import('@slack/web-api');
    const botClient = new WebClient(botToken);
    const authResult = await botClient.auth.test();
    if (!authResult.ok || !authResult.user_id) {
      return {
        ctx: null,
        skipReason: `auth.test failed for bot token: ${authResult.error ?? 'no user_id returned'}`,
      };
    }
    botUserId = authResult.user_id;
    console.log(`[harness] Bot user ID resolved via auth.test: ${botUserId}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ctx: null,
      skipReason: `auth.test call failed: ${msg}`,
    };
  }

  // Export for channel resolution
  process.env['KRAKEN_E2E_USER_TOKEN'] = userToken;

  const driver = createSlackDriver({
    userToken,
    botToken,
    krakenBotUserId: botUserId,
  });

  // Resolve channel IDs
  const enclaveChannelId = await resolveChannelId(driver, CHANNELS.enclave);
  const testChannelId = await resolveChannelId(driver, CHANNELS.test);

  if (!enclaveChannelId) {
    console.warn(
      `[harness] Could not resolve channel #${CHANNELS.enclave} — some scenarios will be skipped`,
    );
  }
  if (!testChannelId) {
    console.warn(
      `[harness] Could not resolve channel #${CHANNELS.test} — provisioning scenarios will be skipped`,
    );
  }

  const channelIds: Record<string, string> = {};
  if (enclaveChannelId) channelIds[CHANNELS.enclave] = enclaveChannelId;
  if (testChannelId) channelIds[CHANNELS.test] = testChannelId;

  const ctx: HarnessContext = {
    driver,
    botUserId,
    channelIds,
  };

  return { ctx };
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

/**
 * Run a single scenario definition against the harness context.
 * Returns a ScenarioResult with PASS/FAIL/SKIP/ERROR status.
 */
export async function runScenario(
  ctx: HarnessContext,
  scenario: import('./scenarios.js').ScenarioDef,
): Promise<ScenarioResult> {
  const start = Date.now();

  // Skip if required channel not resolved
  const channelId = ctx.channelIds[scenario.channel];
  if (!channelId) {
    return {
      id: scenario.id,
      name: scenario.name,
      status: 'SKIP',
      durationMs: Date.now() - start,
      notes: `Channel #${scenario.channel} not available`,
    };
  }

  try {
    // Post the initial message
    const threadTs = await ctx.driver.postAsUser(channelId, scenario.message);

    // If there are follow-up messages, send them in the thread
    for (const followUp of scenario.followUpMessages ?? []) {
      // Small delay between messages to avoid rate limiting
      await new Promise<void>((r) => setTimeout(r, 1000));
      await ctx.driver.postAsUser(channelId, followUp, threadTs);
    }

    // Wait for Kraken reply
    const replyCount = scenario.expectedReplyCount ?? 1;
    let replyText: string;

    if (replyCount === 1) {
      replyText = await ctx.driver.waitForKrakenReply(
        channelId,
        threadTs,
        scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
    } else {
      const replies = await ctx.driver.waitForKrakenReplies(
        channelId,
        threadTs,
        replyCount,
        scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      replyText = replies.join('\n\n---\n\n');
    }

    // Evaluate assertions
    const failures: string[] = [];

    for (const pattern of scenario.expectedPatterns ?? []) {
      const regex =
        pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
      if (!regex.test(replyText)) {
        failures.push(
          `Expected pattern "${String(pattern)}" not found in reply`,
        );
      }
    }

    for (const pattern of scenario.forbiddenPatterns ?? []) {
      const regex =
        pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
      if (regex.test(replyText)) {
        failures.push(`Forbidden pattern "${String(pattern)}" found in reply`);
      }
    }

    if (failures.length > 0) {
      return {
        id: scenario.id,
        name: scenario.name,
        status: 'FAIL',
        durationMs: Date.now() - start,
        notes: failures.join('; '),
        replyText,
      };
    }

    return {
      id: scenario.id,
      name: scenario.name,
      status: 'PASS',
      durationMs: Date.now() - start,
      notes: '',
      replyText,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: scenario.id,
      name: scenario.name,
      status: 'ERROR',
      durationMs: Date.now() - start,
      notes: msg,
    };
  }
}
