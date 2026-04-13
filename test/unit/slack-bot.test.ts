/**
 * Slack bot unit tests (post-pivot: dispatcher routing).
 *
 * Tests focus on the event handler logic without a real Slack connection.
 * We mock the Bolt App's event registration to intercept handlers and
 * invoke them directly with synthetic event payloads.
 *
 * The bot now calls routeEvent() and executes the returned RouteDecision
 * rather than calling AgentRunner.handleMessage() directly.
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
    client = {
      chat: { postMessage: vi.fn().mockResolvedValue({ ts: 'out-ts' }) },
    };
  },
  ExpressReceiver: class MockExpressReceiver {
    router = { get: vi.fn() };
  },
}));

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockTeams = {
  isTeamActive: vi.fn().mockReturnValue(false),
  sendToTeam: vi.fn(),
  getActiveTeamNames: vi.fn().mockReturnValue([]),
  spawnTeam: vi.fn().mockResolvedValue(undefined),
  shutdownAll: vi.fn(),
};

const mockBindings = {
  lookupEnclave: vi.fn().mockReturnValue(null),
  count: vi.fn().mockReturnValue(0),
};

const mockOutbound = {
  store: vi.fn(),
  hasOutboundInThread: vi.fn().mockReturnValue(false),
};

const mockSmartPath = vi.fn().mockResolvedValue('Smart response');

const baseConfig = {
  slack: {
    botToken: 'xoxb-test',
    signingSecret: 'test-secret',
    mode: 'http' as const,
  },
  server: { port: 3000 },
  mcp: { url: 'http://mcp:8080', port: 8080, serviceToken: 'svc-token' },
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
  teamsDir: '/tmp/kraken-teams-test',
  observability: { otlpEndpoint: '', logLevel: 'info' },
};

// ---------------------------------------------------------------------------
// Import and instantiate after mocks are set up
// ---------------------------------------------------------------------------

async function getSlackBot() {
  const { createSlackBot } = await import('../../src/slack/bot.js');
  return createSlackBot({
    config: baseConfig as any,
    bindings: mockBindings as any,
    outbound: mockOutbound as any,
    teams: mockTeams as any,
    onSmartPath: mockSmartPath,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSlackBot event handlers (post-pivot)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    mockBindings.lookupEnclave.mockReturnValue(null);
    mockTeams.isTeamActive.mockReturnValue(false);
  });

  it('registers app_mention and message event handlers', async () => {
    await getSlackBot();
    expect('app_mention' in registeredHandlers).toBe(true);
    expect('message' in registeredHandlers).toBe(true);
  });

  describe('app_mention handler', () => {
    it('ignores mentions in unbound channels (deterministic: ignore_unbound)', async () => {
      await getSlackBot();
      mockBindings.lookupEnclave.mockReturnValue(null);

      const say = vi.fn();
      await registeredHandlers['app_mention']!({
        event: {
          type: 'app_mention',
          channel: 'C_UNBOUND',
          user: 'U_USER',
          text: '<@BOTID> hello',
          ts: '1234.5678',
        },
        say,
      });

      expect(say).not.toHaveBeenCalled();
      expect(mockTeams.sendToTeam).not.toHaveBeenCalled();
    });

    it('forwards mentions in enclave channels to team (deterministic: spawn_and_forward)', async () => {
      await getSlackBot();
      mockBindings.lookupEnclave.mockReturnValue({
        channelId: 'C_ENC',
        enclaveName: 'marketing-analytics',
        ownerSlackId: 'U_OWNER',
        status: 'active',
      });
      mockTeams.isTeamActive.mockReturnValue(false);

      const say = vi.fn();
      await registeredHandlers['app_mention']!({
        event: {
          type: 'app_mention',
          channel: 'C_ENC',
          user: 'U_ALICE',
          text: '<@BOTID> deploy my workflow',
          ts: '1000.1',
        },
        say,
      });

      // Should forward to the team, not call say directly
      expect(mockTeams.sendToTeam).toHaveBeenCalledWith(
        'marketing-analytics',
        expect.objectContaining({
          type: 'user_message',
          channelId: 'C_ENC',
          userSlackId: 'U_ALICE',
          message: expect.stringContaining('deploy my workflow'),
        }),
      );
    });

    it('ignores bot-originated mentions', async () => {
      await getSlackBot();
      const say = vi.fn();
      await registeredHandlers['app_mention']!({
        event: {
          type: 'app_mention',
          channel: 'C_ENC',
          user: 'U_BOT',
          text: 'bot mention',
          ts: '1000.2',
          bot_id: 'B123',
        },
        say,
      });

      expect(say).not.toHaveBeenCalled();
      expect(mockTeams.sendToTeam).not.toHaveBeenCalled();
    });
  });

  describe('message handler', () => {
    it('routes DMs to the smart path', async () => {
      await getSlackBot();

      const say = vi.fn().mockResolvedValue({ ts: 'dm-out' });
      await registeredHandlers['message']!({
        event: {
          type: 'message',
          channel: 'D_DM',
          channel_type: 'im',
          user: 'U_ALICE',
          text: 'how are my enclaves?',
          ts: '2000.1',
        },
        say,
      });

      expect(mockSmartPath).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'dm',
          userId: 'U_ALICE',
          text: 'how are my enclaves?',
        }),
      );
      expect(say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Smart response',
        }),
      );
    });

    it('ignores messages in non-enclave channels', async () => {
      await getSlackBot();
      mockBindings.lookupEnclave.mockReturnValue(null);

      const say = vi.fn();
      await registeredHandlers['message']!({
        event: {
          type: 'message',
          channel: 'C_RANDOM',
          channel_type: 'channel',
          user: 'U_USER',
          text: 'random chatter',
          ts: '3000.1',
        },
        say,
      });

      expect(say).not.toHaveBeenCalled();
      expect(mockTeams.sendToTeam).not.toHaveBeenCalled();
    });

    it('ignores messages with subtypes (bot_message, etc.)', async () => {
      await getSlackBot();
      const say = vi.fn();
      await registeredHandlers['message']!({
        event: {
          type: 'message',
          subtype: 'bot_message',
          channel: 'C_ENC',
          text: 'bot output',
          ts: '4000.1',
        },
        say,
      });

      expect(say).not.toHaveBeenCalled();
    });

    it('ignores messages from bots', async () => {
      await getSlackBot();
      const say = vi.fn();
      await registeredHandlers['message']!({
        event: {
          type: 'message',
          channel: 'C_ENC',
          user: 'U_BOT',
          text: 'bot text',
          ts: '5000.1',
          bot_id: 'B456',
        },
        say,
      });

      expect(say).not.toHaveBeenCalled();
    });
  });
});
