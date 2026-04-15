/**
 * Integration test harness for The Kraken.
 *
 * Boots all subsystems wired together with controlled external I/O:
 *   - Real SQLite (in-memory)
 *   - Real EnclaveBindingEngine, OutboundTracker, TeamLifecycleManager, OutboundPoller
 *   - MockSlackWebClient (records all API calls)
 *   - Mocked MCP call function (scripted responses)
 *   - Mocked child_process.spawn (uses mock-pi scenarios via real temp dirs)
 *   - Real auth module (pre-seeded user tokens in SQLite)
 *
 * Usage:
 *   const h = await createHarness({ preAuthedUsers: ['U_ALICE'] });
 *   await h.sendSlackEvent(createAppMention({ ... }));
 *   await h.waitForOutbound();
 *   expect(h.mockSlack.calls['chat.postMessage']).toHaveLength(1);
 *   await h.shutdown();
 */

import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createDatabase } from '../../src/db/migrations.js';
import { initTokenStore, setUserToken } from '../../src/auth/tokens.js';
import { EnclaveBindingEngine } from '../../src/enclave/binding.js';
import { OutboundTracker } from '../../src/slack/outbound.js';
import { TeamLifecycleManager } from '../../src/teams/lifecycle.js';
import { OutboundPoller } from '../../src/teams/outbound-poller.js';
import type { KrakenConfig } from '../../src/config.js';
import type { SlackEventEnvelope } from '../mocks/event-simulator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockMcpCall {
  tool: string;
  params: Record<string, unknown>;
}

export interface HarnessOptions {
  /**
   * Slack user IDs that are pre-authenticated (tokens seeded into SQLite).
   */
  preAuthedUsers?: string[];
  /**
   * Per-user email lookup table for users.info mock.
   * Key: Slack user ID, value: email address.
   */
  userEmails?: Record<string, string>;
  /**
   * Enclave-to-channel bindings to seed into the DB.
   * Key: channel ID, value: enclave name.
   */
  channelBindings?: Record<string, { enclaveName: string; owner: string }>;
  /**
   * Scripted MCP tool responses.
   * Key: tool name, value: list of responses (consumed FIFO).
   */
  mcpResponses?: Record<string, unknown[]>;
  /**
   * Mock-pi scenario to use for team subprocess.
   * Default: 'idle-exit'.
   */
  piScenario?: string;
  /**
   * Enclave info returned by enclave_info MCP calls.
   */
  enclaveInfo?: {
    owner: string;
    members: string[];
    mode?: string;
  };
  /**
   * Mock device auth response for unauthenticated user flows.
   * If not provided, defaults to a canned response.
   */
  mockDeviceAuth?: {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval: number;
  };
}

export interface PostedMessage {
  channel: string;
  thread_ts?: string;
  text: string;
  blocks?: unknown[];
  ts?: string;
}

export interface PostedEphemeral {
  channel: string;
  user: string;
  thread_ts?: string;
  text: string;
}

export interface HarnessSlack {
  /** All chat.postMessage calls. */
  posted: PostedMessage[];
  /** All chat.postEphemeral calls. */
  ephemerals: PostedEphemeral[];
  /** All views.publish calls. */
  homeTabsPublished: unknown[];
  /** All users.info calls, keyed by user ID. */
  usersInfoCalls: string[];
  /** Raw calls map (same as MockSlackWebClient.calls). */
  calls: Record<
    string,
    Array<{ method: string; args: Record<string, unknown>; timestamp: number }>
  >;
}

export interface HarnessMcp {
  /** All MCP tool calls recorded during the test. */
  calls: MockMcpCall[];
}

export interface HarnessTeams {
  /** Returns the names of all currently active enclave teams. */
  activeTeams(): string[];
}

