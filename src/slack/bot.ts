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
import {
  buildHomeTab,
  buildUnauthenticatedHomeTab,
  type EnclaveData,
} from './home-tab.js';
import { formatAgentResponse } from './formatter.js';
import { authCard } from './cards.js';
import { filterJargon } from '../jargon-filter.js';
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

// A3: explicit intent pattern. In non-enclave channels the bot is passive —
// it responds only when the user clearly asks to initialize / provision the
// channel as an enclave. Everything else is silently ignored.
const PROVISION_PATTERN =
  /\b(initialize|init|provision)\s+(this\s+)?(channel|enclave)\b/i;

// D3: per-user in-flight reconstitution dedup cache.
// Maps userId -> expiry timestamp (ms). Prevents multiple concurrent
// background reconstitutions for the same user within a 30-second window.
// Fire-and-forget — entries expire naturally; no explicit cleanup needed.
export const RECONSTITUTE_IN_FLIGHT = new Map<string, number>();
export const RECONSTITUTE_DEDUP_TTL_MS = 30_000;

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
    mode: 'enclave' | 'dm' | 'provision';
    /** Slack channel name (resolved via API). Present in provisioning mode. */
    channelName?: string;
    /** Authenticated user's OIDC access token (D6). */
    userToken: string;
    /**
     * Prior turns in this thread, oldest first. Omits the current message
     * (which is passed separately via `text`). Empty array for brand-new
     * threads.
     */
    priorTurns: Array<{ role: 'user' | 'assistant'; text: string }>;
  }) => Promise<string | null>;
  /**
   * Returns a valid OIDC access token for the given Slack user ID, or null
   * if the user has not authenticated. Used by the Home Tab handler to
   * decide whether to render the auth prompt or the enclave list.
   */
  getUserToken?: (userId: string) => Promise<string | null>;
  /**
   * Fetch the set of enclaves the given user has access to, along with
   * per-enclave tentacle counts and role. Used by the Home Tab handler.
   * Returns [] if fetching fails.
   */
  getUserEnclaves?: (
    userId: string,
    userToken: string,
  ) => Promise<EnclaveData[]>;
  /**
   * Return an MCP call bound to the current enclave owner's token.
   * Used by drift-sync handlers (channel_rename, member_left,
   * channel_archive) since those events don't come from an
   * authenticated user message. Returns null if the owner isn't
   * authenticated — in which case drift sync is a no-op.
   */
  getMcpCallForEnclaveOwner?: (
    enclaveName: string,
  ) => Promise<
    ((tool: string, params: Record<string, unknown>) => Promise<unknown>) | null
  >;
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
        const token = deps.getUserToken
          ? await deps.getUserToken(userId)
          : null;

        if (!token) {
          await client.views.publish({
            user_id: userId,
            view: buildUnauthenticatedHomeTab(),
          });
          span.setStatus({ code: SpanStatusCode.OK });
          log.info({ userId, state: 'unauth' }, 'home tab published');
          return;
        }

        // Fetch the user's enclaves via MCP. Best-effort: on failure we
        // still render the tab with an empty list so the user isn't
        // stuck on a blank screen.
        const enclaves = deps.getUserEnclaves
          ? await deps.getUserEnclaves(userId, token).catch((err: unknown) => {
              log.warn({ err, userId }, 'home tab: failed to fetch enclaves');
              return [] as EnclaveData[];
            })
          : [];

        const homeTab = buildHomeTab(enclaves);
        await client.views.publish({
          user_id: userId,
          view: homeTab,
        });
        log.info(
          { userId, enclaveCount: enclaves.length, state: 'auth' },
          'home tab published',
        );

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

        // A2: binding check BEFORE auth gate. Pure SQLite lookup — no MCP
        // call, no auth required. This lets non-enclave channels stay
        // silent without ever triggering the device-auth prompt.
        const binding = deps.bindings.lookupEnclave(channelId);

        // A3: non-enclave silence. If the channel is not bound as an
        // enclave, respond ONLY to explicit provision intent. Everything
        // else is ignored — the bot is passive in regular channels.
        if (!binding) {
          // D3: background reconstitution fallback.
          // If the user already has a valid OIDC token (authenticated, no
          // device-auth prompt), fire a background enclave_list lookup to
          // repopulate SQLite. This recovers from PVC loss or cross-instance
          // deploys without blocking the response path or prompting for auth.
          void (async () => {
            const now = Date.now();
            const expiry = RECONSTITUTE_IN_FLIGHT.get(userId);
            if (expiry !== undefined && now < expiry) {
              log.info(
                { userId, channelId },
                'D3: reconstitution already in flight for this user — skipping dedup',
              );
              return;
            }

            // Silent check only — no device-auth flow.
            const existingToken = await getValidTokenForUser(userId);
            if (!existingToken) return;

            if (!deps.getMcpCallForToken) return;

            // Mark in-flight before kicking off the async work.
            RECONSTITUTE_IN_FLIGHT.set(userId, now + RECONSTITUTE_DEDUP_TTL_MS);

            log.info(
              { userId, channelId },
              'D3: user authenticated, binding missing — firing background reconstitution',
            );

            try {
              const mcpCall = deps.getMcpCallForToken(existingToken);
              await deps.bindings.lookupEnclaveWithReconstitute(
                channelId,
                userId,
                mcpCall,
              );
              log.info(
                { userId, channelId },
                'D3: background reconstitution complete',
              );
            } catch (err) {
              log.warn(
                { err, userId, channelId },
                'D3: background reconstitution failed',
              );
            } finally {
              RECONSTITUTE_IN_FLIGHT.delete(userId);
            }
          })();

          if (!PROVISION_PATTERN.test(text)) {
            log.info(
              { channelId, userId },
              'mention in unbound channel — no provision intent, ignoring',
            );
            span.setStatus({ code: SpanStatusCode.OK });
            return;
          }

          // Provision intent detected — now require auth and delegate to
          // the smart-path in provision mode.
          const provisionToken = await checkAuthOrPrompt(
            userId,
            channelId,
            client,
          );
          if (provisionToken === null) return;

          if (deps.onSmartPath) {
            let channelName = channelId;
            try {
              const info = await client.conversations.info({
                channel: channelId,
              });
              channelName =
                (info.channel as { name?: string })?.name ?? channelId;
            } catch {
              // non-fatal
            }
            const provisionReply = await deps.onSmartPath({
              channelId,
              threadTs,
              userId,
              text,
              enclaveName: null,
              mode: 'provision',
              channelName,
              userToken: provisionToken,
              priorTurns: [],
            });
            if (provisionReply) {
              await say({ text: provisionReply, thread_ts: threadTs });
            }
            // After provisioning, attempt to populate the binding
            // (enclave_provision may have just created it).
            const mcpCallForReconstitute =
              deps.getMcpCallForToken?.(provisionToken) ?? deps.mcpCall;
            if (mcpCallForReconstitute) {
              await deps.bindings
                .lookupEnclaveWithReconstitute(
                  channelId,
                  userId,
                  mcpCallForReconstitute,
                )
                .catch(() => null);
            }
          } else {
            await say({
              text: "This channel isn't an enclave yet. DM me to set one up.",
              thread_ts: threadTs,
            });
          }
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        // Binding exists — enclave channel. Auth gate, then route.
        const userToken = await checkAuthOrPrompt(userId, channelId, client);
        if (userToken === null) return;

        // Re-read the binding after the (potentially blocking) auth gate.
        // If the channel was rebound or deprovisioned during device-auth,
        // the pre-auth lookup is stale. Treat disappearance as
        // "no longer an enclave" and silently bail.
        const freshBinding = deps.bindings.lookupEnclave(channelId);
        if (!freshBinding) {
          log.info(
            { channelId, userId },
            'binding disappeared during auth; ignoring',
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        // Command router: deterministic commands handled before team dispatch.
        // (Phase C5 will migrate these into the Enclave Manager; Phase A
        // retains them here to minimize change.)
        const parsed = parseCommand(text);
        if (parsed) {
          // D6: MCP calls MUST carry the authenticated user's OIDC token.
          // No service-token fallback — fail closed if the factory is
          // missing.
          if (!deps.getMcpCallForToken) {
            log.error(
              { userId, channelId },
              'command dispatch aborted: no user-bound MCP client factory (D6)',
            );
            await say({
              text: 'Internal error: command handler is not configured for per-user auth. Please contact the operator.',
              thread_ts: threadTs,
            });
            span.setStatus({ code: SpanStatusCode.OK });
            return;
          }
          const cmdMcpCall = deps.getMcpCallForToken(userToken);
          await executeCommand(parsed, {
            channelId,
            threadTs,
            senderSlackId: userId,
            enclaveName: freshBinding.enclaveName,
            mcpCall: cmdMcpCall,
            sendMessage: async (msgText) => {
              // Command-handler output also goes through jargon filter +
              // Block Kit formatter for consistency with smart-path replies.
              const filtered = filterJargon(msgText);
              let postArgs: {
                channel: string;
                thread_ts: string;
                text: string;
                blocks?: unknown[];
              };
              try {
                const formatted = formatAgentResponse(filtered);
                postArgs = {
                  channel: channelId,
                  thread_ts: threadTs,
                  text: formatted.text,
                  blocks: formatted.blocks,
                };
              } catch {
                postArgs = {
                  channel: channelId,
                  thread_ts: threadTs,
                  text: filtered,
                };
              }
              await client.chat.postMessage(
                postArgs as Parameters<typeof client.chat.postMessage>[0],
              );
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
              return (info.user as { profile?: { email?: string } } | undefined)
                ?.profile?.email;
            },
          });
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
          client,
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

    const ownerMcpCall = deps.getMcpCallForEnclaveOwner
      ? await deps.getMcpCallForEnclaveOwner(binding.enclaveName)
      : null;
    if (!ownerMcpCall) {
      log.info(
        { enclaveName: binding.enclaveName },
        'drift: owner not authenticated; member_left sync skipped',
      );
      return;
    }
    await handleChannelEvent(
      'member_left',
      binding.enclaveName,
      { userId },
      {
        botUserId: deps.botUserId ?? '',
        mcpCall: ownerMcpCall ?? (async () => ({})),
        getEnclaveInfo: async (name) => {
          try {
            const mcpFn = ownerMcpCall ?? (async () => ({}));
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

    const ownerMcpCall = deps.getMcpCallForEnclaveOwner
      ? await deps.getMcpCallForEnclaveOwner(binding.enclaveName)
      : null;
    if (!ownerMcpCall) {
      log.info(
        { enclaveName: binding.enclaveName },
        'drift: owner not authenticated; channel_archive sync skipped',
      );
      return;
    }
    await handleChannelEvent(
      'channel_archive',
      binding.enclaveName,
      {},
      {
        botUserId: deps.botUserId ?? '',
        mcpCall: ownerMcpCall ?? (async () => ({})),
        getEnclaveInfo: async (name) => {
          try {
            const mcpFn = ownerMcpCall ?? (async () => ({}));
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

    const ownerMcpCall = deps.getMcpCallForEnclaveOwner
      ? await deps.getMcpCallForEnclaveOwner(binding.enclaveName)
      : null;
    if (!ownerMcpCall) {
      log.info(
        { enclaveName: binding.enclaveName },
        'drift: owner not authenticated; channel_rename sync skipped',
      );
      return;
    }
    await handleChannelEvent(
      'channel_rename',
      binding.enclaveName,
      { newName },
      {
        botUserId: deps.botUserId ?? '',
        mcpCall: ownerMcpCall ?? (async () => ({})),
        getEnclaveInfo: async (name) => {
          try {
            const mcpFn = ownerMcpCall ?? (async () => ({}));
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

    // CRITICAL: Only process DMs. Channel messages are handled by
    // app_mention (if the bot is @-mentioned). Without this guard,
    // the bot intercepts EVERY message in every channel it belongs
    // to — including random conversations from other users — and
    // fires auth prompts into unrelated threads.
    if (channelType !== 'im') return;

    // Avoid double-firing with app_mention: Slack dispatches both `message`
    // and `app_mention` for a mention in a channel. Let app_mention own
    // those; this handler only covers DMs and non-mention thread replies.
    if (deps.botUserId && text.includes(`<@${deps.botUserId}>`)) return;

    return tracer.startActiveSpan('slack.message', async (span) => {
      span.setAttribute('slack.event_type', 'message');
      span.setAttribute('slack.channel_id', channelId);
      if (threadTs) span.setAttribute('slack.thread_ts', threadTs);

      try {
        // Auth gate (Task 6): verify user has a valid OIDC token before routing.
        const userToken = await checkAuthOrPrompt(userId, channelId, client);
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
          client,
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
  client: WebClient,
): Promise<string | null> {
  const token = await getValidTokenForUser(userId);
  if (token !== null) return token;

  try {
    const deviceAuth = await initiateDeviceAuth();

    // Build a Block Kit auth card (ported from the old Kraken).
    const loginUrl =
      deviceAuth.verification_uri_complete ?? deviceAuth.verification_uri;
    const card = authCard({
      loginUrl,
      userCode: deviceAuth.user_code,
      expiresInSeconds: deviceAuth.expires_in,
    });

    // Post the auth card as an ephemeral message (only visible to this
    // user). Old Kraken pattern: no thread_ts — Slack does not render
    // ephemeral messages reliably inside threads. Posting to the main
    // channel view guarantees the target user sees the card.
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: card.text,
      blocks: card.blocks,
    } as Parameters<typeof client.chat.postEphemeral>[0]);
    log.info({ userId, channelId }, 'device auth prompt sent (ephemeral)');

    // BLOCKING poll: wait for the user to complete auth in their browser.
    // This matches the old Kraken behavior — the handler blocks until
    // auth completes (up to expires_in seconds), then returns the token
    // so the caller can continue processing the ORIGINAL request.
    // Bolt acks the event immediately, so blocking the handler doesn't
    // cause Slack retries.
    try {
      const tokens = await pollForToken(
        deviceAuth.device_code,
        deviceAuth.interval,
        deviceAuth.expires_in,
      );
      storeTokenForUser(userId, tokens);
      log.info({ userId }, 'device auth completed — token stored');
      return tokens.access_token;
    } catch (pollErr) {
      log.warn(
        { err: pollErr, userId },
        'Device auth polling failed or expired',
      );
    }
  } catch (err) {
    log.error({ err, userId }, 'Failed to initiate device auth');
  }

  return null;
}

/**
 * Fetch prior turns in a Slack thread so the dispatcher LLM has
 * conversational memory. Omits the current user message (identified
 * by `currentText`) and filters out non-text/system posts.
 *
 * Returns oldest-first. Best-effort — on failure returns [].
 */
async function fetchThreadTurns(
  channelId: string,
  threadTs: string,
  currentText: string,
  botUserId: string | undefined,
  client: WebClient,
): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  try {
    const result = (await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 30,
    })) as { ok?: boolean; messages?: Array<Record<string, unknown>> };
    if (!result.ok || !result.messages) return [];

    const turns: Array<{ role: 'user' | 'assistant'; text: string }> = [];
    for (const m of result.messages) {
      const text = (m['text'] as string | undefined) ?? '';
      if (!text) continue;
      // Skip the current (latest) user mention — it's passed separately.
      if (text === currentText) continue;
      // Skip ephemeral/system messages
      if (m['subtype']) continue;

      const user = m['user'] as string | undefined;
      const isBot = botUserId && user === botUserId;
      turns.push({
        role: isBot ? 'assistant' : 'user',
        text: text.replace(/^\[e2e-test\]\s*/, '').trim(),
      });
    }
    return turns;
  } catch (err) {
    log.warn({ err, channelId, threadTs }, 'fetchThreadTurns failed');
    return [];
  }
}

/**
 * Execute a RouteDecision: deterministic actions go directly; smart
 * path delegates to the dispatcher's AgentSession via deps.onSmartPath().
 *
 * Task 7: userToken is the real OIDC token, threaded from the auth gate
 * through to mailbox records. The bridge writes it to token.json before
 * each turn (C5/B2); TNTC_ACCESS_TOKEN is not in the subprocess env.
 */
async function executeDecision(
  decision: RouteDecision,
  inbound: InboundEvent,
  deps: SlackBotDeps,
  say: (msg: {
    text: string;
    thread_ts: string;
    blocks?: unknown[];
  }) => Promise<unknown>,
  threadTs: string,
  userToken: string,
  client: WebClient,
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

  // Side-effect: ensure the enclave's team (pi subprocess + NDJSON IPC
  // state) exists. The team is the long-term home for this enclave's
  // multi-turn work; smart path is a shortcut for one-shot reasoning.
  // Spawning here keeps team state warm even while the inline dispatcher
  // LLM handles the current turn.
  if (decision.context.enclaveName) {
    try {
      await deps.teams.spawnTeam(
        decision.context.enclaveName,
        inbound.userId,
        userToken,
      );
    } catch (err) {
      log.warn(
        { err, enclaveName: decision.context.enclaveName },
        'failed to spawn enclave team (non-fatal)',
      );
    }
  }

  // Fetch prior thread turns so the LLM has conversational memory
  // across multiple @mentions in the same thread.
  const priorTurns = await fetchThreadTurns(
    inbound.channelId,
    threadTs,
    inbound.text,
    deps.botUserId,
    client,
  );

  const response = await deps.onSmartPath({
    channelId: inbound.channelId,
    threadTs,
    userId: inbound.userId,
    text: inbound.text,
    enclaveName: decision.context.enclaveName,
    mode: decision.context.mode,
    userToken,
    priorTurns,
  });

  if (response) {
    // Apply the jargon filter before formatting — converts infra-speak
    // (namespace, pod, postgres, etc.) to user-friendly Tentacular vocab.
    const filtered = filterJargon(response);
    // Render as Slack Block Kit so headings, tables, code blocks, and
    // lists come through with proper formatting. The formatter is pure
    // — on failure fall back to raw text.
    let postArgs: { text: string; thread_ts: string; blocks?: unknown[] };
    try {
      const formatted = formatAgentResponse(filtered);
      postArgs = {
        text: formatted.text,
        thread_ts: threadTs,
        blocks: formatted.blocks,
      };
    } catch (err) {
      log.warn({ err }, 'formatter failed; falling back to raw text');
      postArgs = { text: filtered, thread_ts: threadTs };
    }
    const result = await say(postArgs);
    deps.outbound.store(
      inbound.channelId,
      threadTs,
      (result as { ts?: string }).ts ?? '',
      response,
    );
  }
}
