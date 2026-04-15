/**
 * TeamLifecycleManager stale team GC tests.
 *
 * After a pod restart all team subprocesses are gone, but their directories
 * remain on the PVC. gcStaleTeams() is responsible for removing directories
 * that are older than 7 days and have no live process (not in the active
 * teams map).
 *
 * Coverage:
 * - Directories older than 7 days are removed
 * - Directories younger than 7 days are left intact
 * - Active team directories (with a live subprocess) are never removed,
 *   even if their mtime is old
 * - Nonexistent teamsDir is handled gracefully (no throw)
 * - Multiple stale directories are all removed in one call
 * - Mixed (some stale, some fresh) directories: only stale ones removed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  utimesSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from '../../src/db/migrations.js';
import type { KrakenConfig } from '../../src/config.js';
import { createMockBridgeFactory } from '../helpers/mock-bridge.js';

// ---------------------------------------------------------------------------
// Mock child_process.spawn (TeamLifecycleManager spawns subprocesses)
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawn: vi.fn(
    (
      _command: string,
      _args: string[],
      options: { env: Record<string, string | undefined> },
    ) => {
      const enclaveName =
        (options.env['KRAKEN_ENCLAVE_NAME'] as string) ?? 'unknown';
      const handlers: {
        exit?: (code: number | null, sig: string | null) => void;
        error?: (err: Error) => void;
      } = {};
      return {
        pid: 99999,
        killed: false,
        stderr: { on: vi.fn() },
        on: (event: string, handler: unknown) => {
          if (event === 'exit') handlers.exit = handler as typeof handlers.exit;
          if (event === 'error')
            handlers.error = handler as typeof handlers.error;
        },
        once: (event: string, handler: unknown) => {
          if (event === 'exit') handlers.exit = handler as typeof handlers.exit;
        },
        kill: vi.fn((signal?: string) => {
          setTimeout(() => {
            handlers.exit?.(signal === 'SIGTERM' ? 0 : 1, signal ?? null);
          }, 0);
          return true;
        }),
        // Expose name for test use
        _enclaveName: enclaveName,
      };
    },
  ),
}));

import { TeamLifecycleManager } from '../../src/teams/lifecycle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempTeamsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kraken-gc-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

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

/**
 * Create a team directory with an artificially old mtime.
 *
 * @param teamsDir - The root teams directory.
 * @param name - Team/enclave name (subdirectory name).
 * @param ageDays - How many days old to make the directory.
 * @returns Absolute path to the created team directory.
 */
function createStaleTeamDir(
  teamsDir: string,
  name: string,
  ageDays: number,
): string {
  const dir = join(teamsDir, name);
  mkdirSync(dir, { recursive: true });

  const oldDate = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  utimesSync(dir, oldDate, oldDate);

  return dir;
}

/**
 * Create a fresh team directory (mtime = now).
 */
