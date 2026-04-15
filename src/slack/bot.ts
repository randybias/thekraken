/**
 * Slack bot for The Kraken (post-pivot: dispatcher routing).
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
import { makeHealthHandler, createHealthServer } from '../health.js';
import { createChildLogger } from '../logger.js';
import type Database from 'better-sqlite3';
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
import { buildHomeTab, buildUnauthenticatedHomeTab } from './home-tab.js';
import { randomUUID } from 'node:crypto';
import {
  extractEmailFromToken,
  getValidTokenForUser,
  initiateDeviceAuth,
  pollForToken,
  storeTokenForUser,
} from '../auth/index.js';
import { parseCommand, executeCommand } from '../enclave/commands.js';
import { handleChannelEvent } from '../enclave/drift.js';

const log = createChildLogger({ module: 'slack-bot' });
const tracer = trace.getTracer('thekraken.slack');

export interface SlackBotDeps {
  config: KrakenConfig;
  bindings: EnclaveBindingEngine;
  outbound: OutboundTracker;
  teams: TeamLifecycleManager;
  /** Open SQLite database, forwarded to the health handler. Optional. */
  db?: Database.Database;
  /**
   * Slack bot user ID (e.g. "U012ABC"). Used by channel event handlers to
   * distinguish the bot's own join/leave events from user events.
   * Optional — if not provided, channel event handlers skip bot-guard checks.
   */
  botUserId?: string;
  /**
   * MCP call function. Used by command and channel event handlers to call
   * enclave_sync and other MCP tools. Optional in Phase 1 (no OIDC).
   */
  mcpCall?: (tool: string, params: Record<string, unknown>) => Promise<unknown>;
  /**
   * Factory that produces a per-user-token MCP call function.
   * Used by lazy enclave binding reconstitution so MCP calls carry the
   * authenticated user's OIDC token (D6 — no service token).
   *
   * If not provided, reconstitution falls back to deps.mcpCall.
   */
  getMcpCallForToken?: (
    userToken: string,
  ) => (tool: string, params: Record<string, unknown>) => Promise<unknown>;
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
  /**
   * Returns a valid OIDC access token for the given Slack user ID, or null
   * if the user has not authenticated. Wired in by the main entry point.
   * Phase 2: populated from the token store. Phase 1: always returns null.
   */
  getUserToken?: (userId: string) => Promise<string | null>;
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
    receiver.router.get('/healthz', makeHealthHandler(deps.db) as never);

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
    healthServer = createHealthServer(config.server.port, deps.db);
  }

  const routerDeps: RouterDeps = {
    bindings: deps.bindings,
    teams: deps.teams,
  };

  registerEventHandlers(app, deps, routerDeps);

  return {
    app,
    async start(): Promise<void> {
      // Auto-resolve botUserId from the bot token if not provided. This
      // enables the self-loop guard without requiring manual config.
      if (!deps.botUserId) {
        try {
          const authResult = await app.client.auth.test();
          if (authResult.ok && authResult.user_id) {
            deps.botUserId = authResult.user_id;
            log.info(
              { botUserId: deps.botUserId },
              'resolved bot user id from auth.test',
            );
          }
        } catch (err) {
          log.warn({ err }, 'auth.test failed — self-loop guard will not work');
        }
      }

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
  // app_home_opened — render the App Home tab for a user
  // ---------------------------------------------------------------------------
  app.event('app_home_opened', async ({ event, client }) => {
    const userId = event.user;

    return tracer.startActiveSpan('slack.app_home_opened', async (span) => {
      span.setAttribute('slack.event_type', 'app_home_opened');
      span.setAttribute('slack.user_id', userId);

      try {
        // Check if user has a valid OIDC token (Phase 2: real token store).
        // Phase 1: getUserToken is not wired, so always show unauthenticated tab.
        const token = deps.getUserToken
          ? await deps.getUserToken(userId)
          : null;

        if (!token) {
          await client.views.publish({
            user_id: userId,
            view: buildUnauthenticatedHomeTab(),
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        // Build with empty enclaves. Data fetching via MCP comes in Phase 3.
        const homeTab = buildHomeTab([]);
        await client.views.publish({
          user_id: userId,
          view: homeTab,
        });

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        log.error({ err, userId }, 'error rendering home tab');
        throw err;
      } finally {
        span.end();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // app_mention — user @mentions the bot in a channel
  // ---------------------------------------------------------------------------
  app.event('app_mention', async ({ event, client, say }) => {
    const threadTs = event.thread_ts ?? event.ts;
    const channelId = event.channel;
    const userId = event.user ?? '';
    const text = event.text ?? '';

    // Self-loop guard: never process our own bot's posts. Other bots are fine.
    if (userId && deps.botUserId && userId === deps.botUserId) return;

    return tracer.startActiveSpan('slack.app_mention', async (span) => {
      span.setAttribute('slack.event_type', 'app_mention');
      span.setAttribute('slack.channel_id', channelId);
      span.setAttribute('slack.thread_ts', threadTs);

      try {
        log.info(
          { channelId, threadTs, userId, event: 'app_mention' },
          'mention received',
        );

        // Auth gate: verify user has a valid OIDC token before routing.
        const userToken = await checkAuthOrPrompt(
          userId,
          channelId,
          threadTs,
          client,
        );
        if (userToken === null) return;

        // Lazy binding reconstitution: if no binding exists in SQLite, attempt
        // to discover it from MCP using the authenticated user's OIDC token.
        // This recovers state after a PVC reset without requiring a service token.
        if (deps.bindings.lookupEnclave(channelId) === null) {
          const mcpCallForReconstitute =
            deps.getMcpCallForToken?.(userToken) ?? deps.mcpCall;
          if (!mcpCallForReconstitute) {
            log.error(
              { channelId },
              'lazy reconstitute unavailable — deps.getMcpCallForToken and deps.mcpCall both undefined',
            );
            await say({
              text: 'Internal error: MCP client not wired. Please contact support.',
              thread_ts: threadTs,
            });
            span.setStatus({ code: SpanStatusCode.OK });
            return;
          }
          log.info(
            { channelId, userId },
            'lazy reconstitute: looking up enclave binding via MCP',
          );
          const reconstituted =
            await deps.bindings.lookupEnclaveWithReconstitute(
              channelId,
              userId,
              mcpCallForReconstitute,
            );
          if (reconstituted === null) {
            log.info(
              { channelId },
              'lazy reconstitute: channel is not an enclave',
            );
            await say({
              text: "This channel isn't an enclave. I can only help in channels that are connected to a Tentacular enclave.",
              thread_ts: threadTs,
            });
            span.setStatus({ code: SpanStatusCode.OK });
            return;
          }
          log.info(
            {
              channelId,
              enclaveName: reconstituted.enclaveName,
            },
            'lazy reconstitute: binding recovered',
          );
        }

        // Command router: deterministic commands handled before team dispatch.
        const parsed = parseCommand(text);
        if (parsed) {
          const binding = deps.bindings.lookupEnclave(channelId);
          if (binding) {
            // D6: use the authenticated user's OIDC token for MCP calls.
            const cmdMcpCall =
              deps.getMcpCallForToken?.(userToken) ??
              deps.mcpCall ??
              (async () => ({}));
            await executeCommand(parsed, {
              channelId,
              threadTs,
              senderSlackId: userId,
              enclaveName: binding.enclaveName,
              mcpCall: cmdMcpCall,
              sendMessage: async (msgText) => {
                await client.chat.postMessage({
                  channel: channelId,
                  thread_ts: threadTs,
                  text: msgText,
                });
              },
              resolveEmail: async (slackUserId) => {
                // For the authenticated sender, extract email from the OIDC
                // JWT (bot token doesn't have users:read.email scope). For
                // other Slack users, fall back to the Slack API.
                if (slackUserId === userId) {
                  const fromJwt = extractEmailFromToken(userToken);
                  if (fromJwt) return fromJwt;
                }
                const info = await client.users.info({ user: slackUserId });
                return (
                  info.user as { profile?: { email?: string } } | undefined
                )?.profile?.email;
              },
            });
            span.setStatus({ code: SpanStatusCode.OK });
            return;
          }
          // Command in unbound channel — silently ignore
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        const inbound: InboundEvent = {
          type: 'app_mention',
          channelId,
          threadTs,
          userId,
          text,
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
  // Channel lifecycle events — member_left_channel, channel_archive,
  // channel_rename. These are best-effort: log failures but do not rethrow.
  // ---------------------------------------------------------------------------

  app.event('member_left_channel', async ({ event, client }) => {
    const channelId = (event as { channel?: string }).channel ?? '';
    const userId = (event as { user?: string }).user;
    const binding = deps.bindings.lookupEnclave(channelId);
    if (!binding) return;

    await handleChannelEvent(
      'member_left',
      binding.enclaveName,
      { userId },
      {
        botUserId: deps.botUserId ?? '',
        mcpCall: deps.mcpCall ?? (async () => ({})),
        getEnclaveInfo: async (name) => {
          try {
            const mcpFn = deps.mcpCall ?? (async () => ({}));
            const r = (await mcpFn('enclave_info', { name })) as {
              owner?: string;
              members?: string[];
            };
            if (!r?.owner) return undefined;
            return { owner: r.owner, members: r.members ?? [] };
          } catch {
            return undefined;
          }
        },
        invalidateCache: () => undefined,
        resolveEmail: async (slackUserId) => {
          const info = await client.users.info({ user: slackUserId });
          return (info.user as { profile?: { email?: string } } | undefined)
            ?.profile?.email;
        },
      },
    );
  });

  app.event('channel_archive', async ({ event }) => {
    const channelId = (event as { channel?: string }).channel ?? '';
    const binding = deps.bindings.lookupEnclave(channelId);
    if (!binding) return;

    await handleChannelEvent(
      'channel_archive',
      binding.enclaveName,
      {},
      {
        botUserId: deps.botUserId ?? '',
        mcpCall: deps.mcpCall ?? (async () => ({})),
        getEnclaveInfo: async (name) => {
          try {
            const mcpFn = deps.mcpCall ?? (async () => ({}));
            const r = (await mcpFn('enclave_info', { name })) as {
              owner?: string;
              members?: string[];
            };
            if (!r?.owner) return undefined;
            return { owner: r.owner, members: r.members ?? [] };
          } catch {
            return undefined;
          }
        },
        invalidateCache: () => undefined,
        resolveEmail: async () => undefined,
      },
    );
  });

  app.event('channel_rename', async ({ event }) => {
    const channelId =
      (event as { channel?: { id?: string; name?: string } }).channel?.id ?? '';
    const newName = (event as { channel?: { name?: string } }).channel?.name;
    const binding = deps.bindings.lookupEnclave(channelId);
    if (!binding) return;

    await handleChannelEvent(
      'channel_rename',
      binding.enclaveName,
      { newName },
      {
        botUserId: deps.botUserId ?? '',
        mcpCall: deps.mcpCall ?? (async () => ({})),
        getEnclaveInfo: async (name) => {
          try {
            const mcpFn = deps.mcpCall ?? (async () => ({}));
            const r = (await mcpFn('enclave_info', { name })) as {
              owner?: string;
              members?: string[];
            };
            if (!r?.owner) return undefined;
            return { owner: r.owner, members: r.members ?? [] };
          } catch {
            return undefined;
          }
        },
        invalidateCache: () => undefined,
        resolveEmail: async () => undefined,
      },
    );
  });

  // ---------------------------------------------------------------------------
  // message — DMs and thread replies
  // ---------------------------------------------------------------------------
  app.event('message', async ({ event, say, client }) => {
    if ('subtype' in event && event.subtype) return;
    if (!('user' in event)) return;

    const channelId = event.channel;
    const threadTs = ('thread_ts' in event ? event.thread_ts : undefined) as
      | string
      | undefined;
    const userId = event.user as string;
    const text = (('text' in event ? event.text : undefined) as string) ?? '';
    const channelType = (
      'channel_type' in event ? event.channel_type : undefined
    ) as string | undefined;

    // Self-loop guard: never process our own bot's posts.
    if (userId && deps.botUserId && userId === deps.botUserId) return;

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
