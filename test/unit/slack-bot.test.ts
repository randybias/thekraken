/**
 * Slack bot unit tests.
 *
 * Tests focus on the event handler logic without a real Slack connection.
 * We mock the Bolt App's event registration to intercept handlers and
 * invoke them directly with synthetic event payloads.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @slack/bolt to avoid real Slack API calls
// ---------------------------------------------------------------------------

type EventHandler = (args: {
  event: Record<string, unknown>;
  say: (msg: { text: string; thread_ts?: string }) => Promise<{ ts?: string }>;
}) => Promise<void>;

const registeredHandlers: Record<string, EventHandler> = {};

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    event(name: string, handler: EventHandler): void {
      registeredHandlers[name] = handler;
    }
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
  },
  ExpressReceiver: class MockExpressReceiver {
    router = {
      get: vi.fn(),
    };
  },
}));

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockResponse = 'Test response from agent';
const mockRunner = {
  handleMessage: vi.fn().mockResolvedValue(mockResponse),
  hasThread: vi.fn().mockReturnValue(false),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

const mockBinding = {
  channelId: 'C001',
  enclaveName: 'test-enclave',
  ownerSlackId: 'U_OWNER',
  status: 'active' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const mockBindings = {
  lookupEnclave: vi.fn().mockReturnValue(null),
  count: vi.fn().mockReturnValue(0),
};

const mockOutbound = {
  store: vi.fn(),
  hasOutboundInThread: vi.fn().mockReturnValue(false),
};

const baseConfig = {
  slack: {
    botToken: 'xoxb-test',
    signingSecret: 'test-secret',
    mode: 'http' as const,
  },
  server: { port: 3000 },
  mcp: { url: 'http://mcp:8080', port: 8080, serviceToken: 'token' },
  oidc: {
    issuer: 'http://keycloak',
    clientId: 'kraken',
    clientSecret: 'secret',
  },
  llm: {
    defaultProvider: 'anthropic' as const,
    defaultModel: 'claude-sonnet-4-6',
    allowedProviders: ['anthropic'],
    allowedModels: {},
    disallowedModels: [],
    anthropicApiKey: 'sk-ant-test',
  },
  gitState: {
    repoUrl: 'https://git.example.com/repo.git',
    branch: 'main',
    dir: '/app/data',
  },
  observability: { otlpEndpoint: '', logLevel: 'info' },
};

// ---------------------------------------------------------------------------
// Import and instantiate after mocks are set up
// ---------------------------------------------------------------------------

async function getSlackBot() {
  const { createSlackBot } = await import('../../src/slack/bot.js');
  return createSlackBot({
    config: baseConfig as any,
    runner: mockRunner as any,
    bindings: mockBindings as any,
    outbound: mockOutbound as any,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSlackBot event handlers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Reset registered handlers
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    mockRunner.hasThread.mockReturnValue(false);
    mockBindings.lookupEnclave.mockReturnValue(null);
  });

  it('registers app_mention and message event handlers', async () => {
    await getSlackBot();
    expect('app_mention' in registeredHandlers).toBe(true);
    expect('message' in registeredHandlers).toBe(true);
  });

  describe('app_mention handler', () => {
    it('ignores mentions in unbound channels', async () => {
      await getSlackBot();
      mockBindings.lookupEnclave.mockReturnValue(null);

      const say = vi.fn();
      await registeredHandlers['app_mention']!({
        event: {
          type: 'app_mention',
          channel: 'C_UNBOUND',
          user: 'U001',
          text: '@kraken hello',
          ts: '1234567890.000001',
        },
        say,
      });

      expect(mockRunner.handleMessage).not.toHaveBeenCalled();
      expect(say).not.toHaveBeenCalled();
    });

    it('dispatches to runner when channel is bound', async () => {
      await getSlackBot();
      mockBindings.lookupEnclave.mockReturnValue(mockBinding);

      const sayResult = { ts: '1234567891.000002' };
      const say = vi.fn().mockResolvedValue(sayResult);

      await registeredHandlers['app_mention']!({
        event: {
          type: 'app_mention',
          channel: 'C001',
          user: 'U001',
          text: '@kraken list workflows',
          ts: '1234567890.000001',
        },
        say,
      });

      expect(mockRunner.handleMessage).toHaveBeenCalledWith(
        'C001:1234567890.000001',
        '@kraken list workflows',
        {
          enclaveName: 'test-enclave',
          slackUserId: 'U001',
          mode: 'enclave',
        },
      );
      expect(say).toHaveBeenCalledWith({
        text: mockResponse,
        thread_ts: '1234567890.000001',
      });
      expect(mockOutbound.store).toHaveBeenCalledWith(
        'C001',
        '1234567890.000001',
        '1234567891.000002',
        mockResponse,
      );
    });

    it('uses thread_ts from event when replying to a threaded mention', async () => {
      await getSlackBot();
      mockBindings.lookupEnclave.mockReturnValue(mockBinding);
      const say = vi.fn().mockResolvedValue({ ts: '1234567892.000000' });

      await registeredHandlers['app_mention']!({
        event: {
          type: 'app_mention',
          channel: 'C001',
          user: 'U001',
          text: '@kraken follow up',
          ts: '1234567891.000000',
          thread_ts: '1234567890.000000', // Parent thread
        },
        say,
      });

      expect(mockRunner.handleMessage).toHaveBeenCalledWith(
        'C001:1234567890.000000', // Thread key uses thread_ts, not event ts
        expect.any(String),
        expect.any(Object),
      );
    });

    it('ignores bot messages (bot_id present)', async () => {
      await getSlackBot();
      const say = vi.fn();

      await registeredHandlers['app_mention']!({
        event: {
          type: 'app_mention',
          bot_id: 'B001',
          channel: 'C001',
          text: 'bot message',
          ts: '1234567890.000001',
        },
        say,
      });

      expect(mockRunner.handleMessage).not.toHaveBeenCalled();
    });
  });

  describe('message handler', () => {
    it('handles DM messages', async () => {
      await getSlackBot();
      const say = vi.fn().mockResolvedValue({ ts: '1234567891.000000' });

      await registeredHandlers['message']!({
        event: {
          type: 'message',
          channel: 'D001',
          channel_type: 'im',
          user: 'U001',
          text: 'hello kraken',
          ts: '1234567890.000001',
        },
        say,
      });

      expect(mockRunner.handleMessage).toHaveBeenCalledWith(
        'D001:1234567890.000001',
        'hello kraken',
        { enclaveName: null, slackUserId: 'U001', mode: 'dm' },
      );
    });

    it('ignores top-level messages in non-enclave channels', async () => {
      await getSlackBot();
      mockBindings.lookupEnclave.mockReturnValue(null);
      const say = vi.fn();

      await registeredHandlers['message']!({
        event: {
          type: 'message',
          channel: 'C_UNBOUND',
          channel_type: 'channel',
          user: 'U001',
          text: 'hello',
          ts: '1234567890.000001',
          // No thread_ts — top-level message
        },
        say,
      });

      expect(mockRunner.handleMessage).not.toHaveBeenCalled();
    });

    it('ignores thread replies when no session exists', async () => {
      await getSlackBot();
      mockBindings.lookupEnclave.mockReturnValue(mockBinding);
      mockRunner.hasThread.mockReturnValue(false); // No active session

      const say = vi.fn();
      await registeredHandlers['message']!({
        event: {
          type: 'message',
          channel: 'C001',
          channel_type: 'channel',
          user: 'U001',
          text: 'reply',
          ts: '1234567891.000000',
          thread_ts: '1234567890.000000',
        },
        say,
      });

      expect(mockRunner.handleMessage).not.toHaveBeenCalled();
    });

    it('dispatches thread reply when session exists', async () => {
      await getSlackBot();
      mockBindings.lookupEnclave.mockReturnValue(mockBinding);
      mockRunner.hasThread.mockReturnValue(true); // Session exists

      const say = vi.fn().mockResolvedValue({ ts: '1234567892.000000' });
      await registeredHandlers['message']!({
        event: {
          type: 'message',
          channel: 'C001',
          channel_type: 'channel',
          user: 'U001',
          text: 'follow up question',
          ts: '1234567891.000000',
          thread_ts: '1234567890.000000',
        },
        say,
      });

      expect(mockRunner.handleMessage).toHaveBeenCalledWith(
        'C001:1234567890.000000',
        'follow up question',
        { enclaveName: 'test-enclave', slackUserId: 'U001', mode: 'enclave' },
      );
    });

    it('ignores messages with subtype (bot_message, etc.)', async () => {
      await getSlackBot();
      const say = vi.fn();

      await registeredHandlers['message']!({
        event: {
          type: 'message',
          subtype: 'bot_message',
          channel: 'C001',
          text: 'bot output',
          ts: '1234567890.000001',
        },
        say,
      });

      expect(mockRunner.handleMessage).not.toHaveBeenCalled();
    });

    it('ignores messages without user field', async () => {
      await getSlackBot();
      const say = vi.fn();

      await registeredHandlers['message']!({
        event: {
          type: 'message',
          channel: 'C001',
          text: 'no user',
          ts: '1234567890.000001',
        },
        say,
      });

      expect(mockRunner.handleMessage).not.toHaveBeenCalled();
    });
  });
});
