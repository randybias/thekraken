/**
 * Auth gate unit tests (Tasks 6 & 7).
 *
 * Verifies that:
 *   - Unauthenticated users receive an ephemeral auth prompt and are not routed.
 *   - Authenticated users are routed and their token flows into mailbox records.
 *   - Background device-auth polling is started (fire-and-forget) when needed.
 *
 * This test file owns the auth-gate code path. slack-bot.test.ts covers the
 * routing logic and assumes users are already authenticated.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the auth module — controlled per-test
// ---------------------------------------------------------------------------

const mockGetValidTokenForUser = vi.fn<() => Promise<string | null>>();
const mockInitiateDeviceAuth = vi.fn();
const mockPollForToken = vi.fn();
const mockStoreTokenForUser = vi.fn();

vi.mock('../../src/auth/index.js', () => ({
  getValidTokenForUser: mockGetValidTokenForUser,
  initiateDeviceAuth: mockInitiateDeviceAuth,
  pollForToken: mockPollForToken,
  storeTokenForUser: mockStoreTokenForUser,
}));

// ---------------------------------------------------------------------------
// Mock @slack/bolt
// ---------------------------------------------------------------------------

const mockPostEphemeral = vi.fn().mockResolvedValue({});
const mockClient = {
  chat: {
    postMessage: vi.fn().mockResolvedValue({ ts: 'out-ts' }),
    postEphemeral: mockPostEphemeral,
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
// Mock team and binding dependencies
// ---------------------------------------------------------------------------

const mockTeams = {
  isTeamActive: vi.fn().mockReturnValue(false),
  sendToTeam: vi.fn().mockResolvedValue(undefined),
  getActiveTeamNames: vi.fn().mockReturnValue([]),
  spawnTeam: vi.fn().mockResolvedValue(undefined),
  shutdownAll: vi.fn(),
};

const mockBindings = {
  lookupEnclave: vi.fn().mockReturnValue({
    channelId: 'C_ENC',
    enclaveName: 'my-enclave',
    ownerSlackId: 'U_OWNER',
    status: 'active',
  }),
  count: vi.fn().mockReturnValue(1),
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

async function getSlackBot() {
  const { createSlackBot } = await import('../../src/slack/bot.js');
  return createSlackBot({
    config: baseConfig as never,
    bindings: mockBindings as never,
    outbound: mockOutbound as never,
    teams: mockTeams as never,
    onSmartPath: mockSmartPath,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth gate (Task 6)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    // Default binding: enclave exists, team not yet active
    mockBindings.lookupEnclave.mockReturnValue({
      channelId: 'C_ENC',
      enclaveName: 'my-enclave',
      ownerSlackId: 'U_OWNER',
      status: 'active',
    });
    mockTeams.isTeamActive.mockReturnValue(false);
    mockTeams.sendToTeam.mockResolvedValue(undefined);
    mockTeams.spawnTeam.mockResolvedValue(undefined);
    mockPostEphemeral.mockResolvedValue({});
  });

  describe('unauthenticated user (app_mention)', () => {
    it('posts an ephemeral auth prompt when user has no token', async () => {
      mockGetValidTokenForUser.mockResolvedValue(null);
      mockInitiateDeviceAuth.mockResolvedValue({
        device_code: 'dev-code-123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://auth.example.com/device',
        verification_uri_complete:
          'https://auth.example.com/device?code=ABCD-1234',
        expires_in: 300,
        interval: 5,
      });
      // pollForToken never resolves during this test (fire-and-forget)
      mockPollForToken.mockReturnValue(new Promise(() => {}));

      await getSlackBot();
      const say = vi.fn();
      await registeredHandlers['app_mention']!({
        event: {
          type: 'app_mention',
          channel: 'C_ENC',
          user: 'U_ALICE',
          text: '<@BOT> deploy',
          ts: '1000.1',
        },
        say,
        client: mockClient,
      });

      expect(mockPostEphemeral).toHaveBeenCalledOnce();
      expect(mockPostEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C_ENC',
          user: 'U_ALICE',
          text: expect.stringContaining('ABCD-1234'),
        }),
      );
    });

    it('does NOT route to teams when user is unauthenticated', async () => {
      mockGetValidTokenForUser.mockResolvedValue(null);
      mockInitiateDeviceAuth.mockResolvedValue({
        device_code: 'dev-code',
        user_code: 'XY-12',
        verification_uri: 'https://auth.example.com/device',
        expires_in: 300,
        interval: 5,
      });
      mockPollForToken.mockReturnValue(new Promise(() => {}));

      await getSlackBot();
      const say = vi.fn();
      await registeredHandlers['app_mention']!({
        event: {
          type: 'app_mention',
          channel: 'C_ENC',
          user: 'U_ALICE',
          text: '<@BOT> deploy',
          ts: '1001.0',
        },
        say,
        client: mockClient,
      });

      expect(mockTeams.spawnTeam).not.toHaveBeenCalled();
      expect(mockTeams.sendToTeam).not.toHaveBeenCalled();
      expect(say).not.toHaveBeenCalled();
    });

    it('starts background polling after posting the auth prompt', async () => {
      mockGetValidTokenForUser.mockResolvedValue(null);
      mockInitiateDeviceAuth.mockResolvedValue({
        device_code: 'dev-code-poll',
        user_code: 'PQ-99',
        verification_uri: 'https://auth.example.com/device',
        expires_in: 300,
        interval: 5,
      });
      const pollResolved = vi.fn();
      mockPollForToken.mockImplementation(() =>
        Promise.resolve({
          access_token: 'new-at',
          refresh_token: 'new-rt',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      );
      mockStoreTokenForUser.mockImplementation(pollResolved);

      await getSlackBot();
      await registeredHandlers['app_mention']!({
        event: {
          type: 'app_mention',
          channel: 'C_ENC',
          user: 'U_BOB',
          text: '<@BOT> hello',
          ts: '1002.0',
        },
        say: vi.fn(),
        client: mockClient,
      });

      // Allow the fire-and-forget promise to flush
      await new Promise((r) => setTimeout(r, 0));

      expect(mockPollForToken).toHaveBeenCalledWith('dev-code-poll', 5, 300);
      expect(mockStoreTokenForUser).toHaveBeenCalledWith(
        'U_BOB',
        expect.objectContaining({ access_token: 'new-at' }),
      );
    });
  });

  describe('authenticated user — token flows through dispatch (Task 7)', () => {
    it('routes an authenticated app_mention and includes token in mailbox record (spawn_and_forward)', async () => {
      mockGetValidTokenForUser.mockResolvedValue('user-oidc-token-abc');
      mockTeams.isTeamActive.mockReturnValue(false);

      await getSlackBot();
      const say = vi.fn();
      await registeredHandlers['app_mention']!({
        event: {
          type: 'app_mention',
          channel: 'C_ENC',
          user: 'U_ALICE',
          text: '<@BOT> build my workflow',
          ts: '2000.0',
        },
        say,
        client: mockClient,
      });

      // Team was spawned with the real token
      expect(mockTeams.spawnTeam).toHaveBeenCalledWith(
        'my-enclave',
        'U_ALICE',
        'user-oidc-token-abc',
      );

      // Mailbox record contains the real token
      expect(mockTeams.sendToTeam).toHaveBeenCalledWith(
        'my-enclave',
        expect.objectContaining({
          userToken: 'user-oidc-token-abc',
          userSlackId: 'U_ALICE',
          type: 'user_message',
        }),
      );

      // No ephemeral prompt was shown
      expect(mockPostEphemeral).not.toHaveBeenCalled();
    });

    it('includes token in mailbox record when forwarding to active team (forward_to_active_team)', async () => {
      mockGetValidTokenForUser.mockResolvedValue('user-oidc-token-xyz');
      mockTeams.isTeamActive.mockReturnValue(true);

      await getSlackBot();
      await registeredHandlers['app_mention']!({
        event: {
          type: 'app_mention',
          channel: 'C_ENC',
          user: 'U_CAROL',
          text: '<@BOT> deploy an update',
          ts: '3000.0',
        },
        say: vi.fn(),
        client: mockClient,
      });

      // spawnTeam NOT called (team already active)
      expect(mockTeams.spawnTeam).not.toHaveBeenCalled();

      // Mailbox record still carries the real token
      expect(mockTeams.sendToTeam).toHaveBeenCalledWith(
        'my-enclave',
        expect.objectContaining({
          userToken: 'user-oidc-token-xyz',
          userSlackId: 'U_CAROL',
        }),
      );
    });

    it('routes an authenticated message (DM) and passes token on smart path', async () => {
      mockGetValidTokenForUser.mockResolvedValue('user-oidc-token-dm');
      // DM channels are not bound enclaves
      mockBindings.lookupEnclave.mockReturnValue(null);

      await getSlackBot();
      const say = vi.fn().mockResolvedValue({ ts: 'dm-reply' });
      await registeredHandlers['message']!({
        event: {
          type: 'message',
          channel: 'D_DM',
          channel_type: 'im',
          user: 'U_DM',
          text: 'what enclaves do I have?',
          ts: '4000.0',
        },
        say,
        client: mockClient,
      });

      // Smart path was invoked (DM always goes smart)
      expect(mockSmartPath).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'dm',
          userId: 'U_DM',
        }),
      );
      // No ephemeral prompt
      expect(mockPostEphemeral).not.toHaveBeenCalled();
    });
  });

  describe('unauthenticated user (message event)', () => {
    it('posts ephemeral auth prompt for unauthenticated message in enclave channel', async () => {
      mockGetValidTokenForUser.mockResolvedValue(null);
      mockInitiateDeviceAuth.mockResolvedValue({
        device_code: 'dev-msg',
        user_code: 'MSG-CODE',
        verification_uri: 'https://auth.example.com/device',
        expires_in: 300,
        interval: 5,
      });
      mockPollForToken.mockReturnValue(new Promise(() => {}));

      await getSlackBot();
      await registeredHandlers['message']!({
        event: {
          type: 'message',
          channel: 'C_ENC',
          channel_type: 'channel',
          user: 'U_NEW',
          text: 'hello there',
          ts: '5000.0',
        },
        say: vi.fn(),
        client: mockClient,
      });

      expect(mockPostEphemeral).toHaveBeenCalledOnce();
      expect(mockPostEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          user: 'U_NEW',
          text: expect.stringContaining('MSG-CODE'),
        }),
      );
      expect(mockTeams.sendToTeam).not.toHaveBeenCalled();
    });
  });
});