export interface Harness {
  /** Send a Slack event envelope to the bot (invokes the registered handler). */
  sendSlackEvent(envelope: SlackEventEnvelope): Promise<void>;
  /** Wait for at least `minCount` outbound messages to be posted, or timeout. */
  waitForOutbound(minCount?: number, timeoutMs?: number): Promise<void>;
  /** Slack mock — inspect posted messages and ephemeral prompts. */
  mockSlack: HarnessSlack;
  /** MCP mock — inspect tool calls. */
  mockMcp: HarnessMcp;
  /** Teams accessor. */
  teams: HarnessTeams;
  /** Raw DB for direct inspection. */
  db: Database.Database;
  /** Shut down all subsystems and clean up temp dirs. */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Bolt mock types (mirroring what createSlackBot registers)
// ---------------------------------------------------------------------------

type AppMentionEvent = {
  type: 'app_mention';
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
};

type MessageEvent = {
  type: 'message';
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel_type?: string;
  subtype?: string;
  bot_id?: string;
};

type MemberLeftEvent = {
  type: 'member_left_channel';
  user: string;
  channel: string;
  channel_type: string;
};

type ChannelArchiveEvent = {
  type: 'channel_archive';
  channel: string;
};

type ChannelRenameEvent = {
  type: 'channel_rename';
  channel: { id: string; name: string; created: number };
};

type AppHomeOpenedEvent = {
  type: 'app_home_opened';
  user: string;
};

type AnyEvent =
  | AppMentionEvent
  | MessageEvent
  | MemberLeftEvent
  | ChannelArchiveEvent
  | ChannelRenameEvent
  | AppHomeOpenedEvent;

type SayFn = (msg: {
  text: string;
  thread_ts: string;
}) => Promise<{ ts?: string }>;

type EventHandler = (args: {
  event: AnyEvent;
  say: SayFn;
  client: HarnessBoltClient;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Bolt mock client (simulates WebClient methods the bot calls)
// ---------------------------------------------------------------------------

class HarnessBoltClient {
  private slack: HarnessSlack;
  private userEmails: Record<string, string>;

  constructor(slack: HarnessSlack, userEmails: Record<string, string>) {
    this.slack = slack;
    this.userEmails = userEmails;
  }

  chat = {
    postMessage: async (
      args: Record<string, unknown>,
    ): Promise<{ ok: boolean; ts: string }> => {
      const msg: PostedMessage = {
        channel: args['channel'] as string,
        thread_ts: args['thread_ts'] as string | undefined,
        text: (args['text'] as string) ?? '',
        blocks: args['blocks'] as unknown[] | undefined,
        ts: `${Date.now()}.${Math.floor(Math.random() * 1000)}`,
      };
      this.slack.posted.push(msg);
      const call = { method: 'chat.postMessage', args, timestamp: Date.now() };
      if (!this.slack.calls['chat.postMessage'])
        this.slack.calls['chat.postMessage'] = [];
      this.slack.calls['chat.postMessage'].push(call);
      return { ok: true, ts: msg.ts! };
    },
    postEphemeral: async (
      args: Record<string, unknown>,
    ): Promise<{ ok: boolean }> => {
      const eph: PostedEphemeral = {
        channel: args['channel'] as string,
        user: args['user'] as string,
        thread_ts: args['thread_ts'] as string | undefined,
        text: (args['text'] as string) ?? '',
      };
      this.slack.ephemerals.push(eph);
      if (!this.slack.calls['chat.postEphemeral'])
        this.slack.calls['chat.postEphemeral'] = [];
      this.slack.calls['chat.postEphemeral'].push({
        method: 'chat.postEphemeral',
        args,
        timestamp: Date.now(),
      });
      return { ok: true };
    },
  };

  users = {
    info: async (
      args: Record<string, unknown>,
    ): Promise<{ user?: { profile?: { email?: string } } }> => {
      const userId = args['user'] as string;
      this.slack.usersInfoCalls.push(userId);
      if (!this.slack.calls['users.info']) this.slack.calls['users.info'] = [];
      this.slack.calls['users.info'].push({
        method: 'users.info',
        args,
        timestamp: Date.now(),
      });
      const email = this.userEmails[userId];
      if (email) {
        return { user: { profile: { email } } };
      }
      return { user: { profile: {} } };
    },
  };

  views = {
    publish: async (
      args: Record<string, unknown>,
    ): Promise<{ ok: boolean }> => {
      this.slack.homeTabsPublished.push(args);
      if (!this.slack.calls['views.publish'])
        this.slack.calls['views.publish'] = [];
      this.slack.calls['views.publish'].push({
        method: 'views.publish',
        args,
        timestamp: Date.now(),
      });
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Spawn mock (replaced per-harness via dynamic import interception)
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * Build a fake ChildProcess that runs mock-pi via tsx in a real temp dir.
 *
 * We use the actual mock-pi.ts file (run via tsx) so that it writes to the
 * real outbound.ndjson file in the team directory. This exercises the full
 * filesystem IPC path.
 */
function spawnMockPiProcess(
  teamDir: string,
  enclaveName: string,
  piScenario: string,
  userToken: string,
  anthropicApiKey?: string,
): ChildProcess {
  const mockPiPath = join(
    new URL('.', import.meta.url).pathname,
    '..',
    'mocks',
    'mock-pi.ts',
  );
  const tsxPath = join(
    new URL('.', import.meta.url).pathname,
    '..',
    '..',
    'node_modules',
    '.bin',
    'tsx',
  );

  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/home/node',
    NODE_ENV: 'test',
    MOCK_PI_SCENARIO: piScenario,
    MOCK_PI_IDLE_TIMEOUT_MS: '50',
    KRAKEN_TEAM_DIR: teamDir,
    KRAKEN_ENCLAVE_NAME: enclaveName,
    TNTC_ACCESS_TOKEN: userToken,
    ...(anthropicApiKey ? { ANTHROPIC_API_KEY: anthropicApiKey } : {}),
  };

  return spawn(tsxPath, [mockPiPath], {
    cwd: teamDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// ---------------------------------------------------------------------------
// Harness factory
// ---------------------------------------------------------------------------

/**
 * Create an integration test harness with all subsystems wired together.
 *
 * Call shutdown() in afterEach to clean up temp files and stop the poller.
 */
export async function createHarness(
  opts: HarnessOptions = {},
): Promise<Harness> {
  const {
    preAuthedUsers = [],
    userEmails = {},
    channelBindings = {},
    mcpResponses = {},
    piScenario = 'idle-exit',
    enclaveInfo,
    mockDeviceAuth = {
      device_code: 'test-device-code',
      user_code: 'TEST-CODE',
      verification_uri: 'https://auth.test/device',
      verification_uri_complete: 'https://auth.test/device?code=TEST-CODE',
      expires_in: 300,
      interval: 5,
    },
  } = opts;

  // --- Temp directory for team state files ---
  const tmpBase = join(tmpdir(), `kraken-int-${process.pid}-${Date.now()}`);
  mkdirSync(tmpBase, { recursive: true });
  const teamsDir = join(tmpBase, 'teams');
  mkdirSync(teamsDir, { recursive: true });

  // --- Database (in-memory) ---
  const db = createDatabase(':memory:');
  initTokenStore(db);

  // --- Pre-seed authenticated users ---
  const futureExpiry = Date.now() + 8 * 60 * 60 * 1000; // 8 hours from now
  for (const userId of preAuthedUsers) {
    setUserToken(userId, {
      access_token: `test-token-${userId}`,
      refresh_token: `refresh-${userId}`,
      expires_at: futureExpiry,
      keycloak_sub: `sub-${userId}`,
      email: userEmails[userId] ?? `${userId.toLowerCase()}@example.com`,
    });
  }

  // --- Seed enclave bindings ---
  for (const [channelId, { enclaveName, owner }] of Object.entries(
    channelBindings,
  )) {
    db.prepare(
      `INSERT OR REPLACE INTO enclave_bindings (channel_id, enclave_name, owner_slack_id, status)
       VALUES (?, ?, ?, 'active')`,
    ).run(channelId, enclaveName, owner);
  }

  // --- Subsystems ---
  const config: KrakenConfig = {
    teamsDir,
    gitState: {
      repoUrl: 'https://github.com/test/repo.git',
      branch: 'main',
      dir: join(tmpBase, 'git-state'),
    },
    slack: {
      botToken: 'xoxb-test',
      signingSecret: 'test-secret',
      mode: 'http',
    },
    oidc: {
      issuer: 'https://keycloak.test',
      clientId: 'kraken',
      clientSecret: 'secret',
    },
    mcp: { url: 'http://mcp.test:8080', port: 8080 },
    llm: {
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
      allowedProviders: ['anthropic'],
      allowedModels: {},
      disallowedModels: [],
      anthropicApiKey: 'sk-ant-test',
    },
    server: { port: 3099 },
    observability: { otlpEndpoint: '', logLevel: 'silent' },
  };

  const bindings = new EnclaveBindingEngine(db);
  const outboundTracker = new OutboundTracker(db);

  // --- MCP call mock ---
  const mcpCallLog: MockMcpCall[] = [];
  const mcpResponseQueues = new Map<string, unknown[]>();
  for (const [tool, responses] of Object.entries(mcpResponses)) {
    mcpResponseQueues.set(tool, [...responses]);
  }

  const mockMcpCall = async (
    tool: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    mcpCallLog.push({ tool, params });
    const queue = mcpResponseQueues.get(tool);
    if (queue && queue.length > 0) {
      return queue.shift();
    }
    // Default responses for common tools
    if (tool === 'enclave_info' && enclaveInfo) {
      return enclaveInfo;
    }
    if (tool === 'enclave_sync') {
      return { ok: true, updated: [] };
    }
    return { ok: true };
  };

  // --- Teams manager with spawn intercepted ---
  // We need to intercept spawn in TeamLifecycleManager to use mock-pi.
  // We do this by creating a subclass that overrides the spawn call.
  class IntegrationTeamsManager extends TeamLifecycleManager {
    async spawnTeam(
      enclaveName: string,
      initiatingUserId: string,
      userToken: string,
    ): Promise<void> {
      // Create team directory (normally done in parent spawnTeam)
      const teamDir = join(teamsDir, enclaveName);
      mkdirSync(join(teamDir, 'memory'), { recursive: true });

      // Use mock-pi instead of real pi
      const proc = spawnMockPiProcess(
        teamDir,
        enclaveName,
        piScenario,
        userToken,
        config.llm.anthropicApiKey,
      );

      // Register the process with the parent via reflection (access private field)
      // Since TypeScript's private is compile-time only, we use type casting
      const teams = (this as unknown as { teams: Map<string, unknown> }).teams;
      teams.set(enclaveName, {
        enclaveName,
        proc,
        lastActivity: Date.now(),
        userTokens: new Map([[initiatingUserId, userToken]]),
        currentToken: userToken,
        teamDir,
      });

      // Wire exit handler
      proc.on('exit', (code: number | null, signal: string | null) => {
        (
          this as unknown as {
            teams: Map<string, unknown>;
            onTeamExited?: (name: string) => void;
          }
        ).teams.delete(enclaveName);
        (
          this as unknown as { onTeamExited?: (name: string) => void }
        ).onTeamExited?.(enclaveName);
        void code;
        void signal;
      });

      proc.on('error', (err: Error) => {
        (
          this as unknown as {
            teams: Map<string, unknown>;
            onTeamExited?: (name: string) => void;
          }
        ).teams.delete(enclaveName);
        (
          this as unknown as { onTeamExited?: (name: string) => void }
        ).onTeamExited?.(enclaveName);
        void err;
      });

      proc.stderr?.on('data', (_chunk: Buffer) => {
        // Discard stderr from mock-pi in tests
      });
    }
  }

  const teamsManager = new IntegrationTeamsManager(config, db);

  // --- Slack mock ---
  const slackState: HarnessSlack = {
    posted: [],
    ephemerals: [],
    homeTabsPublished: [],
    usersInfoCalls: [],
    calls: {},
  };

  const boltClient = new HarnessBoltClient(slackState, userEmails);

  // --- Outbound poller ---
  const poller = new OutboundPoller({
    config,
    teams: teamsManager,
    slack: {
      postMessage: async (params) => {
        const result = await boltClient.chat.postMessage(
          params as Record<string, unknown>,
        );
        return { ts: result.ts };
      },
    },
    tracker: outboundTracker,
    getActiveTeams: () => teamsManager.getActiveTeamNames(),
  });

  teamsManager.setOnTeamExited((enclaveName) =>
    poller.notifyTeamExited(enclaveName),
  );
  poller.start();

  // --- Event handler registry (mirrors what Bolt App.event() does) ---
  const eventHandlers = new Map<string, EventHandler>();

  // We import createSlackBot but need to intercept @slack/bolt.
  // Since vitest module mocking is file-scoped, we construct the handler
  // logic directly by re-implementing the routing the bot does.
  // This is more robust than trying to override module mocks per-test.
  //
  // We replicate the exact call path from bot.ts:
  //   checkAuthOrPrompt → parseCommand → routeEvent → executeDecision
  const { getValidTokenForUser, storeTokenForUser } =
    await import('../../src/auth/index.js');
  const { parseCommand, executeCommand } =
    await import('../../src/enclave/commands.js');
  const { routeEvent } = await import('../../src/dispatcher/router.js');
  const { handleChannelEvent } = await import('../../src/enclave/drift.js');
  const { randomUUID } = await import('node:crypto');

  /**
   * Auth gate: check if user has a valid token, or start device flow.
   * Returns the token or null.
   *
   * Uses mockDeviceAuth instead of calling real OIDC endpoints, since
   * integration tests don't have a real Keycloak instance.
   */
  async function checkAuth(
    userId: string,
    channelId: string,
    threadTs: string,
  ): Promise<string | null> {
    const token = await getValidTokenForUser(userId);
    if (token !== null) return token;

    // Unauthenticated: use mocked device auth response and post ephemeral
    const deviceAuth = mockDeviceAuth;
    await boltClient.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: threadTs,
      text:
        `*Authentication required.* Open the link below and enter the code:\n` +
        `*URL:* ${deviceAuth.verification_uri_complete ?? deviceAuth.verification_uri}\n` +
        `*Code:* \`${deviceAuth.user_code}\`\n` +
        `_(This code expires in ${Math.floor(deviceAuth.expires_in / 60)} minutes.)_`,
    });

    // No background polling in integration tests - just drop it
    void storeTokenForUser; // ensure import is used

    return null;
  }

  /**
   * Execute a route decision — mirrors executeDecision() in bot.ts.
   */
  async function executeDecision(
    decision: Awaited<ReturnType<typeof routeEvent>>,
    inbound: Parameters<typeof routeEvent>[0],
    threadTs: string,
    userToken: string,
  ): Promise<void> {
    if (decision.path === 'deterministic') {
      const action = decision.action;
      switch (action.type) {
        case 'spawn_and_forward': {
          await teamsManager.spawnTeam(
            action.enclaveName,
            inbound.userId,
            userToken,
          );
          await teamsManager.sendToTeam(action.enclaveName, {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            from: 'dispatcher',
            type: 'user_message',
            threadTs,
            channelId: inbound.channelId,
            userSlackId: inbound.userId,
            userToken,
            message: inbound.text,
          });
          break;
        }
        case 'forward_to_active_team': {
          await teamsManager.sendToTeam(action.enclaveName, {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            from: 'dispatcher',
            type: 'user_message',
            threadTs,
            channelId: inbound.channelId,
            userSlackId: inbound.userId,
            userToken,
            message: inbound.text,
          });
          break;
        }
        case 'ignore_unbound':
        case 'ignore_bot':
        case 'ignore_visitor':
          break;
        default:
          break;
      }
      return;
    }

    // Smart path: not tested by integration harness (no real LLM)
    // Just record it happened
  }

  /**
   * Process an app_mention event.
   */
  async function handleAppMention(event: AppMentionEvent): Promise<void> {
    if ('bot_id' in event) return;

    const threadTs = event.thread_ts ?? event.ts;
    const channelId = event.channel;
    const userId = event.user ?? '';
    const text = event.text ?? '';

    const userToken = await checkAuth(userId, channelId, threadTs);
    if (userToken === null) return;

    // Command router
    const parsed = parseCommand(text);
    if (parsed) {
      const binding = bindings.lookupEnclave(channelId);
      if (binding) {
        await executeCommand(parsed, {
          channelId,
          threadTs,
          senderSlackId: userId,
          enclaveName: binding.enclaveName,
          mcpCall: mockMcpCall,
          sendMessage: async (msgText) => {
            await boltClient.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: msgText,
            });
          },
          resolveEmail: async (slackUserId) => {
            const info = await boltClient.users.info({ user: slackUserId });
            return info.user?.profile?.email;
          },
        });
        return;
      }
      return;
    }

    const inbound = {
      type: 'app_mention' as const,
      channelId,
      threadTs,
      userId,
      text,
    };
    const decision = routeEvent(inbound, { bindings, teams: teamsManager });
    await executeDecision(decision, inbound, threadTs, userToken);
  }

  /**
   * Process a member_left_channel event.
   */
  async function handleMemberLeft(event: MemberLeftEvent): Promise<void> {
    const channelId = event.channel;
    const userId = event.user;
    const binding = bindings.lookupEnclave(channelId);
    if (!binding) return;

    await handleChannelEvent(
      'member_left',
      binding.enclaveName,
      { userId },
      {
        botUserId: 'U_KRAKEN_BOT',
        mcpCall: mockMcpCall,
        getEnclaveInfo: async (name) => {
          try {
            const r = (await mockMcpCall('enclave_info', { name })) as {
              owner?: string;
              members?: string[];
            };
            if (!r?.owner) return undefined;
            return { owner: r.owner, members: r.members ?? [] };
          } catch {
            return undefined;
          }
        },
        invalidateCache: () => undefined,
        resolveEmail: async (slackUserId) => {
          const info = await boltClient.users.info({ user: slackUserId });
          return info.user?.profile?.email;
        },
      },
    );
  }

  /**
   * Process a channel_archive event.
   */
  async function handleChannelArchive(
    event: ChannelArchiveEvent,
  ): Promise<void> {
    const channelId = event.channel;
    const binding = bindings.lookupEnclave(channelId);
    if (!binding) return;

    await handleChannelEvent(
      'channel_archive',
      binding.enclaveName,
      {},
      {
        botUserId: 'U_KRAKEN_BOT',
        mcpCall: mockMcpCall,
        getEnclaveInfo: async (name) => {
          try {
            const r = (await mockMcpCall('enclave_info', { name })) as {
              owner?: string;
              members?: string[];
            };
            if (!r?.owner) return undefined;
            return { owner: r.owner, members: r.members ?? [] };
          } catch {
            return undefined;
          }
        },
        invalidateCache: () => undefined,
        resolveEmail: async () => undefined,
      },
    );
  }

  /**
   * Route an event envelope to the appropriate handler.
   */
  async function sendSlackEvent(envelope: SlackEventEnvelope): Promise<void> {
    const { event } = envelope;

    switch (event.type) {
      case 'app_mention':
        await handleAppMention(event as unknown as AppMentionEvent);
        break;
      case 'member_left_channel':
        await handleMemberLeft(event as unknown as MemberLeftEvent);
        break;
      case 'channel_archive':
        await handleChannelArchive(event as unknown as ChannelArchiveEvent);
        break;
      default:
        // Unhandled event types are silently dropped
        break;
    }
  }

  /**
   * Wait until at least `minCount` messages have been posted to Slack,
   * or until the timeout elapses.
   *
   * Polls the outbound poller by letting it run naturally. Each poll cycle
   * takes up to 1s, so we check frequently.
   */
  async function waitForOutbound(
    minCount = 1,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (slackState.posted.length >= minCount) return;
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    // Final check (throw on actual failure is the test's responsibility)
  }

  /**
   * Shut down all subsystems and clean up temp files.
   */
  async function shutdown(): Promise<void> {
    await poller.stop();
    await teamsManager.shutdownAll();
    db.close();
    if (existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  }

  return {
    sendSlackEvent,
    waitForOutbound,
    mockSlack: slackState,
    mockMcp: { calls: mcpCallLog },
    teams: {
      activeTeams: () => teamsManager.getActiveTeamNames(),
    },
    db,
    shutdown,
  };
}
