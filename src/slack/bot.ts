/**
 * Slack bot for The Kraken v2 (post-pivot: dispatcher routing).
 *
 * Dual-mode transport controlled by SLACK_MODE env var:
 * - 'http' (production): Bolt ExpressReceiver on port 3000
 * - 'socket' (dev): Bolt SocketModeReceiver + standalone health server
 *
 * Event handlers call routeEvent() (D4 hybrid dispatcher routing) and
 * execute the returned RouteDecision. Deterministic path = no LLM.
 * Smart path = invoke the dispatcher's own pi AgentSession.
 */

import { App, ExpressReceiver } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { Server } from 'node:http';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { healthHandler, createHealthServer } from '../health.js';
import { createChildLogger } from '../logger.js';
import type { KrakenConfig } from '../config.js';
import type { EnclaveBindingEngine } from '../enclave/binding.js';
import type { OutboundTracker } from './outbound.js';
import {
  routeEvent,
  type InboundEvent,
  type RouterDeps,
  type RouteDecision,
} from '../dispatcher/router.js';
import type { TeamLifecycleManager } from '../teams/lifecycle.js';
import { randomUUID } from 'node:crypto';
import {
  getValidTokenForUser,
  initiateDeviceAuth,
  pollForToken,
  storeTokenForUser,
} from '../auth/index.js';

const log = createChildLogger({ module: 'slack-bot' });
const tracer = trace.getTracer('thekraken.slack');

export interface SlackBotDeps {
  config: KrakenConfig;
  bindings: EnclaveBindingEngine;
  outbound: OutboundTracker;
  teams: TeamLifecycleManager;
  /**
   * Called when the smart path is chosen. The dispatcher's AgentSession
   * handles the query and returns a response. Wired in by the main
   * entry point.
   */
  onSmartPath?: (ctx: {
    channelId: string;
    threadTs: string;
    userId: string;
    text: string;
    enclaveName: string | null;
    mode: 'enclave' | 'dm';
  }) => Promise<string>;
}

export interface SlackBot {
  app: App;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Create a Slack bot in the appropriate transport mode.
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
    healthServer = createHealthServer(config.server.port);
  }

  const routerDeps: RouterDeps = {
    bindings: deps.bindings,
    teams: deps.teams,
  };

  registerEventHandlers(app, deps, routerDeps);

  return {
    app,
    async start(): Promise<void> {
      if (config.slack.mode === 'http') {
        await app.start(config.server.port);
      } else {
        await app.start();
      }
      log.info(
        { mode: config.slack.mode, port: config.server.port },
        'Slack bot started',
      );
    },
    async stop(): Promise<void> {
      await app.stop();
      if (healthServer) {
        await new Promise<void>((resolve) =>
          healthServer!.close(() => resolve()),
        );
      }
      log.info('Slack bot stopped');
    },
  };
}

/**
 * Register event handlers on the Bolt app.
 *
 * All event handlers normalize the event into an InboundEvent, call
 * routeEvent() to get a RouteDecision, then execute the decision.
 *
 * D4: Deterministic path = no LLM call, direct action.
 *      Smart path = invoke deps.onSmartPath() which calls the
 *      dispatcher AgentSession.
 */
