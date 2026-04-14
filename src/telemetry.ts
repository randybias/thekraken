/**
 * OpenTelemetry SDK initialization for The Kraken v2.
 *
 * Uses manual spans only — no auto-instrumentation. This keeps trace data
 * clean by recording only meaningful operations: Slack events, agent
 * invocations, and MCP tool calls.
 *
 * If OTEL_EXPORTER_OTLP_ENDPOINT is unset, OTel is disabled gracefully.
 * Exporter failures are logged as warnings; the process continues normally.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { createChildLogger } from './logger.js';

const log = createChildLogger({ module: 'telemetry' });

let sdk: NodeSDK | undefined;

/**
 * Initialize OpenTelemetry SDK. Must be called once at startup, before any
 * code that creates OTel spans.
 *
 * If OTEL_EXPORTER_OTLP_ENDPOINT is empty or unset, OTel is disabled.
 * If the collector is unreachable, spans are dropped silently — no crash.
 */
export function initTelemetry(): void {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (!endpoint) {
    log.info('OTel disabled: OTEL_EXPORTER_OTLP_ENDPOINT not set');
    return;
  }

  const exporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
  });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'thekraken',
      [ATTR_SERVICE_VERSION]: '2.0.0',
    }),
    traceExporter: exporter,
  });

  try {
    sdk.start();
    log.info({ endpoint }, 'OTel SDK initialized');
  } catch (err) {
    log.warn({ err }, 'OTel SDK failed to start; continuing without telemetry');
    sdk = undefined;
  }
}

/**
 * Gracefully shutdown OTel SDK. Flushes pending spans to the collector.
 * Call during SIGTERM/SIGINT handling after other subsystems have stopped.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
    log.info('OTel SDK shut down');
  } catch (err) {
    log.warn({ err }, 'OTel SDK shutdown error');
  }
}
