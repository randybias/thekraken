/**
 * Smart-path token refresh on entry + 401 retry logic.
 *
 * Root cause of nats-weu E2E failures M4, C4, I2 (2026-05-06):
 * smart-path opened its initial MCP connection with a snapshot token
 * that could be stale (Keycloak access-token TTL ~5 min). On 401,
 * the code fell through to tool-less mode and the LLM answered as
 * if MCP didn't exist — confabulating or saying "I don't have wf_run".
 *
 * Fix: resolve a fresh token at entry, retry once on 401, and return
 * a re-auth message on persistent 401 (never fall through to tool-less).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateMcp = vi.fn();
vi.mock('../../../src/agent/mcp-connection.js', () => ({
  createMcpConnection: (...args: unknown[]) => mockCreateMcp(...args),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  complete: vi.fn().mockResolvedValue({
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'endTurn',
    timestamp: 0,
  }),
  getModel: () => ({}),
  registerBuiltInApiProviders: () => {},
}));

import { runSmartPath } from '../../../src/dispatcher/smart-path.js';

const baseInput = {
  userMessage: 'hi',
  userToken: 'stale-token',
  userSlackId: 'U1',
  enclaveName: null,
  mcpUrl: 'http://mcp',
  anthropicApiKey: 'ak',
  modelId: 'claude-haiku-4-5',
  mode: 'dm' as const,
};

beforeEach(() => {
  mockCreateMcp.mockReset();
});

describe('smart-path token refresh on entry', () => {
  it('uses fresh token from getFreshToken when one is provided', async () => {
    mockCreateMcp.mockResolvedValueOnce({ tools: [], close: () => Promise.resolve() });
    await runSmartPath({
      ...baseInput,
      getFreshToken: () => Promise.resolve('fresh-token'),
    });
    expect(mockCreateMcp).toHaveBeenCalledWith('http://mcp', 'fresh-token');
  });

  it('falls back to userToken snapshot when getFreshToken returns null', async () => {
    mockCreateMcp.mockResolvedValueOnce({ tools: [], close: () => Promise.resolve() });
    await runSmartPath({
      ...baseInput,
      getFreshToken: () => Promise.resolve(null),
    });
    // With null fresh token, fall back to the snapshot
    expect(mockCreateMcp).toHaveBeenCalledWith('http://mcp', 'stale-token');
  });

  it('retries once after 401 with a refreshed token', async () => {
    mockCreateMcp
      .mockRejectedValueOnce(Object.assign(new Error('401'), { code: 401 }))
      .mockResolvedValueOnce({ tools: [], close: () => Promise.resolve() });
    // Two tokens: entry consumes the first ('initial-fresh'), retry gets the second ('retry-token').
    const tokens = ['initial-fresh', 'retry-token'];
    const result = await runSmartPath({
      ...baseInput,
      getFreshToken: () => Promise.resolve(tokens.shift() ?? null),
    });
    expect(mockCreateMcp).toHaveBeenCalledTimes(2);
    // Second call should use the retry token
    expect(mockCreateMcp.mock.calls[1]?.[1]).toBe('retry-token');
    expect(result).toBe('ok');
  });

  it('returns re-auth message on persistent 401', async () => {
    mockCreateMcp.mockRejectedValue(Object.assign(new Error('401'), { code: 401 }));
    const result = await runSmartPath({
      ...baseInput,
      getFreshToken: () => Promise.resolve('still-bad'),
    });
    expect(result).toMatch(/session has expired|re-?authenticate/i);
  });

  it('returns re-auth message when getFreshToken keeps returning null on retry', async () => {
    mockCreateMcp.mockRejectedValueOnce(Object.assign(new Error('401'), { code: 401 }));
    let callCount = 0;
    const result = await runSmartPath({
      ...baseInput,
      // First call returns the snapshot fallback; on 401 retry, returns null
      getFreshToken: () => Promise.resolve(callCount++ === 0 ? 'stale-token' : null),
    });
    expect(result).toMatch(/session has expired|re-?authenticate/i);
  });

  it('falls through to tool-less mode on a non-401 error (existing behavior preserved)', async () => {
    mockCreateMcp.mockRejectedValueOnce(new Error('connection refused'));
    const result = await runSmartPath({
      ...baseInput,
      getFreshToken: () => Promise.resolve('fresh-token'),
    });
    // We still get a conversational answer (the mocked complete returns 'ok')
    expect(result).toBe('ok');
  });
});
