/**
 * Integration test: commission_dev_team bridge dispatch (C6 Must-fix #1).
 *
 * Tests the bridge-driven commission flow end-to-end using a mock spawn
 * factory — no real pi subprocess. Covers:
 *
 * 1. Writing commission_dev_team to signals-out.ndjson triggers one spawn
 *    with the correct role, env, and cwd.
 * 2. Writing terminate_dev_team sends SIGTERM to the matching handle.
 * 3. A dev team child that exits without emitting a terminal signal causes
 *    a synthetic task_failed record in signals-in.ndjson.
 * 4. A dev team that writes task_completed before exiting does NOT generate
 *    a synthetic task_failed.
 * 5. Duplicate commission for the same taskId emits task_failed(duplicate_commission).
 *
 * The mock spawn factory returns a controllable fake ChildProcess. No LLM
 * calls, no real pi subprocess, no network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { createTeamFixture } from '../helpers/team-fixture.js';
import { appendNdjson, NdjsonReader } from '../../src/teams/ndjson.js';
import {
  makeCommissionDevTeam,
  makeTerminateDevTeam,
  makeTaskCompleted,
  makeTaskFailed,
  decodeInboundSignal,
  decodeOutboundSignal,
  SIGNALS_IN_FILE,
  SIGNALS_OUT_FILE,
} from '../../src/teams/signals.js';
import type { DevTeamSpawnOptions } from '../../src/teams/bridge.js';
import type { MailboxRecord } from '../../src/teams/lifecycle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A minimal fake ChildProcess that lets the test control:
 * - when it emits 'exit'
 * - whether it was killed via SIGTERM
 */
interface FakeChildProcess {
  proc: ChildProcess;
  triggerExit: (code: number, signal?: string) => void;
  readonly killedWith: string | null;
}

function makeFakeChildProcess(): FakeChildProcess {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  let killedWith: string | null = null;

  const proc = {
    pid: Math.floor(Math.random() * 10000) + 1000,
    killed: false,
    stdin: null,
    stdout: {
      on: (_ev: string, _fn: unknown) => proc.stdout,
    },
    stderr: {
      on: (_ev: string, _fn: unknown) => proc.stderr,
    },
    on: (event: string, fn: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event]!.push(fn);
      return proc;
    },
    once: (event: string, fn: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event]!.push(fn);
      return proc;
    },
    kill: (signal?: string) => {
      killedWith = signal ?? 'SIGTERM';
      proc.killed = true;
      // Emit exit asynchronously like a real process.
      setTimeout(() => {
        for (const fn of listeners['exit'] ?? []) fn(null, signal ?? 'SIGTERM');
      }, 5);
      return true;
    },
  } as unknown as ChildProcess;

  return {
    proc,
    triggerExit: (code: number, signal?: string) => {
      for (const fn of listeners['exit'] ?? []) fn(code, signal ?? null);
    },
    get killedWith() {
      return killedWith;
    },
  };
}

/** Minimal mailbox record for driving driveSignalsPollForTest(). */
function makeMailboxRecord(overrides?: Partial<MailboxRecord>): MailboxRecord {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    from: 'dispatcher',
    type: 'user_message',
    threadTs: '1234567890.000001',
    channelId: 'C01234',
    userSlackId: 'U99999',
    userToken:
      'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMSIsImV4cCI6OTk5OTk5OTk5OX0.sig',
    message: 'build a hello-world tentacle',
    ...overrides,
  };
}

