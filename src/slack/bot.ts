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
import { authGate } from '../dispatcher/auth-gate.js';
import type { UserTokenStore } from '../auth/tokens.js';
import { initiateDeviceAuth, pollForToken } from '../auth/oidc.js';
import { postAuthCard } from './auth-card.js';
import { extractSubFromToken, extractEmailFromToken } from '../auth/refresh.js';

const log = createChildLogger({ module: 'slack-bot' });
const tracer = trace.getTracer('thekraken.slack');

export interface SlackBotDeps {
  config: KrakenConfig;
  bindings: EnclaveBindingEngine;
  outbound: OutboundTracker;
  teams: TeamLifecycleManager;
  /** Token store for OIDC token lookup and storage. */
  tokenStore?: UserTokenStore;
  /** MCP call function for authz checks. */
  mcpCall?: (tool: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Slack WebClient for ephemeral posts (auth card, denial messages). */
  slackClient?: {
    chat: {
      postEphemeral: (params: {
        channel: string;
        user: string;
        text: string;
        blocks?: unknown[];
      }) => Promise<unknown>;
    };
  };
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

  // Wire the Bolt client into deps for auth card + denial ephemeral posts (FN-4 fix)
  if (!deps.slackClient) {
    deps.slackClient = app.client as any;
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
  app.event('app_mention', async ({ event, say }) => {
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

        const inbound: InboundEvent = {
          type: 'app_mention',
          channelId,
          threadTs,
          userId,
          text: event.text ?? '',
        };

        const decision = routeEvent(inbound, routerDeps);
        await executeDecision(decision, inbound, deps, say, threadTs);

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
 * Execute a RouteDecision: deterministic actions go directly; smart
 * path delegates to the dispatcher's AgentSession via deps.onSmartPath().
 */
async function executeDecision(
  decision: RouteDecision,
  inbound: InboundEvent,
  deps: SlackBotDeps,
  say: (msg: { text: string; thread_ts: string }) => Promise<unknown>,
  threadTs: string,
): Promise<void> {
  if (decision.path === 'deterministic') {
    const action = decision.action;
    switch (action.type) {
      case 'spawn_and_forward':
      case 'forward_to_active_team': {
        // --- Phase 2 Auth Gate (D6) ---
        // Before dispatching to a team, authenticate + authorize the user.
        // If tokenStore is not wired (e.g., in tests), fall back to empty
        // token (tests mock the auth path separately).
        let userToken = '';

        if (deps.tokenStore && deps.mcpCall) {
          const gateResult = await authGate(
            inbound.userId,
            action.enclaveName,
            inbound.text,
            deps.tokenStore,
            deps.config.oidc,
            deps.mcpCall,
          );

          if (!gateResult.passed) {
            if (gateResult.reason === 'unauthenticated') {
              // Trigger OIDC device flow + ephemeral auth card
              log.info(
                { userId: inbound.userId, enclave: action.enclaveName },
                'user not authenticated, initiating device flow',
              );
              try {
                const deviceAuth = await initiateDeviceAuth(deps.config.oidc);
                // Post ephemeral auth card (only requesting user sees it)
                if (deps.slackClient) {
                  await postAuthCard(deps.slackClient as any, {
                    channel: inbound.channelId,
                    userId: inbound.userId,
                    verificationUri:
                      deviceAuth.verification_uri_complete ??
                      deviceAuth.verification_uri,
                    userCode: deviceAuth.user_code,
                    expiresIn: deviceAuth.expires_in,
                  });
                }
                // Background poll for token (non-blocking)
                void pollForToken(
                  deps.config.oidc,
                  deviceAuth.device_code,
                  deviceAuth.interval ?? 5,
                  deviceAuth.expires_in,
                )
                  .then((tokenResp) => {
                    if (tokenResp && deps.tokenStore) {
                      // Extract sub + email from the JWT for storage
                      const sub =
                        extractSubFromToken(tokenResp.access_token) ?? '';
                      const email =
                        extractEmailFromToken(tokenResp.access_token) ?? '';
                      deps.tokenStore.storeUserToken(
                        inbound.userId,
                        tokenResp,
                        sub,
                        email,
                      );
                      log.info(
                        { userId: inbound.userId },
                        'user authenticated via device flow',
                      );
                    }
                  })
                  .catch((err) => {
                    log.warn(
                      { err, userId: inbound.userId },
                      'device flow failed or timed out',
                    );
                  });
              } catch (err) {
                log.error(
                  { err, userId: inbound.userId },
                  'failed to initiate device auth',
                );
              }
              return; // Do NOT forward to team
            }

            // Denied by authz
            log.info(
              { userId: inbound.userId, enclave: action.enclaveName },
              'user denied by authz',
            );
            // Post ephemeral denial (user-only, friendly message)
            try {
              if (deps.slackClient) {
                await deps.slackClient.chat.postEphemeral({
                  channel: inbound.channelId,
                  user: inbound.userId,
                  text: "You don't have access to perform that action in this enclave. Ask the enclave owner to add you as a member.",
                });
              }
            } catch {
              // Best effort — ephemeral may fail if bot lacks permission
            }
            return; // Do NOT forward to team
          }

          userToken = gateResult.token;
        }

        // --- Dispatch to team with real user token ---
        if (action.type === 'spawn_and_forward') {
          await deps.teams.spawnTeam(
            action.enclaveName,
            inbound.userId,
            userToken,
          );
        }
        deps.teams.sendToTeam(action.enclaveName, {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          from: 'dispatcher',
          type: 'user_message',
          threadTs,
          channelId: inbound.channelId,
          userSlackId: inbound.userId,
          userToken,
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
