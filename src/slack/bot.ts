/**
 * Slack bot for The Kraken v2.
 *
 * Dual-mode transport controlled by SLACK_MODE env var:
 * - 'http' (production): Bolt ExpressReceiver on port 3000
 * - 'socket' (dev): Bolt SocketModeReceiver + standalone health server
 *
 * Event handlers:
 * - app_mention: dispatches to AgentRunner for enclave-bound channels
 * - message: handles DMs and thread replies in active threads
 *
 * All outbound messages are tracked via OutboundTracker for restart dedup.
 */

import { App, ExpressReceiver } from '@slack/bolt';
import type { Server } from 'node:http';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { healthHandler, createHealthServer } from '../health.js';
import { createChildLogger } from '../logger.js';
import type { KrakenConfig } from '../config.js';
import type { AgentRunner } from '../agent/runner.js';
import type { EnclaveBindingEngine } from '../enclave/binding.js';
import type { OutboundTracker } from './outbound.js';

const log = createChildLogger({ module: 'slack-bot' });
const tracer = trace.getTracer('thekraken.slack');

export interface SlackBotDeps {
  config: KrakenConfig;
  runner: AgentRunner;
  bindings: EnclaveBindingEngine;
  outbound: OutboundTracker;
}

export interface SlackBot {
  /** The underlying Bolt App instance. */
  app: App;
  /** Start receiving Slack events. */
  start(): Promise<void>;
  /** Graceful shutdown: stop receiving events, close health server. */
  stop(): Promise<void>;
}

/**
 * Create a Slack bot in the appropriate transport mode.
 *
 * @param deps - Required dependencies.
 * @returns A SlackBot handle with start() and stop() methods.
 */
export function createSlackBot(deps: SlackBotDeps): SlackBot {
  const { config } = deps;
  let healthServer: Server | undefined;
  let app: App;

  if (config.slack.mode === 'http') {
    const receiver = new ExpressReceiver({
      signingSecret: config.slack.signingSecret!,
      endpoints: '/slack/events',
    });
    // Compose health endpoint on Bolt's Express router
    receiver.router.get('/healthz', healthHandler as never);

    app = new App({
      token: config.slack.botToken,
      receiver,
    });
  } else {
    app = new App({
      token: config.slack.botToken,
      appToken: config.slack.appToken,
      socketMode: true,
    });
    // Socket mode: Bolt does not start its own HTTP server
    healthServer = createHealthServer(config.server.port);
  }

  registerEventHandlers(app, deps);

  return {
    app,
    async start(): Promise<void> {
      if (config.slack.mode === 'http') {
        await app.start(config.server.port);
      } else {
        await app.start();
      }
      log.info({ mode: config.slack.mode, port: config.server.port }, 'Slack bot started');
    },
    async stop(): Promise<void> {
      await app.stop();
      if (healthServer) {
        await new Promise<void>((resolve) => healthServer!.close(() => resolve()));
      }
      log.info('Slack bot stopped');
    },
  };
}

/**
 * Register event handlers on the Bolt app.
 *
 * Handles app_mention (enclave channels) and message (DMs + thread replies).
 */
function registerEventHandlers(app: App, deps: SlackBotDeps): void {
  const { runner, bindings, outbound } = deps;

  // ---------------------------------------------------------------------------
  // app_mention — user @mentions the bot in a channel
  // ---------------------------------------------------------------------------
  app.event('app_mention', async ({ event, say }) => {
    // Ignore bot-originated mentions
    if ('bot_id' in event) return;

    const threadTs = event.thread_ts ?? event.ts;
    const channelId = event.channel;
    const userId = event.user ?? '';

    return tracer.startActiveSpan('slack.app_mention', async (span) => {
      span.setAttribute('slack.event_type', 'app_mention');
      span.setAttribute('slack.channel_id', channelId);
      span.setAttribute('slack.thread_ts', threadTs);

      try {
        log.info({ channelId, threadTs, userId, event: 'app_mention' }, 'mention received');

        const binding = bindings.lookupEnclave(channelId);
        if (!binding) {
          log.debug({ channelId }, 'ignoring mention in unbound channel');
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        const response = await runner.handleMessage(
          `${channelId}:${threadTs}`,
          event.text ?? '',
          { enclaveName: binding.enclaveName, slackUserId: userId, mode: 'enclave' },
        );

        const result = await say({ text: response, thread_ts: threadTs });
        outbound.store(channelId, threadTs, (result as { ts?: string }).ts ?? '', response);

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        log.error({ err, channelId, threadTs }, 'error handling app_mention');
        throw err;
      } finally {
        span.end();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // message — DMs and thread replies
  // ---------------------------------------------------------------------------
  app.event('message', async ({ event, say }) => {
    // Only handle user messages (ignore subtypes like bot_message, message_changed, etc.)
    if ('subtype' in event && event.subtype) return;
    if (!('user' in event)) return;
    if ('bot_id' in event) return;

    const channelId = event.channel;
    const threadTs = ('thread_ts' in event ? event.thread_ts : undefined) as string | undefined;
    const userId = event.user as string;

    return tracer.startActiveSpan('slack.message', async (span) => {
      span.setAttribute('slack.event_type', 'message');
      span.setAttribute('slack.channel_id', channelId);
      if (threadTs) span.setAttribute('slack.thread_ts', threadTs);

      try {
        // --- DM handling ---
        if (event.channel_type === 'im') {
          const dmThreadTs = threadTs ?? (event as { ts: string }).ts;
          log.info(
            { channelId, threadTs: dmThreadTs, userId, event: 'dm' },
            'DM received',
          );

          const response = await runner.handleMessage(
            `${channelId}:${dmThreadTs}`,
            ('text' in event ? event.text : undefined) as string ?? '',
            { enclaveName: null, slackUserId: userId, mode: 'dm' },
          );

          const result = await say({ text: response, thread_ts: dmThreadTs });
          outbound.store(channelId, dmThreadTs, (result as { ts?: string }).ts ?? '', response);

          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        // --- Thread reply in enclave channel ---
        // Ignore top-level messages without a prior @mention (no session = no response)
        if (!threadTs) return;

        const binding = bindings.lookupEnclave(channelId);
        if (!binding) {
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        // Only reply in threads where we already have an active session
        const hasSession = runner.hasThread(`${channelId}:${threadTs}`);
        if (!hasSession) {
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        log.info({ channelId, threadTs, userId, event: 'thread_reply' }, 'thread reply');

        const response = await runner.handleMessage(
          `${channelId}:${threadTs}`,
          ('text' in event ? event.text : undefined) as string ?? '',
          { enclaveName: binding.enclaveName, slackUserId: userId, mode: 'enclave' },
        );

        const result = await say({ text: response, thread_ts: threadTs });
        outbound.store(channelId, threadTs, (result as { ts?: string }).ts ?? '', response);

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        log.error({ err, channelId }, 'error handling message');
        throw err;
      } finally {
        span.end();
      }
    });
  });
}