/** Write a minimal token.json so dispatchDevTeam can find a token. */
function writeMinimalTokenFile(dir: string): void {
  const tokenPath = join(dir, 'token.json');
  writeFileSync(
    tokenPath,
    JSON.stringify({
      access_token:
        'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMSIsImV4cCI6OTk5OTk5OTk5OX0.sig',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      updated_at: new Date().toISOString(),
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
}

/** Read all inbound signals from signals-in.ndjson. */
function readSignalsIn(sigInPath: string) {
  if (!existsSync(sigInPath)) return [];
  const content = readFileSync(sigInPath, 'utf8');
  return content
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Signal direction partitioning (no bridge required)
// ---------------------------------------------------------------------------

describe('commission_dev_team: signal partitioning and direction validation', () => {
  const fixtures: ReturnType<typeof createTeamFixture>[] = [];

  afterEach(() => {
    for (const f of fixtures.splice(0)) f.cleanup();
  });

  it('commission_dev_team is outbound — decodeInboundSignal must reject it', () => {
    const fixture = createTeamFixture('commission-dispatch-test');
    fixtures.push(fixture);

    const signal = makeCommissionDevTeam({
      taskId: 'task-dispatch-1',
      goal: 'Build a data ingestion tentacle',
      role: 'builder',
      tentacleName: 'data-ingestion',
    });

    appendNdjson(fixture.signalsOutPath, signal);

    const reader = new NdjsonReader(fixture.signalsOutPath);
    const records = reader.readNew();
    expect(records).toHaveLength(1);

    const raw = records[0]!;
    const decoded = decodeInboundSignal(JSON.stringify(raw));
    expect(decoded).toBeNull();
  });

  it('task_completed is inbound — decodeInboundSignal must accept it', () => {
    const fixture = createTeamFixture('commission-inbound-test');
    fixtures.push(fixture);

    const signal = makeTaskCompleted({
      taskId: 'task-dispatch-1',
      result: 'Tentacle deployed at v1.0.0',
    });

    appendNdjson(fixture.signalsInPath, signal);

    const reader = new NdjsonReader(fixture.signalsInPath);
    const records = reader.readNew();
    expect(records).toHaveLength(1);

    const decoded = decodeInboundSignal(JSON.stringify(records[0]!));
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe('task_completed');
  });

  it('decodeOutboundSignal rejects commission_dev_team with missing required fields', () => {
    // Missing "goal"
    const bad = JSON.stringify({
      type: 'commission_dev_team',
      taskId: 'task-1',
      role: 'builder',
      timestamp: new Date().toISOString(),
    });
    expect(decodeOutboundSignal(bad)).toBeNull();

    // Missing "role"
    const bad2 = JSON.stringify({
      type: 'commission_dev_team',
      taskId: 'task-1',
      goal: 'do something',
      timestamp: new Date().toISOString(),
    });
    expect(decodeOutboundSignal(bad2)).toBeNull();

    // Invalid role value
    const bad3 = JSON.stringify({
      type: 'commission_dev_team',
      taskId: 'task-1',
      goal: 'do something',
      role: 'hacker',
      timestamp: new Date().toISOString(),
    });
    expect(decodeOutboundSignal(bad3)).toBeNull();
  });

  it('decodeInboundSignal rejects task_failed with no reason or error field', () => {
    const bad = JSON.stringify({
      type: 'task_failed',
      taskId: 'task-1',
      timestamp: new Date().toISOString(),
    });
    expect(decodeInboundSignal(bad)).toBeNull();
  });

  it('decodeInboundSignal rejects progress_update with missing message', () => {
    const bad = JSON.stringify({
      type: 'progress_update',
      taskId: 'task-1',
      timestamp: new Date().toISOString(),
    });
    expect(decodeInboundSignal(bad)).toBeNull();
  });

  it('decodeOutboundSignal rejects any signal with missing taskId', () => {
    const bad = JSON.stringify({
      type: 'terminate_dev_team',
      timestamp: new Date().toISOString(),
      // taskId intentionally absent
    });
    expect(decodeOutboundSignal(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bridge dispatch integration tests (mock spawn factory, no real pi)
// ---------------------------------------------------------------------------

describe('commission_dev_team: mock spawn factory (bridge dispatch logic)', () => {
  const fixtures: ReturnType<typeof createTeamFixture>[] = [];

  afterEach(() => {
    for (const f of fixtures.splice(0)) f.cleanup();
    vi.useRealTimers();
  });

  it('spawnDevTeam is called with correct role and env when commission_dev_team appears', async () => {
    const fixture = createTeamFixture('commission-spawn-test');
    fixtures.push(fixture);

    writeMinimalTokenFile(fixture.dir);

    const spawned: DevTeamSpawnOptions[] = [];
    const fakeHandles: FakeChildProcess[] = [];

    const spawnFactory = (opts: DevTeamSpawnOptions): ChildProcess => {
      spawned.push(opts);
      const fake = makeFakeChildProcess();
      fakeHandles.push(fake);
      return fake.proc;
    };

    const { TeamBridge } = await import('../../src/teams/bridge.js');

    const bridge = new TeamBridge({
      enclaveName: 'test-enclave',
      teamDir: fixture.dir,
      gitStateDir: fixture.dir,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      env: {
        PATH: '/usr/bin',
        KRAKEN_ENCLAVE_NAME: 'test-enclave',
        TENTACULAR_CLUSTER: 'eastus',
        TNTC_MCP_ENDPOINT: 'http://mcp.test:8080',
        KRAKEN_TOKEN_FILE: join(fixture.dir, 'token.json'),
      },
      piCliPath: '/usr/local/bin/pi',
      spawnDevTeam: spawnFactory,
    });

    // Write commission signal to signals-out.ndjson before driving poll.
    appendNdjson(
      fixture.signalsOutPath,
      makeCommissionDevTeam({
        taskId: 'task-spawn-1',
        goal: 'Build a hello-world tentacle',
        role: 'builder',
      }),
    );

    // Drive the bridge dispatch path directly (no real pi RPC needed).
    const record = makeMailboxRecord();
    await bridge.driveSignalsPollForTest(record);

    // Assert the mock factory was called exactly once with correct role.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.role).toBe('builder');
    expect(spawned[0]!.taskId).toBe('task-spawn-1');
    expect(spawned[0]!.goal).toBe('Build a hello-world tentacle');

    // KRAKEN_TOKEN_FILE must be set in dev team env.
    expect(spawned[0]!.env['KRAKEN_TOKEN_FILE']).toBeDefined();
    expect(spawned[0]!.env['KRAKEN_TOKEN_FILE']).not.toBe('');

    // TNTC_ACCESS_TOKEN must NOT be in dev team env (B2/D6).
    expect(spawned[0]!.env['TNTC_ACCESS_TOKEN']).toBeUndefined();

    // TENTACULAR_CLUSTER and TNTC_MCP_ENDPOINT must be present (C3).
    expect(spawned[0]!.env['TENTACULAR_CLUSTER']).toBe('eastus');
    expect(spawned[0]!.env['TNTC_MCP_ENDPOINT']).toBe('http://mcp.test:8080');

    // task_started should be in signals-in.ndjson (written before subprocess spawn).
    const sigInRecords = readSignalsIn(fixture.signalsInPath);
    const started = sigInRecords.find(
      (r) => r['type'] === 'task_started' && r['taskId'] === 'task-spawn-1',
    );
    expect(started).toBeDefined();
  });

  it('terminate_dev_team signal sends SIGTERM to the matching handle', async () => {
    const fixture = createTeamFixture('terminate-test');
    fixtures.push(fixture);

    writeMinimalTokenFile(fixture.dir);

    const fakeHandles: FakeChildProcess[] = [];
    const spawnFactory = (opts: DevTeamSpawnOptions): ChildProcess => {
      void opts;
      const fake = makeFakeChildProcess();
      fakeHandles.push(fake);
      return fake.proc;
    };

    const { TeamBridge } = await import('../../src/teams/bridge.js');

    const bridge = new TeamBridge({
      enclaveName: 'test-enclave',
      teamDir: fixture.dir,
      gitStateDir: fixture.dir,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      env: {
        PATH: '/usr/bin',
        KRAKEN_ENCLAVE_NAME: 'test-enclave',
        TENTACULAR_CLUSTER: 'eastus',
        TNTC_MCP_ENDPOINT: 'http://mcp.test:8080',
        KRAKEN_TOKEN_FILE: join(fixture.dir, 'token.json'),
      },
      piCliPath: '/usr/local/bin/pi',
      spawnDevTeam: spawnFactory,
    });

    const record = makeMailboxRecord();

    // Commission the team first.
    appendNdjson(
      fixture.signalsOutPath,
      makeCommissionDevTeam({
        taskId: 'task-term-1',
        goal: 'Long running build',
        role: 'builder',
      }),
    );
    await bridge.driveSignalsPollForTest(record);

    expect(fakeHandles).toHaveLength(1);
    const fakeHandle = fakeHandles[0]!;
    expect(fakeHandle.killedWith).toBeNull();

    // Now send terminate signal.
    appendNdjson(
      fixture.signalsOutPath,
      makeTerminateDevTeam({ taskId: 'task-term-1' }),
    );
    await bridge.driveSignalsPollForTest(record);

    // Fake process should have been killed with SIGTERM.
    // Give the async kill() a moment to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(fakeHandle.killedWith).toBe('SIGTERM');
  });

  it('premature child exit (no terminal signal) synthesizes task_failed in signals-in.ndjson', async () => {
    const fixture = createTeamFixture('premature-exit-test');
    fixtures.push(fixture);

    writeMinimalTokenFile(fixture.dir);

    const fakeHandles: FakeChildProcess[] = [];
    const spawnFactory = (opts: DevTeamSpawnOptions): ChildProcess => {
      void opts;
      const fake = makeFakeChildProcess();
      fakeHandles.push(fake);
      return fake.proc;
    };

    const { TeamBridge } = await import('../../src/teams/bridge.js');

    const bridge = new TeamBridge({
      enclaveName: 'test-enclave',
      teamDir: fixture.dir,
      gitStateDir: fixture.dir,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      env: {
        PATH: '/usr/bin',
        KRAKEN_ENCLAVE_NAME: 'test-enclave',
        TENTACULAR_CLUSTER: 'eastus',
        TNTC_MCP_ENDPOINT: 'http://mcp.test:8080',
        KRAKEN_TOKEN_FILE: join(fixture.dir, 'token.json'),
      },
      piCliPath: '/usr/local/bin/pi',
      spawnDevTeam: spawnFactory,
    });

    appendNdjson(
      fixture.signalsOutPath,
      makeCommissionDevTeam({
        taskId: 'task-premature-1',
        goal: 'build something',
        role: 'builder',
      }),
    );

    await bridge.driveSignalsPollForTest(makeMailboxRecord());
    expect(fakeHandles).toHaveLength(1);

    // Simulate child exit without writing any terminal signal.
    fakeHandles[0]!.triggerExit(1);
    // Give the exit handler a tick to run.
    await new Promise((r) => setTimeout(r, 10));

    const sigInRecords = readSignalsIn(fixture.signalsInPath);
    const failed = sigInRecords.find(
      (r) => r['type'] === 'task_failed' && r['taskId'] === 'task-premature-1',
    );
    expect(failed).toBeDefined();
    expect(String(failed!['error'])).toContain('premature_exit');
  });

  it('fast-success child (writes task_completed then exits) does NOT generate spurious task_failed', async () => {
    const fixture = createTeamFixture('clean-exit-test');
    fixtures.push(fixture);

    writeMinimalTokenFile(fixture.dir);

    const fakeHandles: FakeChildProcess[] = [];
    const spawnFactory = (opts: DevTeamSpawnOptions): ChildProcess => {
      void opts;
      const fake = makeFakeChildProcess();
      fakeHandles.push(fake);
      return fake.proc;
    };

    const { TeamBridge } = await import('../../src/teams/bridge.js');

    const bridge = new TeamBridge({
      enclaveName: 'test-enclave',
      teamDir: fixture.dir,
      gitStateDir: fixture.dir,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      env: {
        PATH: '/usr/bin',
        KRAKEN_ENCLAVE_NAME: 'test-enclave',
        TENTACULAR_CLUSTER: 'eastus',
        TNTC_MCP_ENDPOINT: 'http://mcp.test:8080',
        KRAKEN_TOKEN_FILE: join(fixture.dir, 'token.json'),
      },
      piCliPath: '/usr/local/bin/pi',
      spawnDevTeam: spawnFactory,
    });

    appendNdjson(
      fixture.signalsOutPath,
      makeCommissionDevTeam({
        taskId: 'task-clean-1',
        goal: 'build something',
        role: 'builder',
      }),
    );

    await bridge.driveSignalsPollForTest(makeMailboxRecord());
    expect(fakeHandles).toHaveLength(1);

    // Simulate dev team writing task_completed to signals-in.ndjson BEFORE exit.
    appendNdjson(
      fixture.signalsInPath,
      makeTaskCompleted({ taskId: 'task-clean-1', result: 'Success' }),
    );

    // Simulate fast successful exit.
    fakeHandles[0]!.triggerExit(0);
    await new Promise((r) => setTimeout(r, 10));

    // Only task_started and task_completed should be in signals-in — no task_failed.
    const sigInRecords = readSignalsIn(fixture.signalsInPath);
    const failed = sigInRecords.filter(
      (r) => r['type'] === 'task_failed' && r['taskId'] === 'task-clean-1',
    );
    expect(failed).toHaveLength(0);

    // task_completed must be present.
    const completed = sigInRecords.find(
      (r) => r['type'] === 'task_completed' && r['taskId'] === 'task-clean-1',
    );
    expect(completed).toBeDefined();
  });

  it('duplicate commission for same taskId emits task_failed(duplicate_commission)', async () => {
    const fixture = createTeamFixture('duplicate-commission-test');
    fixtures.push(fixture);

    writeMinimalTokenFile(fixture.dir);

    const spawned: DevTeamSpawnOptions[] = [];
    const fakeHandles: FakeChildProcess[] = [];
    const spawnFactory = (opts: DevTeamSpawnOptions): ChildProcess => {
      spawned.push(opts);
      const fake = makeFakeChildProcess();
      fakeHandles.push(fake);
      return fake.proc;
    };

    const { TeamBridge } = await import('../../src/teams/bridge.js');

    const bridge = new TeamBridge({
      enclaveName: 'test-enclave',
      teamDir: fixture.dir,
      gitStateDir: fixture.dir,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      env: {
        PATH: '/usr/bin',
        KRAKEN_ENCLAVE_NAME: 'test-enclave',
        TENTACULAR_CLUSTER: 'eastus',
        TNTC_MCP_ENDPOINT: 'http://mcp.test:8080',
        KRAKEN_TOKEN_FILE: join(fixture.dir, 'token.json'),
      },
      piCliPath: '/usr/local/bin/pi',
      spawnDevTeam: spawnFactory,
    });

    // Commission the same taskId twice in the same batch.
    const record = makeMailboxRecord();
    appendNdjson(
      fixture.signalsOutPath,
      makeCommissionDevTeam({
        taskId: 'task-dup-1',
        goal: 'Build a hello-world tentacle',
        role: 'builder',
      }),
    );
    appendNdjson(
      fixture.signalsOutPath,
      makeCommissionDevTeam({
        taskId: 'task-dup-1',
        goal: 'Build a hello-world tentacle',
        role: 'builder',
      }),
    );

    await bridge.driveSignalsPollForTest(record);

    // Only one subprocess should have been spawned.
    expect(spawned).toHaveLength(1);

    // A task_failed(duplicate_commission) must be in signals-in for the duplicate.
    const sigInRecords = readSignalsIn(fixture.signalsInPath);
    const dupFailed = sigInRecords.find(
      (r) =>
        r['type'] === 'task_failed' &&
        r['taskId'] === 'task-dup-1' &&
        String(r['error']).includes('duplicate_commission'),
    );
    expect(dupFailed).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Spawn env contract regression (C3)
// ---------------------------------------------------------------------------

describe('commission_dev_team: spawn env contract (C3 regression)', () => {
  const fixtures: ReturnType<typeof createTeamFixture>[] = [];

  afterEach(() => {
    for (const f of fixtures.splice(0)) f.cleanup();
  });

  it('spawn env must include TENTACULAR_CLUSTER, TNTC_MCP_ENDPOINT, KRAKEN_TOKEN_FILE, KRAKEN_ENCLAVE_NAME — and must NOT include TNTC_ACCESS_TOKEN', async () => {
    const fixture = createTeamFixture('env-contract-test');
    fixtures.push(fixture);

    writeMinimalTokenFile(fixture.dir);

    const spawned: DevTeamSpawnOptions[] = [];
    const spawnFactory = (opts: DevTeamSpawnOptions): ChildProcess => {
      spawned.push(opts);
      return makeFakeChildProcess().proc;
    };

    const { TeamBridge } = await import('../../src/teams/bridge.js');

    const bridge = new TeamBridge({
      enclaveName: 'my-enclave',
      teamDir: fixture.dir,
      gitStateDir: fixture.dir,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      env: {
        PATH: '/usr/bin',
        KRAKEN_ENCLAVE_NAME: 'my-enclave',
        TENTACULAR_CLUSTER: 'eastus',
        TNTC_MCP_ENDPOINT: 'http://mcp.test:8080',
        KRAKEN_TOKEN_FILE: join(fixture.dir, 'token.json'),
      },
      piCliPath: '/usr/local/bin/pi',
      spawnDevTeam: spawnFactory,
    });

    appendNdjson(
      fixture.signalsOutPath,
      makeCommissionDevTeam({
        taskId: 'task-env-1',
        goal: 'Build something',
        role: 'builder',
      }),
    );

    await bridge.driveSignalsPollForTest(makeMailboxRecord());
    expect(spawned).toHaveLength(1);

    const env = spawned[0]!.env;

    // Required env vars (C3).
    expect(env['TENTACULAR_CLUSTER']).toBe('eastus');
    expect(env['TNTC_MCP_ENDPOINT']).toBe('http://mcp.test:8080');
    expect(env['KRAKEN_TOKEN_FILE']).toBeDefined();
    expect(env['KRAKEN_ENCLAVE_NAME']).toBe('my-enclave');

    // B2/D6: TNTC_ACCESS_TOKEN must NOT be in spawn env.
    expect(env['TNTC_ACCESS_TOKEN']).toBeUndefined();

    // KUBECONFIG must NOT be in spawn env (teams use tntc→MCP only).
    expect(env['KUBECONFIG']).toBeUndefined();
  });
});
