/**
 * Slack driver for E2E tests.
 *
 * Posts messages as Randy (the platform user) via a real Slack user token
 * (xoxp-...) and reads Kraken bot replies via the bot token or the same
 * user token (conversations.replies is readable with either).
 *
 * Design:
 * - postAsUser: uses the xoxp user token to post chat messages
 * - waitForKrakenReply: polls conversations.replies for a message from the
 *   known Kraken bot user ID, filtered to the given thread
 *
 * Safety: all test messages are prefixed with "[e2e-test]" so humans can
 * identify them in Slack. Production channels should never be in E2E_CHANNELS.
 */

import {
  WebClient,
  type ConversationsRepliesResponse,
  type ChatPostMessageArguments,
} from '@slack/web-api';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackDriverOptions {
  /** Slack user OAuth token (xoxp-...). Used for posting as Randy. */
  userToken: string;
  /** Slack bot token (xoxb-...) for reading replies. Falls back to userToken. */
  botToken?: string;
  /** The Kraken's Slack bot user ID (e.g. U_BOT123). Required to filter replies. */
  krakenBotUserId: string;
  /** Whether to prefix messages with "[e2e-test]". Default: true. */
  testPrefix?: boolean;
  /** Poll interval in ms. Default: 1500. */
  pollIntervalMs?: number;
}

export interface SlackDriver {
  /**
   * Post a message as Randy in a channel.
   * Returns the message ts (timestamp/ID).
   */
  postAsUser(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<string>;

  /**
   * Wait for a single reply from the Kraken bot in a thread.
   * Polls every pollIntervalMs until a Kraken message appears.
   * Throws on timeout.
   */
  waitForKrakenReply(
    channel: string,
    threadTs: string,
    timeoutMs: number,
  ): Promise<string>;

  /**
   * Wait for `count` replies from the Kraken bot in a thread.
   * Returns them in the order they appear (oldest first).
   * Throws on timeout.
   */
  waitForKrakenReplies(
    channel: string,
    threadTs: string,
    count: number,
    timeoutMs: number,
  ): Promise<string[]>;

  /**
   * Resolve the current bot user ID for the given bot token via auth.test.
   * Useful when krakenBotUserId is not known at startup.
   */
  resolveBotUserId(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createSlackDriver(opts: SlackDriverOptions): SlackDriver {
  const {
    userToken,
    botToken,
    krakenBotUserId,
    testPrefix = true,
    pollIntervalMs = 1500,
  } = opts;

  // Use userToken for posting, botToken (or userToken) for reading
  const posterClient = new WebClient(userToken);
  const readerClient = botToken ? new WebClient(botToken) : posterClient;

  function prefixed(text: string): string {
    return testPrefix ? `[e2e-test] ${text}` : text;
  }

  async function postAsUser(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<string> {
    const payload: ChatPostMessageArguments = {
      channel,
      text: prefixed(text),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    };

    const result = await posterClient.chat.postMessage(payload);

    if (!result.ok || !result.ts) {
      throw new Error(
        `chat.postMessage failed: ${result.error ?? 'unknown error'}`,
      );
    }

    return result.ts as string;
  }

  async function getKrakenReplies(
    channel: string,
    threadTs: string,
  ): Promise<string[]> {
    let result: ConversationsRepliesResponse;
    try {
      result = await readerClient.conversations.replies({
        channel,
        ts: threadTs,
        limit: 20,
      });
    } catch (err: unknown) {
      // not_in_channel or channel_not_found — rethrow with context
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`conversations.replies failed for ${channel}: ${msg}`);
    }

    if (!result.ok || !result.messages) {
      return [];
    }

    return result.messages
      .filter(
        (m) =>
          m.user === krakenBotUserId || m.bot_id !== undefined,
      )
      .filter((m) => m.user === krakenBotUserId)
      .map((m) => m.text ?? '');
  }

  async function waitForKrakenReply(
    channel: string,
    threadTs: string,
    timeoutMs: number,
  ): Promise<string> {
    const replies = await waitForKrakenReplies(channel, threadTs, 1, timeoutMs);
    const first = replies[0];
    if (first === undefined) {
      throw new Error(
        `waitForKrakenReply: no reply received within ${timeoutMs}ms`,
      );
    }
    return first;
  }

  async function waitForKrakenReplies(
    channel: string,
    threadTs: string,
    count: number,
    timeoutMs: number,
  ): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    let lastCount = 0;

    while (Date.now() < deadline) {
      const replies = await getKrakenReplies(channel, threadTs);
      if (replies.length >= count) {
        return replies.slice(0, count);
      }
      if (replies.length > lastCount) {
        lastCount = replies.length;
        // Got some replies, but not enough yet — keep polling
      }
      await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
    }

    // One final check
    const final = await getKrakenReplies(channel, threadTs);
    if (final.length >= count) {
      return final.slice(0, count);
    }

    throw new Error(
      `waitForKrakenReplies: expected ${count} replies, got ${final.length} ` +
        `in channel ${channel} thread ${threadTs} after ${timeoutMs}ms`,
    );
  }

  async function resolveBotUserId(): Promise<string> {
    const readToken = botToken ?? userToken;
    const client = new WebClient(readToken);
    const result = await client.auth.test();
    if (!result.ok || !result.user_id) {
      throw new Error(`auth.test failed: ${result.error ?? 'unknown'}`);
    }
    return result.user_id as string;
  }

  return {
    postAsUser,
    waitForKrakenReply,
    waitForKrakenReplies,
    resolveBotUserId,
  };
}

// ---------------------------------------------------------------------------
// Token retrieval
// ---------------------------------------------------------------------------

/**
 * Retrieve a secret via the ~/global-bin/secrets CLI.
 * Returns null if the secret is unavailable (test will skip).
 */
export async function getSecret(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      '/usr/bin/env',
      ['sh', '-c', `~/global-bin/secrets get ${path}`],
      {
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env['HOME'] ?? '/home/node',
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );

    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });

    proc.on('close', (code) => {
      const value = output.trim();
      if (code === 0 && value) {
        resolve(value);
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => resolve(null));

    setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 8000);
  });
}
