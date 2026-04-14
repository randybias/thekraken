import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('telemetry', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('exports initTelemetry and shutdownTelemetry functions', async () => {
    const { initTelemetry, shutdownTelemetry } =
      await import('../../src/telemetry.js');
    expect(typeof initTelemetry).toBe('function');
    expect(typeof shutdownTelemetry).toBe('function');
  });

  it('initTelemetry is a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set', async () => {
    const { initTelemetry } = await import('../../src/telemetry.js');
    // Should not throw when endpoint is missing
    expect(() => initTelemetry()).not.toThrow();
  });

  it('shutdownTelemetry resolves even when OTel was never initialized', async () => {
    const { shutdownTelemetry } = await import('../../src/telemetry.js');
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('initTelemetry does not crash when endpoint is set but collector is unreachable', async () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] =
      'http://nonexistent-collector:4318';
    vi.resetModules();
    const { initTelemetry } = await import('../../src/telemetry.js');
    // Should not throw even with an unreachable collector
    expect(() => initTelemetry()).not.toThrow();
  });

  it('OTel API is usable for span creation (noop when not initialized)', async () => {
    const { trace } = await import('@opentelemetry/api');
    const tracer = trace.getTracer('test');
    // Without SDK initialized, spans are noops — should not throw
    expect(() => {
      const span = tracer.startSpan('test-span');
      span.setAttribute('key', 'value');
      span.end();
    }).not.toThrow();
  });
});
