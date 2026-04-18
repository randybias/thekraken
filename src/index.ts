/**
 * The Kraken — Dispatcher entry point.
 *
 * The Kraken is a specialized pi-coding-agent running in a custom
 * "Slack mode." This entry point:
 *
 *   1. loadConfig()                — fail fast with all missing vars
 *   2. initTelemetry()             — OTel SDK + graceful degradation
 *   3. initDatabase()              — SQLite with FK enforcement
 *   4. TeamLifecycleManager        — per-enclave team spawn/monitor/GC
 *   5. OutboundPoller              — polls team outbound.ndjson → Slack
 *   6. EnclaveBindingEngine        — channel → enclave lookup
 *   7. createSlackBot()            — Bolt app with routeEvent() dispatch
 *   8. Slack connect + startup banner
 *
 * Smart path: When the dispatcher router (D4) decides an event needs
 * LLM reasoning, it invokes onSmartPath() — which calls a pi AgentSession
 * via createAgentSession() with dispatcher-specific tools.
 *
 * D6: Every enclave team subprocess carries the initiating user's
 * OIDC token. There is NO service token concept.
 */

import { loadConfig } from './config.js';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { createChildLogger } from './logger.js';
import { initDatabase } from './db/index.js';
import {
  extractEmailFromToken,
  getValidTokenForUser,
  getUserTokenByEmail,
  initTokenStore,
  startTokenRefreshLoop,
  stopTokenRefreshLoop,
} from './auth/index.js';
import { EnclaveBindingEngine } from './enclave/binding.js';
import { OutboundTracker } from './slack/outbound.js';
import { TeamLifecycleManager } from './teams/lifecycle.js';
import { OutboundPoller } from './teams/outbound-poller.js';
import { createSlackBot } from './slack/bot.js';
import { createMcpConnection } from './agent/mcp-connection.js';
import { runSmartPath } from './dispatcher/smart-path.js';

const log = createChildLogger({ module: 'main' });

