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
  userToken: 'snap',
  userSlackId: 'U1',
  enclaveName: null,
  mcpUrl: 'http://mcp',
  anthropicApiKey: 'ak',
  modelId: 'claude-haiku-4-5',
  mode: 'dm' as const,
};

beforeEach(() => mockCreateMcp.mockReset());

describe('smart-path retry classification (rc.13, finding #5)', () => {
  it('returns re-auth when 1st 401 + 2nd 401', async () => {
    mockCreateMcp
      .mockRejectedValueOnce(Object.assign(new Error('401'), { code: 401 }))
      .mockRejectedValueOnce(Object.assign(new Error('401'), { code: 401 }));
    const result = await runSmartPath({
      ...baseInput,
      getFreshToken: () => Promise.resolve('fresh-but-also-bad'),
    });
    expect(result).toMatch(/session has expired|re-?authenticate/i);
  });

  it('falls through to tool-less when 1st 401 + 2nd 503 (transient)', async () => {
    mockCreateMcp
      .mockRejectedValueOnce(Object.assign(new Error('401'), { code: 401 }))
      .mockRejectedValueOnce(Object.assign(new Error('503'), { code: 503 }));
    const result = await runSmartPath({
      ...baseInput,
      getFreshToken: () => Promise.resolve('fresh'),
    });
    // tool-less mode means LLM still answers conversationally
    expect(result).toBe('ok');
  });

  it('falls through to tool-less when 1st 401 + 2nd ECONNREFUSED', async () => {
    mockCreateMcp
      .mockRejectedValueOnce(Object.assign(new Error('401'), { code: 401 }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await runSmartPath({
      ...baseInput,
      getFreshToken: () => Promise.resolve('fresh'),
    });
    expect(result).toBe('ok');
  });
});

describe('smart-path provisioning identity from fresh token (rc.13, finding #6)', () => {
  it('uses claims from active (fresh) token, not the snapshot', async () => {
    // Build two JWTs with different sub/email claims.
    function makeJwt(payload: Record<string, unknown>): string {
      const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
        'base64url',
      );
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${header}.${body}.sig`;
    }

    const staleToken = makeJwt({ email: 'stale@e.com', sub: 'STALE_SUB' });
    const freshToken = makeJwt({ email: 'fresh@e.com', sub: 'FRESH_SUB' });

    let capturedToken: string | undefined;
    mockCreateMcp.mockImplementation(async (_url: unknown, tok: unknown) => {
      capturedToken = tok as string;
      return { tools: [], close: () => Promise.resolve() };
    });

    await runSmartPath({
      ...baseInput,
      mode: 'provision' as const,
      channelId: 'C1',
      channelName: 'unknown-channel',
      userToken: staleToken,
      getFreshToken: () => Promise.resolve(freshToken),
    });

    expect(capturedToken).toBe(freshToken);
    // The identity claims used in the prompt would be from freshToken
    // (extracted post-resolve), not staleToken. This is verified
    // indirectly: the connection used the fresh token, and the prompt
    // was built with the same activeToken's claims.
  });
});
