/**
 * The Kraken v2 — Dispatcher entry point (post-pivot).
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
 * LLM reasoning, it invokes onSmartPath() — which in Phase 1 is a
 * placeholder (logs + returns a "coming soon" message). Phase 2+
 * wires this to a real pi AgentSession via createAgentSession().
 *
 * D6: Every enclave team subprocess carries the initiating user's
 * OIDC token. Phase 1 has no user tokens (OIDC is Phase 2), so
 * authenticated MCP calls are not possible yet. Phase 2 wires up
 * per-user device-flow tokens. There is NO service token concept.
 */

import { loadConfig } from './config.js';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { createChildLogger } from './logger.js';
import { initDatabase } from './db/index.js';
import { EnclaveBindingEngine } from './enclave/binding.js';
import { OutboundTracker } from './slack/outbound.js';
import { TeamLifecycleManager } from './teams/lifecycle.js';
import { OutboundPoller } from './teams/outbound-poller.js';
import { createSlackBot } from './slack/bot.js';
import { UserTokenStore } from './auth/tokens.js';
import { startTokenRefreshLoop, stopTokenRefreshLoop } from './auth/refresh.js';
// DriftDetector imported when real Slack adapters are wired (Phase 4).
// import { DriftDetector } from './enclave/drift.js';

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

  // 4. Subsystems
  const bindings = new EnclaveBindingEngine(db);
  const outbound = new OutboundTracker(db);
  const teams = new TeamLifecycleManager(config, db);

  // 4b. Auth subsystem (Phase 2)
  const tokenStore = new UserTokenStore(db, config.tokenEncryptionKey);
  startTokenRefreshLoop(tokenStore, config.oidc);
  log.info('Token store + refresh loop initialized');

  // 5. Slack bot (created first so poller can reference its client)
  const slackBot = createSlackBot({
    config,
    bindings,
    outbound,
    teams,
    tokenStore,
    // MCP call function for authz checks. Uses the MCP URL from config.
    // In Phase 2, this does a direct HTTP POST to the MCP server with
    // no user token (authz check uses enclave_info which is read-only).
    // Per-user token injection for write ops happens in the team subprocess.
    mcpCall: async (tool: string, params: Record<string, unknown>) => {
      const resp = await fetch(`${config.mcp.url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: tool, arguments: params },
          id: Date.now(),
        }),
      });
      const json = (await resp.json()) as { result?: unknown };
      return json.result;
    },
    onSmartPath: async (ctx) => {
      // Phase 1 placeholder: smart path returns a static message.
      // Phase 2+ wires this to a real pi AgentSession via
      // createAgentSession() with dispatcher-specific tools.
      log.info(
        {
          reason: 'smart_path',
          channelId: ctx.channelId,
          mode: ctx.mode,
          userId: ctx.userId,
        },
        'smart path invoked (Phase 1 placeholder)',
      );
      if (ctx.mode === 'dm') {
        return "I can see your message, but my full reasoning capabilities aren't wired up yet. This will be available soon.";
      }
      return 'I heard you, but I need my full reasoning to help with that. Coming soon.';
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

  // 7a. Drift detection (Phase 3) — disabled with warning if no service token
  // Drift detection DISABLED until Slack adapters are wired (Codex fix #4).
  // With stub adapters (resolveEmail→undefined, listChannelMembers→[]),
  // the drift detector would treat empty Slack member lists as authoritative
  // and REMOVE ALL non-owner members from every active enclave.
  //
  // To enable: replace stubs with real Slack WebClient calls after Slack bot
  // is created (bot.app.client.conversations.members + users.info), then
  // call driftDetector.start(). The DriftDetector class is implemented and
  // tested — only the production wiring is gated here.
  //
  // TODO(phase4): Wire real Slack adapters and enable drift detection.
  void config.drift; // Config parsed but drift disabled until Phase 4
  log.warn(
    'Drift detection DISABLED: Slack adapters not yet wired. See TODO(phase4) in index.ts.',
  );

  // 7b. Run initial GC and schedule hourly GC (Phase 3, F24)
  teams.gcStaleTeams();
  const gcInterval = setInterval(() => teams.gcStaleTeams(), 3_600_000);
  gcInterval.unref?.();

  const enclaveCount = bindings.count();
  log.info(
    {
      mode: config.slack.mode,
      port: config.server.port,
      mcpUrl: config.mcp.url,
      enclaveCount,
      teamsDir: config.teamsDir,
      version: '2.0.0',
    },
    'The Kraken v2 started',
  );

  // 8. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutdown initiated');

    try {
      stopTokenRefreshLoop();
      // driftDetector.stop(); // Disabled until Slack adapters wired (Codex fix #4)
      clearInterval(gcInterval);
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
