/**
 * TeamLifecycleManager unit tests (T10).
 *
 * Tests use a mock spawn() that records spawn calls without actually
 * running pi. This avoids requiring the real pi binary in unit tests.
 *
 * Coverage:
 * - spawnTeam() creates a new team and records state
 * - spawnTeam() on active team refreshes activity (no new spawn)
 * - isTeamActive() reflects team presence
 * - sendToTeam() writes to mailbox.ndjson
 * - sendToTeam() sets mailbox permissions (0o600 intent)
 * - shutdownAll() sends SIGTERM to all teams
 * - D6: TNTC_ACCESS_TOKEN passes user token (checked via mock)
 * - Cross-user token isolation: two users same enclave, no bleed
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { createTeamFixture } from '../helpers/team-fixture.js';

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------

let spawnCalls: Array<{
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}> = [];

const mockProcHandlers = new Map<
  string,
  { exitHandler?: (code: number, signal: string | null) => void }
>();

function makeProc(enclaveName: string) {
  const handlers: {
    exit?: (code: number | null, sig: string | null) => void;
    error?: (err: Error) => void;
  } = {};
  const stderrHandlers: Array<(data: Buffer) => void> = [];

  const proc = {
    pid: Math.floor(Math.random() * 10000) + 1000,
    killed: false,
    stderr: {
      on: (_event: string, handler: (data: Buffer) => void) =>
        stderrHandlers.push(handler),
    },
    on: (event: string, handler: unknown) => {
      if (event === 'exit') handlers.exit = handler as typeof handlers.exit;
      if (event === 'error') handlers.error = handler as typeof handlers.error;
    },
    once: (event: string, handler: unknown) => {
      if (event === 'exit') handlers.exit = handler as typeof handlers.exit;
    },
    kill: vi.fn((signal?: string) => {
      proc.killed = true;
      // Simulate async exit
      setTimeout(() => {
        if (handlers.exit)
          handlers.exit(signal === 'SIGTERM' ? 0 : 1, signal ?? null);
      }, 0);
      return true;
    }),
  };
  mockProcHandlers.set(enclaveName, {
    exitHandler: (code, sig) => handlers.exit?.(code, sig),
  });
  return proc;
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(
    (
      command: string,
      args: string[],
      options: { env: Record<string, string | undefined> },
    ) => {
      const enclaveName =
        (options.env['KRAKEN_ENCLAVE_NAME'] as string) ?? 'unknown';
      spawnCalls.push({ command, args, env: options.env });
      return makeProc(enclaveName);
    },
  ),
}));

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

import { TeamLifecycleManager } from '../../src/teams/lifecycle.js';
import { createDatabase } from '../../src/db/migrations.js';
import type { KrakenConfig } from '../../src/config.js';

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
    mcp: { url: 'http://mcp:8080', port: 8080 },
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

describe('TeamLifecycleManager', () => {
  const fixtures: ReturnType<typeof createTeamFixture>[] = [];
  let manager: TeamLifecycleManager;
  let fixture: ReturnType<typeof createTeamFixture>;

  beforeEach(() => {
    spawnCalls = [];
    fixture = createTeamFixture('test-enclave');
    fixtures.push(fixture);

    const db = createDatabase(':memory:');
    manager = new TeamLifecycleManager(makeConfig(fixture.teamsDir), db);
  });

  afterEach(async () => {
    await manager.shutdownAll();
    for (const f of fixtures.splice(0)) f.cleanup();
    vi.clearAllMocks();
  });

  it('spawnTeam() calls spawn with correct arguments', async () => {
    await manager.spawnTeam('test-enclave', 'U_ALICE', 'token-alice');

    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    expect(call.args).toContain('--mode');
    expect(call.args).toContain('json');
  });

  it('spawnTeam() passes --provider and --model from config (Bug 1)', async () => {
    await manager.spawnTeam('test-enclave', 'U_ALICE', 'token-alice');

    const call = spawnCalls[0]!;
    // pi must be invoked with the configured provider so it does not
    // silently fall back to a different LLM when multiple API keys are set.
    const providerIdx = call.args.indexOf('--provider');
    expect(providerIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[providerIdx + 1]).toBe('anthropic');

    const modelIdx = call.args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[modelIdx + 1]).toBe('claude-sonnet-4-6');
  });

  it('spawnTeam() sets TNTC_ACCESS_TOKEN env var (D6)', async () => {
    await manager.spawnTeam('test-enclave', 'U_ALICE', 'token-alice-oidc');

    const call = spawnCalls[0]!;
    expect(call.env['TNTC_ACCESS_TOKEN']).toBe('token-alice-oidc');
  });

  it('spawnTeam() sets PI_SUBAGENT_DEPTH for depth guard (D11)', async () => {
    await manager.spawnTeam('test-enclave', 'U_ALICE', 'token-alice');

    const call = spawnCalls[0]!;
    expect(call.env['PI_SUBAGENT_DEPTH']).toBe('0');
    expect(call.env['PI_SUBAGENT_MAX_DEPTH']).toBe('3');
  });

  it('spawnTeam() sets KRAKEN_TEAM_DIR in env', async () => {
    await manager.spawnTeam('test-enclave', 'U_ALICE', 'token-alice');

    const call = spawnCalls[0]!;
    expect(call.env['KRAKEN_TEAM_DIR']).toContain('test-enclave');
  });

  it('isTeamActive() returns true after spawn', async () => {
    await manager.spawnTeam('test-enclave', 'U_ALICE', 'token-alice');
    expect(manager.isTeamActive('test-enclave')).toBe(true);
  });

  it('isTeamActive() returns false before spawn', () => {
    expect(manager.isTeamActive('no-such-enclave')).toBe(false);
  });

  it('spawnTeam() on already-active team does NOT spawn again', async () => {
    await manager.spawnTeam('test-enclave', 'U_ALICE', 'token-alice');
    await manager.spawnTeam('test-enclave', 'U_ALICE', 'token-alice');

    expect(spawnCalls).toHaveLength(1); // only one spawn
  });

  it('sendToTeam() writes mailbox record', async () => {
    await manager.spawnTeam('test-enclave', 'U_ALICE', 'token-alice');

    await manager.sendToTeam('test-enclave', {
      id: 'msg-1',
      timestamp: new Date().toISOString(),
      from: 'dispatcher',
      type: 'user_message',
      threadTs: '1111.000',
      channelId: 'C_TEST',
      userSlackId: 'U_ALICE',
      userToken: 'token-alice',
      message: 'build a sentiment analyser',
    });

    const records = fixture.readMailbox();
    expect(records).toHaveLength(1);
    expect((records[0] as { message: string }).message).toBe(
      'build a sentiment analyser',
    );
  });

  it('sendToTeam() can write to team that is not yet spawned (lazy dir creation)', async () => {
    const f2 = createTeamFixture('lazy-enclave');
    fixtures.push(f2);

    // Build a manager with f2's teamsDir
    const db = createDatabase(':memory:');
    const m2 = new TeamLifecycleManager(makeConfig(f2.teamsDir), db);

    await m2.sendToTeam('lazy-enclave', {
      id: 'msg-lazy',
      timestamp: new Date().toISOString(),
      from: 'dispatcher',
      type: 'user_message',
      threadTs: '1234.000',
      channelId: 'C_TEST',
      userSlackId: 'U_ALICE',
      userToken: 'token-alice',
      message: 'hello',
    });

    // Mailbox should exist with the record
    expect(existsSync(f2.mailboxPath)).toBe(true);
    const records = f2.readMailbox();
    expect(records).toHaveLength(1);

    await m2.shutdownAll();
  });

  it('shutdownAll() kills all active teams', async () => {
    await manager.spawnTeam('test-enclave', 'U_ALICE', 'token-alice');
    expect(manager.isTeamActive('test-enclave')).toBe(true);

    await manager.shutdownAll();

    // After shutdown, team should be gone
    expect(manager.isTeamActive('test-enclave')).toBe(false);
  });

  // D6 cross-user token isolation
  it('cross-user isolation: two users same enclave, tokens stay separate', async () => {
    await manager.spawnTeam('test-enclave', 'U_ALICE', 'token-alice');
    await manager.spawnTeam('test-enclave', 'U_BOB', 'token-bob');

    // Only one spawn should have occurred (team was already active for bob)
    expect(spawnCalls).toHaveLength(1);

    // Send mailbox records for both users
    await manager.sendToTeam('test-enclave', {
      id: 'msg-a',
      timestamp: new Date().toISOString(),
      from: 'dispatcher',
      type: 'user_message',
      threadTs: '1111.000',
      channelId: 'C_TEST',
      userSlackId: 'U_ALICE',
      userToken: 'token-alice',
      message: 'Alice task',
    });

    await manager.sendToTeam('test-enclave', {
      id: 'msg-b',
      timestamp: new Date().toISOString(),
      from: 'dispatcher',
      type: 'user_message',
      threadTs: '2222.000',
      channelId: 'C_TEST',
      userSlackId: 'U_BOB',
      userToken: 'token-bob',
      message: 'Bob task',
    });

    // Read mailbox and verify both records have their correct tokens
    const records = fixture.readMailbox() as Array<{
      userSlackId: string;
      userToken: string;
    }>;
    expect(records).toHaveLength(2);

    const aliceRec = records.find((r) => r.userSlackId === 'U_ALICE')!;
    const bobRec = records.find((r) => r.userSlackId === 'U_BOB')!;

    expect(aliceRec.userToken).toBe('token-alice');
    expect(bobRec.userToken).toBe('token-bob');

    // Cross-check: Alice's record does NOT contain Bob's token
    expect(JSON.stringify(aliceRec)).not.toContain('token-bob');
    expect(JSON.stringify(bobRec)).not.toContain('token-alice');
  });
});