async function main(): Promise<void> {
  // 1. Config
  const config = loadConfig();
  log.info('Config loaded');

  // 2. OTel
  initTelemetry();
  log.info('Telemetry initialized');

  // 3. SQLite
  const db = initDatabase(config);
  log.info('Database initialized');

  // 3a. Auth: token store + background refresh loop
  initTokenStore(db);
  startTokenRefreshLoop();
  log.info('Token store and refresh loop initialized');

  // 4. Subsystems
  const bindings = new EnclaveBindingEngine(db);
  const outbound = new OutboundTracker(db);
  const teams = new TeamLifecycleManager(config, db);

  // 5. Slack bot (created first so poller can reference its client)
  const slackBot = createSlackBot({
    config,
    bindings,
    outbound,
    teams,
    db,
    // Per-user MCP call wiring for lazy enclave reconstitution (D6: uses the
    // authenticated user's OIDC token, not a service token). Fresh connection
    // per call — low-frequency path, no connection pooling needed yet.
    getMcpCallForToken: (userToken: string) => {
      return async (tool: string, params: Record<string, unknown>) => {
        const conn = await createMcpConnection(config.mcp.url, userToken);
        try {
          const result = await conn.client.callTool({
            name: tool,
            arguments: params,
          });
          // Extract text content from the MCP response
          const content = result.content as
            | Array<{ type: string; text?: string }>
            | undefined;
          const text = content?.[0]?.text;
          if (text) {
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          }
          return result;
        } finally {
          await conn.close().catch(() => undefined);
        }
      };
    },
    onSmartPath: async (ctx) => {
      log.info(
        {
          channelId: ctx.channelId,
          mode: ctx.mode,
          userId: ctx.userId,
          enclaveName: ctx.enclaveName,
          textLen: ctx.text.length,
        },
        'smart path invoked',
      );

      const apiKey = config.llm.anthropicApiKey;
      if (!apiKey) {
        log.error('smart path: ANTHROPIC_API_KEY not configured');
        return "I'm not configured to reason right now (no API key). Please contact an administrator.";
      }

      try {
        const answer = await runSmartPath({
          userMessage: ctx.text,
          userToken: ctx.userToken,
          userSlackId: ctx.userId,
          enclaveName: ctx.enclaveName,
          mcpUrl: config.mcp.url,
          anthropicApiKey: apiKey,
          modelId: config.llm.defaultModel,
          mode: ctx.mode,
          channelId: ctx.channelId,
          channelName: ctx.channelName,
          priorTurns: ctx.priorTurns,
          // Allow smart-path to re-source a fresh OIDC token between turns.
          // getValidTokenForUser auto-refreshes via the stored refresh_token,
          // so long agent loops survive Keycloak's ~5 min access-token TTL.
          getFreshToken: () => getValidTokenForUser(ctx.userId),
        });
        return (
          answer ??
          "I couldn't produce a response. Please try rephrasing or ask again in a moment."
        );
      } catch (err) {
        log.error({ err }, 'smart path: runtime error');
        return 'Something went wrong while I was reasoning about that. Please try again.';
      }
    },
    // Home Tab: auth gate check — token store is the source of truth.
    getUserToken: (userId: string) => getValidTokenForUser(userId),
    // Drift sync: channel events (member_left, rename, archive) don't
    // come from an authenticated user message. We use the enclave
    // owner's stored OIDC token to call MCP on their behalf. If the
    // owner isn't currently authenticated, drift sync is a no-op.
    //
    // Owner attribution reconciliation: if the binding's ownerSlackId
    // was recorded as a fallback (triggering user) during reconstitution
    // before the real owner had authenticated, we correct it here on the
    // next drift-sync tick after the owner authenticates. This fulfills
    // the promise made in lookupEnclaveWithReconstitute's warn log.
    getMcpCallForEnclaveOwner: async (enclaveName: string) => {
      const binding = bindings.lookupByEnclaveName(enclaveName);
      if (!binding) return null;
      const ownerToken = await getValidTokenForUser(binding.ownerSlackId);
      if (!ownerToken) return null;

      const mcpCall = async (
        tool: string,
        params: Record<string, unknown>,
      ): Promise<unknown> => {
        const conn = await createMcpConnection(config.mcp.url, ownerToken);
        try {
          const result = await conn.client.callTool({
            name: tool,
            arguments: params,
          });
          const content = result.content as
            | Array<{ type: string; text?: string }>
            | undefined;
          const text = content?.[0]?.text;
          if (text) {
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          }
          return result;
        } finally {
          await conn.close().catch(() => undefined);
        }
      };

      // Reconcile owner attribution: fetch enclave_info to get the
      // authoritative owner email from MCP. If the owner has since
      // authenticated and their Slack ID differs from the stored value,
      // update the binding so future drift-sync calls use the correct token.
      try {
        const info = (await mcpCall('enclave_info', { name: enclaveName })) as
          | { owner?: string }
          | undefined;
        const ownerEmail = info?.owner;
        if (ownerEmail) {
          const resolved = getUserTokenByEmail(ownerEmail);
          if (resolved && resolved.slack_user_id !== binding.ownerSlackId) {
            bindings.setOwnerSlackId(binding.channelId, resolved.slack_user_id);
            log.info(
              {
                enclaveName,
                channelId: binding.channelId,
                oldOwnerSlackId: binding.ownerSlackId,
                newOwnerSlackId: resolved.slack_user_id,
                ownerEmail,
              },
              'drift-sync: reconciled binding owner attribution',
            );
          }
        }
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        // Non-fatal: reconciliation is best-effort; the channel event
        // that triggered this call proceeds regardless.
        log.debug(
          { err, enclaveName },
          'drift-sync: owner attribution check failed (non-fatal)',
        );
      }

      return mcpCall;
    },
    // Home Tab: fetch the set of enclaves this user has access to.
    // Calls enclave_list with the user's email, then wf_list per enclave
    // for tentacle counts. Role is inferred from owner/members.
    getUserEnclaves: async (_userId, userToken) => {
      const email = extractEmailFromToken(userToken);
      if (!email) return [];
      const conn = await createMcpConnection(config.mcp.url, userToken);
      try {
        const listRes = await conn.client.callTool({
          name: 'enclave_list',
          arguments: { caller_email: email },
        });
        const listContent = listRes.content as
          | Array<{ type: string; text?: string }>
          | undefined;
        let listJson: Record<string, unknown> = {};
        try {
          listJson = listContent?.[0]?.text
            ? (JSON.parse(listContent[0].text) as Record<string, unknown>)
            : {};
        } catch {
          return [];
        }
        const maybeEnclaves = listJson['enclaves'] ?? listJson;
        const rawEnclaves = (
          Array.isArray(maybeEnclaves) ? maybeEnclaves : []
        ) as Array<{
          name?: string;
          owner?: string;
          owner_email?: string;
          members?: string[];
        }>;

        const results: Array<{
          name: string;
          tentacleCount: number;
          healthyCount: number;
          role: 'owner' | 'member';
          chromaUrl?: string;
        }> = [];
        for (const e of rawEnclaves) {
          if (!e.name) continue;
          const owner = (e.owner ?? e.owner_email ?? '').toLowerCase();
          const members = (e.members ?? []).map((m) => m.toLowerCase());
          const emailLc = email.toLowerCase();
          if (owner !== emailLc && !members.includes(emailLc)) continue;
          const role: 'owner' | 'member' =
            owner === emailLc ? 'owner' : 'member';

          // Per-enclave tentacle counts (best-effort)
          let tentacleCount = 0;
          let healthyCount = 0;
          try {
            const wfRes = await conn.client.callTool({
              name: 'wf_list',
              arguments: { enclave: e.name },
            });
            const wfContent = wfRes.content as
              | Array<{ type: string; text?: string }>
              | undefined;
            const wfJson = wfContent?.[0]?.text
              ? JSON.parse(wfContent[0].text)
              : {};
            const workflows = (wfJson.workflows ?? []) as Array<{
              ready?: boolean;
            }>;
            tentacleCount = workflows.length;
            healthyCount = workflows.filter((w) => w.ready === true).length;
          } catch {
            // non-fatal
          }
          const chromaUrl = config.chroma.baseUrl
            ? `${config.chroma.baseUrl}/enclaves/${encodeURIComponent(e.name)}`
            : undefined;
          results.push({
            name: e.name,
            tentacleCount,
            healthyCount,
            role,
            chromaUrl,
          });
        }
        return results;
      } finally {
        await conn.close().catch(() => undefined);
      }
    },
  });

  // 6. Outbound poller (uses Slack bot's client for posting)
  const poller = new OutboundPoller({
    config,
    teams,
    slack: {
      postMessage: async (params: {
        channel: string;
        text: string;
        thread_ts?: string;
      }) => {
        return slackBot.app.client.chat.postMessage({
          channel: params.channel,
          text: params.text,
          thread_ts: params.thread_ts,
        }) as Promise<{ ts?: string }>;
      },
    },
    tracker: outbound,
    getActiveTeams: () => teams.getActiveTeamNames(),
  });

  // Wire team exit -> poller drain (Codex fix #3)
  teams.setOnTeamExited((enclaveName) => poller.notifyTeamExited(enclaveName));

  // 7. Start services
  poller.start();
  await slackBot.start();

  const enclaveCount = bindings.count();
  log.info(
    {
      mode: config.slack.mode,
      port: config.server.port,
      mcpUrl: config.mcp.url,
      enclaveCount,
      teamsDir: config.teamsDir,
      version: '0.9.0',
    },
    'The Kraken started',
  );

  // 8. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutdown initiated');

    try {
      stopTokenRefreshLoop();
      await poller.stop();
      await slackBot.stop();
      await teams.shutdownAll();
      await shutdownTelemetry();
      db.close();
      log.info('Shutdown complete');
    } catch (err) {
      log.error({ err }, 'Error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