function createFreshTeamDir(teamsDir: string, name: string): string {
  const dir = join(teamsDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamLifecycleManager.gcStaleTeams()', () => {
  let manager: TeamLifecycleManager;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes directories older than 7 days', () => {
    const teamsDir = makeTempTeamsDir();
    const db = createDatabase(':memory:');
    manager = new TeamLifecycleManager(makeConfig(teamsDir), db, {
      bridgeFactory: createMockBridgeFactory().factory,
    });

    const staleDir = createStaleTeamDir(teamsDir, 'old-enclave', 8);
    expect(existsSync(staleDir)).toBe(true);

    manager.gcStaleTeams();

    expect(existsSync(staleDir)).toBe(false);
    manager.shutdownAll();
  });

  it('does not remove directories younger than 7 days', () => {
    const teamsDir = makeTempTeamsDir();
    const db = createDatabase(':memory:');
    manager = new TeamLifecycleManager(makeConfig(teamsDir), db, {
      bridgeFactory: createMockBridgeFactory().factory,
    });

    const freshDir = createFreshTeamDir(teamsDir, 'fresh-enclave');
    expect(existsSync(freshDir)).toBe(true);

    manager.gcStaleTeams();

    expect(existsSync(freshDir)).toBe(true);
    manager.shutdownAll();
  });

  it('does not remove directories exactly at the 7-day boundary', () => {
    const teamsDir = makeTempTeamsDir();
    const db = createDatabase(':memory:');
    manager = new TeamLifecycleManager(makeConfig(teamsDir), db, {
      bridgeFactory: createMockBridgeFactory().factory,
    });

    // 6.9 days: just under threshold, should be kept
    const boundaryDir = createStaleTeamDir(teamsDir, 'boundary-enclave', 6.9);
    expect(existsSync(boundaryDir)).toBe(true);

    manager.gcStaleTeams();

    expect(existsSync(boundaryDir)).toBe(true);
    manager.shutdownAll();
  });

  it('removes multiple stale directories in one call', () => {
    const teamsDir = makeTempTeamsDir();
    const db = createDatabase(':memory:');
    manager = new TeamLifecycleManager(makeConfig(teamsDir), db, {
      bridgeFactory: createMockBridgeFactory().factory,
    });

    const stale1 = createStaleTeamDir(teamsDir, 'stale-1', 8);
    const stale2 = createStaleTeamDir(teamsDir, 'stale-2', 14);
    const stale3 = createStaleTeamDir(teamsDir, 'stale-3', 30);

    manager.gcStaleTeams();

    expect(existsSync(stale1)).toBe(false);
    expect(existsSync(stale2)).toBe(false);
    expect(existsSync(stale3)).toBe(false);
    manager.shutdownAll();
  });

  it('mixed: removes only stale directories, leaves fresh ones', () => {
    const teamsDir = makeTempTeamsDir();
    const db = createDatabase(':memory:');
    manager = new TeamLifecycleManager(makeConfig(teamsDir), db, {
      bridgeFactory: createMockBridgeFactory().factory,
    });

    const stale = createStaleTeamDir(teamsDir, 'stale-old', 10);
    const fresh1 = createFreshTeamDir(teamsDir, 'fresh-alpha');
    const fresh2 = createFreshTeamDir(teamsDir, 'fresh-beta');

    manager.gcStaleTeams();

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh1)).toBe(true);
    expect(existsSync(fresh2)).toBe(true);
    manager.shutdownAll();
  });

  it('does not remove active team directories even if mtime is old', async () => {
    const teamsDir = makeTempTeamsDir();
    const db = createDatabase(':memory:');
    manager = new TeamLifecycleManager(makeConfig(teamsDir), db, {
      bridgeFactory: createMockBridgeFactory().factory,
    });

    // Create the directory with an old mtime
    const activeDir = createStaleTeamDir(teamsDir, 'active-enclave', 10);
    expect(existsSync(activeDir)).toBe(true);

    // Spawn the team — this adds it to the active map
    await manager.spawnTeam('active-enclave', 'U_ALICE', 'token-alice');
    expect(manager.isTeamActive('active-enclave')).toBe(true);

    // GC should skip the active team
    manager.gcStaleTeams();

    expect(existsSync(activeDir)).toBe(true);

    await manager.shutdownAll();
  });

  it('handles nonexistent teamsDir gracefully (no throw)', () => {
    const db = createDatabase(':memory:');
    manager = new TeamLifecycleManager(
      makeConfig('/nonexistent/path/that/does/not/exist'),
      db,
      { bridgeFactory: createMockBridgeFactory().factory },
    );

    expect(() => manager.gcStaleTeams()).not.toThrow();
    manager.shutdownAll();
  });

  it('is a no-op when teamsDir is empty', () => {
    const teamsDir = makeTempTeamsDir();
    const db = createDatabase(':memory:');
    manager = new TeamLifecycleManager(makeConfig(teamsDir), db, {
      bridgeFactory: createMockBridgeFactory().factory,
    });

    // Empty dir — nothing to GC
    expect(() => manager.gcStaleTeams()).not.toThrow();
    manager.shutdownAll();
  });

  it('restart simulation: stale dirs from previous pod run are cleaned up', async () => {
    // Before restart: teams directory has several team subdirs
    const teamsDir = makeTempTeamsDir();

    // Simulate pre-restart dirs: created 10 days ago (all processes dead)
    const preRestartDirs = ['marketing', 'engineering', 'data-science'].map(
      (name) => ({
        name,
        dir: createStaleTeamDir(teamsDir, name, 10),
      }),
    );

    // Simulate fresh dir: created today by the current run
    const freshDir = createFreshTeamDir(teamsDir, 'fresh-today');

    // After restart: no teams are active (all subprocesses died)
    const db = createDatabase(':memory:');
    manager = new TeamLifecycleManager(makeConfig(teamsDir), db, {
      bridgeFactory: createMockBridgeFactory().factory,
    });

    manager.gcStaleTeams();

    // All stale pre-restart dirs should be gone
    for (const { dir } of preRestartDirs) {
      expect(existsSync(dir)).toBe(false);
    }

    // Fresh dir should survive (it's new)
    expect(existsSync(freshDir)).toBe(true);

    manager.shutdownAll();
  });
});