function registerEventHandlers(
  app: App,
  deps: SlackBotDeps,
  routerDeps: RouterDeps,
): void {
  // ---------------------------------------------------------------------------
  // app_mention — user @mentions the bot in a channel
  // ---------------------------------------------------------------------------
  app.event('app_mention', async ({ event, say, client }) => {
    if ('bot_id' in event) return;

    const threadTs = event.thread_ts ?? event.ts;
    const channelId = event.channel;
    const userId = event.user ?? '';

    return tracer.startActiveSpan('slack.app_mention', async (span) => {
      span.setAttribute('slack.event_type', 'app_mention');
      span.setAttribute('slack.channel_id', channelId);
      span.setAttribute('slack.thread_ts', threadTs);

      try {
        log.info(
          { channelId, threadTs, userId, event: 'app_mention' },
          'mention received',
        );

        // Auth gate (Task 6): verify user has a valid OIDC token before routing.
        const userToken = await checkAuthOrPrompt(
          userId,
          channelId,
          threadTs,
          client,
        );
        if (userToken === null) return;

        const inbound: InboundEvent = {
          type: 'app_mention',
          channelId,
          threadTs,
          userId,
          text: event.text ?? '',
        };

        const decision = routeEvent(inbound, routerDeps);
        await executeDecision(
          decision,
          inbound,
          deps,
          say,
          threadTs,
          userToken,
        );

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
  app.event('message', async ({ event, say, client }) => {
    if ('subtype' in event && event.subtype) return;
    if (!('user' in event)) return;
    if ('bot_id' in event) return;

    const channelId = event.channel;
    const threadTs = ('thread_ts' in event ? event.thread_ts : undefined) as
      | string
      | undefined;
    const userId = event.user as string;
    const text = (('text' in event ? event.text : undefined) as string) ?? '';
    const channelType = (
      'channel_type' in event ? event.channel_type : undefined
    ) as string | undefined;

    return tracer.startActiveSpan('slack.message', async (span) => {
      span.setAttribute('slack.event_type', 'message');
      span.setAttribute('slack.channel_id', channelId);
      if (threadTs) span.setAttribute('slack.thread_ts', threadTs);

      try {
        // Auth gate (Task 6): verify user has a valid OIDC token before routing.
        const userToken = await checkAuthOrPrompt(
          userId,
          channelId,
          threadTs ?? (event as { ts: string }).ts,
          client,
        );
        if (userToken === null) return;

        const inbound: InboundEvent = {
          type: 'message',
          channelId,
          channelType: channelType ?? undefined,
          threadTs: threadTs ?? undefined,
          userId,
          text,
        };

        const decision = routeEvent(inbound, routerDeps);
        await executeDecision(
          decision,
          inbound,
          deps,
          say,
          threadTs ?? (event as { ts: string }).ts,
          userToken,
        );

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

/**
 * Check if a user has a valid OIDC token. If not, initiate device auth and
 * post an ephemeral prompt. Returns the access token on success, null on failure.
 *
 * Task 6: Auth gate. Called by both event handlers before routing.
 */
async function checkAuthOrPrompt(
  userId: string,
  channelId: string,
  threadTs: string,
  client: WebClient,
): Promise<string | null> {
  const token = await getValidTokenForUser(userId);
  if (token !== null) return token;

  // User is not authenticated — start device flow and prompt them.
  try {
    const deviceAuth = await initiateDeviceAuth();

    // Post ephemeral auth prompt — only visible to this user.
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: threadTs,
      text:
        `*Authentication required.* Open the link below and enter the code to connect your account:\n` +
        `*URL:* ${deviceAuth.verification_uri_complete ?? deviceAuth.verification_uri}\n` +
        `*Code:* \`${deviceAuth.user_code}\`\n` +
        `_(This code expires in ${Math.floor(deviceAuth.expires_in / 60)} minutes.)_`,
    });

    // Poll in background — fire and forget.
    pollForToken(
      deviceAuth.device_code,
      deviceAuth.interval,
      deviceAuth.expires_in,
    )
      .then((tokens) => storeTokenForUser(userId, tokens))
      .catch((err: unknown) =>
        log.warn({ err, user: userId }, 'Device auth polling failed'),
      );
  } catch (err) {
    log.error({ err, userId }, 'Failed to initiate device auth');
  }

  return null;
}

/**
 * Execute a RouteDecision: deterministic actions go directly; smart
 * path delegates to the dispatcher's AgentSession via deps.onSmartPath().
 *
 * Task 7: userToken is now the real OIDC token, threaded from the auth gate
 * through to mailbox records so teams receive TNTC_ACCESS_TOKEN.
 */
async function executeDecision(
  decision: RouteDecision,
  inbound: InboundEvent,
  deps: SlackBotDeps,
  say: (msg: { text: string; thread_ts: string }) => Promise<unknown>,
  threadTs: string,
  userToken: string,
): Promise<void> {
  if (decision.path === 'deterministic') {
    const action = decision.action;
    switch (action.type) {
      case 'spawn_and_forward': {
        // Spawn a new team BEFORE writing the first mailbox record.
        // Without this, the mailbox record sits unread (M1 code review fix).
        // D6: userToken is the authenticated user's OIDC token (Task 7).
        await deps.teams.spawnTeam(
          action.enclaveName,
          inbound.userId,
          userToken,
        );
        deps.teams.sendToTeam(action.enclaveName, {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          from: 'dispatcher',
          type: 'user_message',
          threadTs,
          channelId: inbound.channelId,
          userSlackId: inbound.userId,
          userToken, // Task 7: real per-user OIDC token.
          message: inbound.text,
        });
        break;
      }
      case 'forward_to_active_team': {
        deps.teams.sendToTeam(action.enclaveName, {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          from: 'dispatcher',
          type: 'user_message',
          threadTs,
          channelId: inbound.channelId,
          userSlackId: inbound.userId,
          userToken, // Task 7: real per-user OIDC token.
          message: inbound.text,
        });
        break;
      }
      case 'ignore_unbound':
      case 'ignore_bot':
      case 'ignore_visitor':
        // Silently ignored — no response
        break;
      case 'enclave_sync_add':
      case 'enclave_sync_remove':
      case 'enclave_sync_transfer':
      case 'drift_sync':
        // These will be fully implemented in Phase 3 (commands + events).
        // For Phase 1: log and acknowledge.
        log.info(
          { action: action.type, channelId: inbound.channelId },
          'deterministic action deferred to Phase 3',
        );
        break;
    }
    return;
  }

  // --- Smart path: invoke dispatcher LLM ---
  if (!deps.onSmartPath) {
    log.warn(
      { reason: decision.reason },
      'smart path triggered but no handler configured',
    );
    return;
  }

  const response = await deps.onSmartPath({
    channelId: inbound.channelId,
    threadTs,
    userId: inbound.userId,
    text: inbound.text,
    enclaveName: decision.context.enclaveName,
    mode: decision.context.mode,
  });

  if (response) {
    const result = await say({ text: response, thread_ts: threadTs });
    deps.outbound.store(
      inbound.channelId,
      threadTs,
      (result as { ts?: string }).ts ?? '',
      response,
    );
  }
}
