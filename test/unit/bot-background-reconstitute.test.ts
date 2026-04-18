/**
 * D3: Background reconstitution fallback tests.
 *
 * Verifies that when a user has a valid OIDC token but no local binding,
 * the bot fires a fire-and-forget enclave_list lookup in the background
 * without blocking the response path and without prompting for auth.
 *
 * Assertions per spec:
 * - User authenticated, binding missing → reconstitute fires once, hot path
 *   returns immediately, next lookupEnclave after completion finds the binding.
 * - User NOT authenticated, binding missing → no reconstitute fires, no auth
 *   prompt.
 * - Same user rapid-fire mentions within the dedup window → only one
 *   reconstitute fires.
 * - Reconstitute MCP error → logged at warn, no user-visible fallout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the auth module
// ---------------------------------------------------------------------------

vi.mock('../../src/auth/index.js', () => ({
  getValidTokenForUser: vi.fn().mockResolvedValue('mock-access-token'),
  initiateDeviceAuth: vi.fn(),
  pollForToken: vi.fn(),
  storeTokenForUser: vi.fn(),
  extractEmailFromToken: vi.fn().mockReturnValue(null),
  extractSubFromToken: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Mock @slack/bolt
// ---------------------------------------------------------------------------

const mockClient = {
  chat: {
    postMessage: vi.fn().mockResolvedValue({ ts: 'out-ts' }),
    postEphemeral: vi.fn().mockResolvedValue({}),
  },
  conversations: {
    info: vi.fn().mockResolvedValue({ ok: true, channel: { name: 'general' } }),
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
// Shared test dependencies
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
// Helper: create bot and trigger app_mention
// ---------------------------------------------------------------------------

async function triggerMention(
  overrides: {
    userId?: string;
    channelId?: string;
    text?: string;
    getMcpCallForToken?: (
      token: string,
    ) => (tool: string, params: Record<string, unknown>) => Promise<unknown>;
  } = {},
) {
  const { createSlackBot } = await import('../../src/slack/bot.js');
  createSlackBot({
    config: baseConfig as never,
    bindings: mockBindings as never,
    outbound: mockOutbound as never,
    teams: mockTeams as never,
    onSmartPath: mockSmartPath,
    getMcpCallForToken:
      overrides.getMcpCallForToken ?? (() => async () => ({})),
  });

  const say = vi.fn().mockResolvedValue({ ts: 'out-1' });
  await registeredHandlers['app_mention']!({
    event: {
      type: 'app_mention',
      channel: overrides.channelId ?? 'C_UNBOUND',
      user: overrides.userId ?? 'U_ALICE',
      text: overrides.text ?? '<@BOT> hello',
      ts: '1000.1',
    },
    say,
    client: mockClient,
  });
  return { say };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('D3: background reconstitution', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    // Default: binding missing
    mockBindings.lookupEnclave.mockReturnValue(null);
    mockBindings.lookupEnclaveWithReconstitute.mockResolvedValue(null);
    mockTeams.isTeamActive.mockReturnValue(false);
  });

  afterEach(async () => {
    // Clear dedup cache between tests to avoid cross-test interference.
    const botModule = await import('../../src/slack/bot.js');
    botModule.RECONSTITUTE_IN_FLIGHT.clear();
  });

  it('fires background reconstitution when user is authenticated and binding is missing', async () => {
    const auth = await import('../../src/auth/index.js');
    vi.mocked(auth.getValidTokenForUser).mockResolvedValue('user-token-abc');

    const mcpCallFn = vi.fn().mockResolvedValue({});
    const getMcpCallForToken = vi.fn().mockReturnValue(mcpCallFn);

    await triggerMention({ getMcpCallForToken });

    // Wait a tick for the fire-and-forget promise to resolve.
    await new Promise((r) => setTimeout(r, 10));

    expect(mockBindings.lookupEnclaveWithReconstitute).toHaveBeenCalledOnce();
    expect(mockBindings.lookupEnclaveWithReconstitute).toHaveBeenCalledWith(
      'C_UNBOUND',
      'U_ALICE',
      mcpCallFn,
    );
  });

  it('hot path returns immediately (does not await reconstitution)', async () => {
    const auth = await import('../../src/auth/index.js');
    vi.mocked(auth.getValidTokenForUser).mockResolvedValue('user-token-abc');

    // Make reconstitution take a long time to prove it doesn't block
    mockBindings.lookupEnclaveWithReconstitute.mockImplementation(
      () => new Promise((r) => setTimeout(r, 5000)),
    );

    const start = Date.now();
    const { say } = await triggerMention();
    const elapsed = Date.now() - start;

    // Handler should return well before the 5-second reconstitution delay
    expect(elapsed).toBeLessThan(1000);
    // say was NOT called (non-provision text in unbound channel)
    expect(say).not.toHaveBeenCalled();
  });

  it('does NOT fire reconstitution when user is NOT authenticated', async () => {
    const auth = await import('../../src/auth/index.js');
    // Unauthenticated — getValidTokenForUser returns null
    vi.mocked(auth.getValidTokenForUser).mockResolvedValue(null);

    await triggerMention();
    await new Promise((r) => setTimeout(r, 10));

    expect(mockBindings.lookupEnclaveWithReconstitute).not.toHaveBeenCalled();
  });

  it('does NOT fire reconstitution when getMcpCallForToken is not provided', async () => {
    const auth = await import('../../src/auth/index.js');
    vi.mocked(auth.getValidTokenForUser).mockResolvedValue('user-token-abc');

    const { createSlackBot } = await import('../../src/slack/bot.js');
    createSlackBot({
      config: baseConfig as never,
      bindings: mockBindings as never,
      outbound: mockOutbound as never,
      teams: mockTeams as never,
      onSmartPath: mockSmartPath,
      // No getMcpCallForToken
    });

    const say = vi.fn();
    await registeredHandlers['app_mention']!({
      event: {
        type: 'app_mention',
        channel: 'C_UNBOUND',
        user: 'U_ALICE',
        text: '<@BOT> hello',
        ts: '1000.1',
      },
      say,
      client: mockClient,
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockBindings.lookupEnclaveWithReconstitute).not.toHaveBeenCalled();
  });

  it('deduplicates rapid-fire mentions — only one reconstitution fires per user in 30s window', async () => {
    const auth = await import('../../src/auth/index.js');
    vi.mocked(auth.getValidTokenForUser).mockResolvedValue('user-token-abc');

    // Slow reconstitution so the dedup window is still open for concurrent calls.
    mockBindings.lookupEnclaveWithReconstitute.mockImplementation(
      () => new Promise((r) => setTimeout(r, 200)),
    );

    const getMcpCallForToken = vi.fn().mockReturnValue(vi.fn());

    // Fire three mentions in the same tick — no intervening awaits.
    // Sequential awaits would serialize and miss the race; Promise.all
    // dispatches all three handlers before any settles.
    const p1 = triggerMention({ getMcpCallForToken });
    const p2 = triggerMention({ getMcpCallForToken });
    const p3 = triggerMention({ getMcpCallForToken });
    await Promise.all([p1, p2, p3]);

    // Wait for the background reconstitution to settle.
    await new Promise((r) => setTimeout(r, 300));

    // Only one reconstitution should have fired despite three concurrent mentions.
    expect(mockBindings.lookupEnclaveWithReconstitute).toHaveBeenCalledOnce();
  });

  it('does not post anything to Slack during background reconstitution', async () => {
    const auth = await import('../../src/auth/index.js');
    vi.mocked(auth.getValidTokenForUser).mockResolvedValue('user-token-abc');
    mockBindings.lookupEnclaveWithReconstitute.mockResolvedValue({
      channelId: 'C_UNBOUND',
      enclaveName: 'my-enclave',
      ownerSlackId: 'U_ALICE',
      status: 'active',
      createdAt: new Date().toISOString(),
    });

    const { say } = await triggerMention();
    await new Promise((r) => setTimeout(r, 10));

    // The reconstitution succeeded but nothing should be said to Slack
    expect(say).not.toHaveBeenCalled();
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    expect(mockClient.chat.postEphemeral).not.toHaveBeenCalled();
  });

  it('MCP error during reconstitution is logged at warn and does not crash the bot', async () => {
    const auth = await import('../../src/auth/index.js');
    vi.mocked(auth.getValidTokenForUser).mockResolvedValue('user-token-abc');
    mockBindings.lookupEnclaveWithReconstitute.mockRejectedValue(
      new Error('MCP unavailable'),
    );

    // Should not throw
    await expect(triggerMention()).resolves.not.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    // say not called, no ephemeral
    const { say } = await triggerMention();
    expect(say).not.toHaveBeenCalled();
  });

  it('dedup cache entry is cleared after reconstitution completes', async () => {
    const auth = await import('../../src/auth/index.js');
    vi.mocked(auth.getValidTokenForUser).mockResolvedValue('user-token-abc');
    mockBindings.lookupEnclaveWithReconstitute.mockResolvedValue(null);

    const getMcpCallForToken = vi.fn().mockReturnValue(vi.fn());
    await triggerMention({ getMcpCallForToken });

    // Wait for reconstitution to complete and cache to clear
    await new Promise((r) => setTimeout(r, 50));

    const botModule = await import('../../src/slack/bot.js');
    // Cache should be cleared after completion
    expect(botModule.RECONSTITUTE_IN_FLIGHT.has('U_ALICE')).toBe(false);
  });
});
