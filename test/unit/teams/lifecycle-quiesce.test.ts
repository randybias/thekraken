/**
 * Fix K (v0.10.4) — no-quiesce while jobs are in flight.
 *
 * Tests for:
 * 1. inFlightTaskIds helper: correctly computes the set of in-flight tasks
 *    from signals-out.ndjson vs signals-in.ndjson.
 * 2. TeamLifecycleManager.checkIdle (via time manipulation): idle-kill is
 *    suppressed when in-flight tasks exist; fires when all tasks are resolved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inFlightTaskIds } from '../../../src/teams/lifecycle.js';
import { TeamLifecycleManager } from '../../../src/teams/lifecycle.js';
import type { KrakenConfig } from '../../../src/config.js';
import type { TeamBridgeLike } from '../../../src/teams/lifecycle.js';

// ---------------------------------------------------------------------------
// inFlightTaskIds unit tests
// ---------------------------------------------------------------------------

describe('inFlightTaskIds', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lifecycle-quiesce-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty array when neither signals file exists', () => {
    expect(inFlightTaskIds(dir)).toEqual([]);
  });

  it('returns empty array when signals-out.ndjson is empty', () => {
    writeFileSync(join(dir, 'signals-out.ndjson'), '');
    expect(inFlightTaskIds(dir)).toEqual([]);
  });

  it('returns commissioned task when no signals-in.ndjson exists', () => {
    appendFileSync(
      join(dir, 'signals-out.ndjson'),
      JSON.stringify({
        type: 'commission_dev_team',
        taskId: 'task-1',
        role: 'builder',
        goal: 'build x',
      }) + '\n',
    );
    expect(inFlightTaskIds(dir)).toEqual(['task-1']);
  });

  it('removes task from in-flight when task_completed arrives', () => {
    appendFileSync(
      join(dir, 'signals-out.ndjson'),
      JSON.stringify({
        type: 'commission_dev_team',
        taskId: 'task-1',
        role: 'builder',
        goal: 'build x',
      }) + '\n',
    );
    appendFileSync(
      join(dir, 'signals-in.ndjson'),
      JSON.stringify({
        type: 'task_completed',
        taskId: 'task-1',
        result: 'ok',
      }) + '\n',
    );
    expect(inFlightTaskIds(dir)).toEqual([]);
  });

  it('removes task from in-flight when task_failed arrives', () => {
    appendFileSync(
      join(dir, 'signals-out.ndjson'),
      JSON.stringify({
        type: 'commission_dev_team',
        taskId: 'task-2',
        role: 'builder',
        goal: 'build y',
      }) + '\n',
    );
    appendFileSync(
      join(dir, 'signals-in.ndjson'),
      JSON.stringify({ type: 'task_failed', taskId: 'task-2', error: 'oops' }) +
        '\n',
    );
    expect(inFlightTaskIds(dir)).toEqual([]);
  });

  it('handles mixed completed and in-flight tasks', () => {
    appendFileSync(
      join(dir, 'signals-out.ndjson'),
      JSON.stringify({
        type: 'commission_dev_team',
        taskId: 'task-a',
        role: 'builder',
        goal: 'a',
      }) +
        '\n' +
        JSON.stringify({
          type: 'commission_dev_team',
          taskId: 'task-b',
          role: 'deployer',
          goal: 'b',
        }) +
        '\n' +
        JSON.stringify({
          type: 'commission_dev_team',
          taskId: 'task-c',
          role: 'builder',
          goal: 'c',
        }) +
        '\n',
    );
    appendFileSync(
      join(dir, 'signals-in.ndjson'),
      JSON.stringify({
        type: 'task_completed',
        taskId: 'task-a',
        result: 'ok',
      }) +
        '\n' +
        JSON.stringify({
          type: 'task_failed',
          taskId: 'task-c',
          error: 'died',
        }) +
        '\n',
    );
    // only task-b is still in flight
    expect(inFlightTaskIds(dir)).toEqual(['task-b']);
  });

  it('skips malformed JSON lines gracefully', () => {
    appendFileSync(
      join(dir, 'signals-out.ndjson'),
      'NOT_JSON\n' +
        JSON.stringify({
          type: 'commission_dev_team',
          taskId: 'task-x',
          role: 'builder',
          goal: 'x',
        }) +
        '\n',
    );
    appendFileSync(join(dir, 'signals-in.ndjson'), 'ALSO_NOT_JSON\n');
    expect(inFlightTaskIds(dir)).toEqual(['task-x']);
  });

  it('ignores non-commission signal types in signals-out', () => {
    appendFileSync(
      join(dir, 'signals-out.ndjson'),
      JSON.stringify({ type: 'terminate_dev_team', taskId: 'task-z' }) + '\n',
    );
    expect(inFlightTaskIds(dir)).toEqual([]);
  });

  it('ignores non-terminal signal types in signals-in', () => {
    appendFileSync(
      join(dir, 'signals-out.ndjson'),
      JSON.stringify({
        type: 'commission_dev_team',
        taskId: 'task-p',
        role: 'builder',
        goal: 'p',
      }) + '\n',
    );
    appendFileSync(
      join(dir, 'signals-in.ndjson'),
      JSON.stringify({
        type: 'progress_update',
        taskId: 'task-p',
        phase: 'scaffold',
        message: 'doing stuff',
      }) +
        '\n' +
        JSON.stringify({ type: 'task_started', taskId: 'task-p' }) +
        '\n',
    );
    // progress_update and task_started do NOT resolve the task
    expect(inFlightTaskIds(dir)).toEqual(['task-p']);
  });
});

// ---------------------------------------------------------------------------
// TeamLifecycleManager idle-kill suppression tests
// ---------------------------------------------------------------------------

describe('TeamLifecycleManager idle-kill suppression (Fix K)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lifecycle-mgr-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function makeConfig(teamsDir: string): KrakenConfig {
    return {
      teamsDir,
      gitState: {
        dir: join(teamsDir, 'git'),
        repoUrl: 'https://example.com',
        credentialsSecret: '',
        branch: 'main',
        syncIntervalMs: 0,
      },
      cluster: { name: 'test' },
      mcp: { url: 'http://localhost:9090' },
      llm: {
        defaultProvider: 'anthropic',
        defaultModel: 'claude-sonnet-4-6',
        allowedProviders: ['anthropic'],
        anthropicApiKey: undefined,
        openaiApiKey: undefined,
        geminiApiKey: undefined,
      },
      slack: {
        botToken: 'xoxb-test',
        signingSecret: 'sig',
        appToken: undefined,
        mode: 'http',
      },
      oidc: { issuerUrl: '', clientId: '', clientSecret: '', callbackUrl: '' },
      db: { path: ':memory:', secretsPath: ':memory:' },
      chroma: { baseUrl: '' },
      server: { port: 3000 },
      observability: { otlpEndpoint: undefined },
    } as unknown as KrakenConfig;
  }

  it('suppresses idle-kill when tasks are in flight', async () => {
    const teamsDir = join(dir, 'teams');
    const config = makeConfig(teamsDir);

    let stopCalled = false;
    const mockBridge: TeamBridgeLike = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockImplementation(() => {
        stopCalled = true;
        return Promise.resolve();
      }),
      isActive: vi.fn().mockReturnValue(true),
    };

    const db = {
      prepare: () => ({ run: () => {}, get: () => null, all: () => [] }),
    } as unknown as import('better-sqlite3').Database;
    const manager = new TeamLifecycleManager(config, db, {
      bridgeFactory: () => mockBridge,
    });

    await manager.spawnTeam('my-enclave', 'U1', 'token-123');

    // Write an in-flight commission to the team dir
    const teamDir = join(teamsDir, 'my-enclave');
    appendFileSync(
      join(teamDir, 'signals-out.ndjson'),
      JSON.stringify({
        type: 'commission_dev_team',
        taskId: 'task-inflight',
        role: 'builder',
        goal: 'deploy x',
      }) + '\n',
    );

    // Advance time past the 30-minute idle threshold
    vi.advanceTimersByTime(31 * 60 * 1000);

    // The team should still be active — idle-kill was suppressed
    expect(manager.isTeamActive('my-enclave')).toBe(true);
    expect(stopCalled).toBe(false);

    await manager.shutdownAll();
  });

  it('fires idle-kill when all tasks are resolved', async () => {
    const teamsDir = join(dir, 'teams2');
    const config = makeConfig(teamsDir);

    let stopCalled = false;
    const mockBridge: TeamBridgeLike = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockImplementation(() => {
        stopCalled = true;
        return Promise.resolve();
      }),
      isActive: vi.fn().mockReturnValue(true),
    };

    const db = {
      prepare: () => ({ run: () => {}, get: () => null, all: () => [] }),
    } as unknown as import('better-sqlite3').Database;
    const manager = new TeamLifecycleManager(config, db, {
      bridgeFactory: () => mockBridge,
    });

    await manager.spawnTeam('my-enclave', 'U1', 'token-456');

    const teamDir = join(teamsDir, 'my-enclave');
    // Write a commission that is already resolved by task_completed
    appendFileSync(
      join(teamDir, 'signals-out.ndjson'),
      JSON.stringify({
        type: 'commission_dev_team',
        taskId: 'task-done',
        role: 'builder',
        goal: 'build y',
      }) + '\n',
    );
    appendFileSync(
      join(teamDir, 'signals-in.ndjson'),
      JSON.stringify({
        type: 'task_completed',
        taskId: 'task-done',
        result: 'ok',
      }) + '\n',
    );

    // Advance time past the 30-minute idle threshold
    vi.advanceTimersByTime(31 * 60 * 1000);

    // The team should be gone — idle-kill fired because no in-flight tasks
    expect(manager.isTeamActive('my-enclave')).toBe(false);
    expect(stopCalled).toBe(true);
  });
});
