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
import {
  initTokenStore,
  startTokenRefreshLoop,
  stopTokenRefreshLoop,
} from './auth/index.js';
import { EnclaveBindingEngine } from './enclave/binding.js';
import { OutboundTracker } from './slack/outbound.js';
import { TeamLifecycleManager } from './teams/lifecycle.js';
import { OutboundPoller } from './teams/outbound-poller.js';
import { createSlackBot } from './slack/bot.js';

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
