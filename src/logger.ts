/**
 * Structured JSON logger for The Kraken v2.
 *
 * Pino is the sole logger in the process. Pi packages (pi-agent-core, pi-ai)
 * have no logger of their own, so there is no coexistence problem.
 *
 * Usage:
 *   import { createChildLogger } from '../logger.js';
 *   const log = createChildLogger({ module: 'slack-bot' });
 *   log.info({ event: 'app_mention', channel }, 'mention received');
 */

import pino from 'pino';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = pino.Logger;

/**
 * Create a child logger with contextual fields attached to every log line.
 * Use for module-level or request-level context.
 *
 * @param bindings - Arbitrary key-value pairs (e.g. { module, threadKey, enclave }).
 */
export function createChildLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
