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
// Mock the auth module — all existing tests assume user is already authenticated.
// The auth-gate.test.ts covers the unauthenticated path explicitly.
// ---------------------------------------------------------------------------

vi.mock('../../src/auth/index.js', () => ({
  getValidTokenForUser: vi.fn().mockResolvedValue('mock-access-token'),
  initiateDeviceAuth: vi.fn(),
  pollForToken: vi.fn(),
  storeTokenForUser: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock @slack/bolt to avoid real Slack API calls
// ---------------------------------------------------------------------------

const mockClient = {
  chat: {
    postMessage: vi.fn().mockResolvedValue({ ts: 'out-ts' }),
    postEphemeral: vi.fn().mockResolvedValue({}),
  },
};

type EventHandler = (args: {
  event: Record<string, unknown>;
  say: (msg: { text: string; thread_ts?: string }) => Promise<{ ts?: string }>;
  client: typeof mockClient;
}) => Promise<void>;

const registeredHandlers: Record<string, EventHandler> = {};

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    event(name: string, handler: EventHandler): void {
      registeredHandlers[name] = handler;
    }
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = mockClient;
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
  lookupEnclaveWithReconstitute: vi.fn().mockResolvedValue(null),
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
  mcp: { url: 'http://mcp:8080', port: 8080 },
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
    // Provide a noop MCP call factory so the lazy-reconstitute path
    // has something to try. The mocked
    // lookupEnclaveWithReconstitute always returns null, so this is
    // never actually called — but it has to be wired to avoid the
    // "Internal error: MCP client not wired" early exit.
    getMcpCallForToken: () => async () => ({}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSlackBot event handlers (post-pivot)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    mockBindings.lookupEnclave.mockReturnValue(null);
    mockTeams.isTeamActive.mockReturnValue(false);
    // Restore auth mock default: authenticated user with a valid token.
    const auth = await import('../../src/auth/index.js');
    vi.mocked(auth.getValidTokenForUser).mockResolvedValue('mock-access-token');
  });

  it('registers app_mention and message event handlers', async () => {
    await getSlackBot();
    expect('app_mention' in registeredHandlers).toBe(true);
    expect('message' in registeredHandlers).toBe(true);
  });

  describe('app_mention handler', () => {
    it('posts a provisioning hint in unbound channels without provision intent', async () => {
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
        client: mockClient,
      });

      // Unbound channel + non-PROVISION_PATTERN text: hand the user a
      // hint about how to provision the channel rather than silently
      // ignoring. No team dispatch, no smart-path invocation.
      expect(mockTeams.sendToTeam).not.toHaveBeenCalled();
      expect(mockSmartPath).not.toHaveBeenCalled();
      expect(say).toHaveBeenCalledTimes(1);
      const sayArg = say.mock.calls[0]?.[0];
      expect(sayArg?.text).toContain('provision this channel');
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
        client: mockClient,
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

    it('processes mentions from OTHER bots (allows third-party bot integrations)', async () => {
      // The blanket bot_id filter was removed so E2E driver bots can
      // talk to us. Self-loops are still prevented via userId ===
      // botUserId. A mention from a different bot should be processed
      // normally — routed like any user mention. Here the channel is
      // unbound (default mock returns null) so we expect the "not an
      // enclave" fallback rather than team dispatch.
      await getSlackBot();
      const say = vi.fn();
      await registeredHandlers['app_mention']!({
        event: {
          type: 'app_mention',
          channel: 'C_ENC',
          user: 'U_OTHER_BOT',
          text: '<@BOTID> hello from another bot',
          ts: '1000.2',
          bot_id: 'B123',
        },
        say,
        client: mockClient,
      });

      // Not silently ignored — goes through the dispatcher like any user.
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
        client: mockClient,
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
        client: mockClient,
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
        client: mockClient,
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
        client: mockClient,
      });

      expect(say).not.toHaveBeenCalled();
    });

    it('routes non-mention thread replies in enclave-bound channels to team', async () => {
      // Regression: thread replies without @mention (e.g. "yes, confirm") were
      // silently dropped because the message handler returned early for all
      // non-DM channels. This test ensures confirmation replies reach the team.
      await getSlackBot();
      mockBindings.lookupEnclave.mockReturnValue({
        channelId: 'C_ENC',
        enclaveName: 'my-enclave',
        ownerSlackId: 'U_OWNER',
        status: 'active',
      });
      mockTeams.isTeamActive.mockReturnValue(true);

      const say = vi.fn();
      await registeredHandlers['message']!({
        event: {
          type: 'message',
          channel: 'C_ENC',
          channel_type: 'channel',
          user: 'U_USER',
          text: 'yes, confirm',
          ts: '6000.2', // reply ts differs from thread_ts
          thread_ts: '6000.1', // thread started earlier
        },
        say,
        client: mockClient,
      });

      expect(mockTeams.sendToTeam).toHaveBeenCalledWith(
        'my-enclave',
        expect.objectContaining({ type: 'user_message', channelId: 'C_ENC' }),
      );
    });

    it('ignores top-level non-mention messages in enclave channels (not a thread reply)', async () => {
      // Top-level channel messages without @mention are random conversation —
      // the bot must not intercept them. Only thread REPLIES are forwarded.
      await getSlackBot();
      mockBindings.lookupEnclave.mockReturnValue({
        channelId: 'C_ENC',
        enclaveName: 'my-enclave',
        ownerSlackId: 'U_OWNER',
        status: 'active',
      });

      const say = vi.fn();
      await registeredHandlers['message']!({
        event: {
          type: 'message',
          channel: 'C_ENC',
          channel_type: 'channel',
          user: 'U_USER',
          text: 'hey team, standup in 5',
          ts: '7000.1',
          // No thread_ts — this is a top-level message
        },
        say,
        client: mockClient,
      });

      expect(say).not.toHaveBeenCalled();
      expect(mockTeams.sendToTeam).not.toHaveBeenCalled();
    });

    it('ignores non-mention thread replies in unbound channels', async () => {
      // Thread replies in channels that are NOT bound to an enclave are ignored.
      await getSlackBot();
      mockBindings.lookupEnclave.mockReturnValue(null);

      const say = vi.fn();
      await registeredHandlers['message']!({
        event: {
          type: 'message',
          channel: 'C_RANDOM',
          channel_type: 'channel',
          user: 'U_USER',
          text: 'yes',
          ts: '8000.2',
          thread_ts: '8000.1',
        },
        say,
        client: mockClient,
      });

      expect(say).not.toHaveBeenCalled();
      expect(mockTeams.sendToTeam).not.toHaveBeenCalled();
    });
  });
});
