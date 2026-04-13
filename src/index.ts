/**
 * The Kraken v2 — main entry point.
 *
 * Startup sequence:
 *   1. loadConfig()              — fail fast with all missing vars listed
 *   2. initTelemetry()           — OTel SDK (graceful degradation if no collector)
 *   3. initDatabase(config)      — SQLite with migrations applied
 *   4. createMcpConnection()     — MCP HTTP client, tool list from server
 *   5. resolveModel(config)      — Map config.llm to a pi Model object
 *   6. Create subsystems         — EnclaveBindingEngine, OutboundTracker, AgentRunner
 *   7. createSlackBot().start()  — HTTP or Socket Mode transport
 *   8. Log startup banner        — version, mode, MCP URL, enclave count
 *   9. SIGTERM/SIGINT handlers   — drain queues, close MCP, stop Slack, flush OTel
 */

import { getModel } from '@mariozechner/pi-ai';
import type { Model } from '@mariozechner/pi-ai';
import { loadConfig } from './config.js';
import type { KrakenConfig } from './config.js';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { logger } from './logger.js';
import { initDatabase } from './db/index.js';
import { createMcpConnection } from './agent/mcp-connection.js';
import { AgentRunner } from './agent/runner.js';
import { createSlackBot } from './slack/bot.js';
import { EnclaveBindingEngine } from './enclave/binding.js';
import { OutboundTracker } from './slack/outbound.js';

/**
 * Resolve the pi Model object from config.
 *
 * Uses pi-ai's built-in model registry to look up the model by provider
 * and ID. Throws if the model is not found.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveModel(config: KrakenConfig): Model<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = getModel(
    config.llm.defaultProvider as any,
    config.llm.defaultModel,
  ) as Model<any> | undefined;
  if (!model) {
    throw new Error(
      `Unknown model: provider="${config.llm.defaultProvider}" id="${config.llm.defaultModel}". ` +
        'Check LLM_DEFAULT_PROVIDER and LLM_DEFAULT_MODEL.',
    );
  }
  return model;
}

/**
 * Return the API key for the given provider name from config.
 *
 * Returns undefined if no key is configured (caller decides whether to throw).
 * NEVER logs or stores the returned key.
 */
async function resolveApiKey(
  config: KrakenConfig,
  provider: string,
): Promise<string | undefined> {
  switch (provider) {
    case 'anthropic':
      return config.llm.anthropicApiKey;
    case 'openai':
      return config.llm.openaiApiKey;
    case 'google':
      return config.llm.geminiApiKey;
    default:
      return undefined;
  }
}

async function main(): Promise<void> {
  // 1. Load config (fails fast with all missing vars listed)
  const config = loadConfig();

  // 2. Initialize OTel (before anything else creates spans)
  initTelemetry();

  // 3. Initialize SQLite with migrations
  const db = initDatabase(config);

  // 4. Create MCP connection (fetches tool list from server)
  const mcp = await createMcpConnection(
    config.mcp.url,
    config.mcp.serviceToken,
  );

  // 5. Resolve LLM model from pi-ai registry
  const model = resolveModel(config);

  // 6. Create subsystems
  const bindings = new EnclaveBindingEngine(db);
  const outbound = new OutboundTracker(db);
  const runner = new AgentRunner({
    db,
    mcp,
    model,
    getApiKey: (provider) => resolveApiKey(config, provider),
  });

  // 7. Create and start Slack bot
  const bot = createSlackBot({ config, runner, bindings, outbound });
  await bot.start();

  // 8. Log startup banner
  const enclaveCount = bindings.count();
  logger.info(
    {
      version: '2.0.0',
      mode: config.slack.mode,
      mcpUrl: config.mcp.url,
      enclaves: enclaveCount,
    },
    'The Kraken v2 started',
  );

  // 9. Graceful shutdown handler
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutting down');
    try {
      await bot.stop();
      await runner.shutdown();
      await mcp.close();
      db.close();
      await shutdownTelemetry();
      logger.info('shutdown complete');
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
