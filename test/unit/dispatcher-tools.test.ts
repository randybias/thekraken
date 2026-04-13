/**
 * Dispatcher tools unit tests (T15).
 *
 * Tests each of the four dispatcher tools:
 * - spawn_enclave_team
 * - send_to_team
 * - check_team_status
 * - post_to_slack
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { buildDispatcherTools } from '../../src/tools/dispatcher-tools.js';
import { createTeamFixture } from '../helpers/team-fixture.js';
import { createDatabase } from '../../src/db/migrations.js';
import { TeamLifecycleManager } from '../../src/teams/lifecycle.js';
import type { KrakenConfig } from '../../src/config.js';

// ---------------------------------------------------------------------------
// Mock child_process.spawn (same pattern as team-lifecycle tests)
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawn: vi.fn(
    (
      _cmd: string,
      _args: string[],
      options: { env: Record<string, string> },
    ) => {
      const enclaveName = options.env['KRAKEN_ENCLAVE_NAME'] ?? 'unknown';
      const handlers: Record<string, unknown> = {};
      return {
        pid: 1234,
        killed: false,
        stderr: { on: vi.fn() },
        on: (event: string, handler: unknown) => {
          handlers[event] = handler;
        },
        once: (event: string, handler: unknown) => {
          handlers[event] = handler;
        },
        kill: vi.fn((signal?: string) => {
          setTimeout(() => {
            if (handlers['exit'])
              (handlers['exit'] as (c: number, s: string) => void)(
                0,
                signal ?? 'SIGTERM',
              );
          }, 0);
          return true;
        }),
        __enclaveName: enclaveName,
      };
    },
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(teamsDir: string): KrakenConfig {
  return {
    teamsDir,
    gitState: {
      repoUrl: 'https://github.com/x/y.git',
      branch: 'main',
      dir: '/tmp/git-state',
    },
    slack: { botToken: 'xoxb-test', mode: 'http' },
    oidc: {
      issuer: 'https://keycloak',
      clientId: 'kraken',
      clientSecret: 'sec',
    },
    mcp: { url: 'http://mcp:8080', port: 8080, serviceToken: 'svc-token' },
    llm: {
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
      allowedProviders: ['anthropic'],
      allowedModels: {},
      disallowedModels: [],
      anthropicApiKey: 'sk-ant-test',
    },
    server: { port: 3000 },
    observability: { otlpEndpoint: '', logLevel: 'silent' },
  } as KrakenConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildDispatcherTools', () => {
  const fixtures: ReturnType<typeof createTeamFixture>[] = [];
  let fixture: ReturnType<typeof createTeamFixture>;
  let teams: TeamLifecycleManager;
  const postedMessages: Array<{
    channel: string;
    thread_ts?: string;
    text: string;
  }> = [];

  beforeEach(() => {
    fixture = createTeamFixture('test-enclave');
    fixtures.push(fixture);

    const db = createDatabase(':memory:');
    teams = new TeamLifecycleManager(makeConfig(fixture.teamsDir), db);
    postedMessages.length = 0;
  });

  afterEach(async () => {
    await teams.shutdownAll();
    for (const f of fixtures.splice(0)) f.cleanup();
    vi.clearAllMocks();
  });

  function makeDeps() {
    return {
      config: makeConfig(fixture.teamsDir),
      teams,
      slack: {
        postMessage: vi.fn(
          async (params: {
            channel: string;
            thread_ts?: string;
            text: string;
          }) => {
            postedMessages.push(params);
            return { ts: `ts-${Date.now()}` };
          },
        ),
      },
    };
  }

  it('returns 4 tools', () => {
    const tools = buildDispatcherTools(makeDeps());
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toContain('spawn_enclave_team');
    expect(names).toContain('send_to_team');
    expect(names).toContain('check_team_status');
    expect(names).toContain('post_to_slack');
  });

  describe('spawn_enclave_team', () => {
    it('spawns a team and returns status', async () => {
      const tools = buildDispatcherTools(makeDeps());
      const tool = tools.find((t) => t.name === 'spawn_enclave_team')!;

      const result = JSON.parse(
        await tool.execute({
          enclaveName: 'test-enclave',
          userSlackId: 'U_ALICE',
          userToken: 'token-alice',
        }),
      ) as { action: string; isActive: boolean };

      expect(result.action).toBe('spawned');
      expect(result.isActive).toBe(true);
    });

    it('returns refreshed if team already active', async () => {
      const tools = buildDispatcherTools(makeDeps());
      const tool = tools.find((t) => t.name === 'spawn_enclave_team')!;

      await tool.execute({
        enclaveName: 'test-enclave',
        userSlackId: 'U_ALICE',
        userToken: 'token-alice',
      });

      const result = JSON.parse(
        await tool.execute({
          enclaveName: 'test-enclave',
          userSlackId: 'U_ALICE',
          userToken: 'token-alice',
        }),
      ) as { action: string };

      expect(result.action).toBe('refreshed');
    });
  });

  describe('send_to_team', () => {
    it('writes a mailbox record', async () => {
      // First spawn the team
      await teams.spawnTeam('test-enclave', 'U_ALICE', 'token-alice');

      const tools = buildDispatcherTools(makeDeps());
      const tool = tools.find((t) => t.name === 'send_to_team')!;

      await tool.execute({
        enclaveName: 'test-enclave',
        threadTs: '1111.000',
        channelId: 'C_TEST',
        message: 'build a tentacle',
        userSlackId: 'U_ALICE',
        userToken: 'token-alice',
      });

      const records = fixture.readMailbox();
      expect(records).toHaveLength(1);
      expect((records[0] as { message: string }).message).toBe(
        'build a tentacle',
      );
    });

    it('result indicates sent=true', async () => {
      const tools = buildDispatcherTools(makeDeps());
      const tool = tools.find((t) => t.name === 'send_to_team')!;

      const result = JSON.parse(
        await tool.execute({
          enclaveName: 'test-enclave',
          threadTs: '1111.000',
          channelId: 'C_TEST',
          message: 'hello',
          userSlackId: 'U_ALICE',
          userToken: 'token-alice',
        }),
      ) as { sent: boolean };

      expect(result.sent).toBe(true);
    });
  });

  describe('check_team_status', () => {
    it('returns inactive status when no team spawned', async () => {
      const tools = buildDispatcherTools(makeDeps());
      const tool = tools.find((t) => t.name === 'check_team_status')!;

      const result = JSON.parse(
        await tool.execute({ enclaveName: 'test-enclave' }),
      ) as { isActive: boolean };

      expect(result.isActive).toBe(false);
    });

    it('returns active status when team is running', async () => {
      await teams.spawnTeam('test-enclave', 'U_ALICE', 'token-alice');

      const tools = buildDispatcherTools(makeDeps());
      const tool = tools.find((t) => t.name === 'check_team_status')!;

      const result = JSON.parse(
        await tool.execute({ enclaveName: 'test-enclave' }),
      ) as { isActive: boolean };

      expect(result.isActive).toBe(true);
    });

    it('includes recent signals when available', async () => {
      await teams.spawnTeam('test-enclave', 'U_ALICE', 'token-alice');
      fixture.appendSignal({ type: 'task_completed', message: 'done' });

      const tools = buildDispatcherTools(makeDeps());
      const tool = tools.find((t) => t.name === 'check_team_status')!;

      const result = JSON.parse(
        await tool.execute({ enclaveName: 'test-enclave' }),
      ) as { recentSignals: object[] };

      expect(result.recentSignals).toHaveLength(1);
    });
  });

  describe('post_to_slack', () => {
    it('calls slack.postMessage with correct params', async () => {
      const tools = buildDispatcherTools(makeDeps());
      const tool = tools.find((t) => t.name === 'post_to_slack')!;

      await tool.execute({
        channelId: 'C_CHAN',
        threadTs: '9999.000',
        text: 'Hello from dispatcher',
      });

      expect(postedMessages).toHaveLength(1);
      expect(postedMessages[0]!.channel).toBe('C_CHAN');
      expect(postedMessages[0]!.text).toBe('Hello from dispatcher');
      expect(postedMessages[0]!.thread_ts).toBe('9999.000');
    });

    it('posts without thread_ts when not provided', async () => {
      const tools = buildDispatcherTools(makeDeps());
      const tool = tools.find((t) => t.name === 'post_to_slack')!;

      await tool.execute({ channelId: 'C_CHAN', text: 'New thread' });

      expect(postedMessages[0]!.thread_ts).toBeUndefined();
    });

    it('result indicates posted=true', async () => {
      const tools = buildDispatcherTools(makeDeps());
      const tool = tools.find((t) => t.name === 'post_to_slack')!;

      const result = JSON.parse(
        await tool.execute({ channelId: 'C_CHAN', text: 'hello' }),
      ) as { posted: boolean };

      expect(result.posted).toBe(true);
    });
  });
});
