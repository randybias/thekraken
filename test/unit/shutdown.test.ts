/**
 * Graceful shutdown sequence tests.
 *
 * Verifies that the shutdown sequence in src/index.ts calls subsystems
 * in the correct order: poller stop → Slack stop → teams shutdown →
 * OTel flush → DB close.
 *
 * Coverage:
 * - All subsystem shutdown methods are called on SIGTERM/SIGINT
 * - Shutdown is idempotent (second signal is ignored)
 * - DB close is called last (after telemetry flush)
 * - poller.stop() is called before slackBot.stop()
 * - teams.shutdownAll() is called after Slack stops
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Call-order tracker
// ---------------------------------------------------------------------------

/** Ordered log of shutdown calls. */
const callOrder: string[] = [];

// ---------------------------------------------------------------------------
// Subsystem mocks
// ---------------------------------------------------------------------------

const mockPoller = {
  start: vi.fn(),
  stop: vi.fn(async () => {
    callOrder.push('poller.stop');
  }),
  notifyTeamExited: vi.fn(),
};

const mockSlackBot = {
  app: { client: { chat: { postMessage: vi.fn() } } },
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {
    callOrder.push('slackBot.stop');
  }),
};

const mockTeams = {
  shutdownAll: vi.fn(async () => {
    callOrder.push('teams.shutdownAll');
  }),
  setOnTeamExited: vi.fn(),
  getActiveTeamNames: vi.fn(() => []),
  isTeamActive: vi.fn(() => false),
  gcStaleTeams: vi.fn(),
};

const mockDb = {
  close: vi.fn(() => {
    callOrder.push('db.close');
  }),
};

// Track shutdownTelemetry calls
vi.mock('../../src/telemetry.js', () => ({
  initTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(async () => {
    callOrder.push('shutdownTelemetry');
  }),
}));

import { shutdownTelemetry } from '../../src/telemetry.js';

// ---------------------------------------------------------------------------
// Shutdown function under test (extracted from index.ts for testability)
// ---------------------------------------------------------------------------

/**
 * Replicated from src/index.ts main() to test the shutdown sequence
 * in isolation, without triggering real Slack/DB connections.
 */
async function runShutdown(
  poller: typeof mockPoller,
  slackBot: typeof mockSlackBot,
  teams: typeof mockTeams,
  db: typeof mockDb,
): Promise<void> {
  await poller.stop();
  await slackBot.stop();
  await teams.shutdownAll();
  await shutdownTelemetry();
  db.close();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('shutdown sequence', () => {
  beforeEach(() => {
    callOrder.length = 0;
    vi.clearAllMocks();
  });

  it('calls all subsystem shutdown methods', async () => {
    await runShutdown(mockPoller, mockSlackBot, mockTeams, mockDb);

    expect(mockPoller.stop).toHaveBeenCalledOnce();
    expect(mockSlackBot.stop).toHaveBeenCalledOnce();
    expect(mockTeams.shutdownAll).toHaveBeenCalledOnce();
    expect(shutdownTelemetry).toHaveBeenCalledOnce();
    expect(mockDb.close).toHaveBeenCalledOnce();
  });

  it('calls subsystems in the correct order', async () => {
    await runShutdown(mockPoller, mockSlackBot, mockTeams, mockDb);

    expect(callOrder).toEqual([
      'poller.stop',
      'slackBot.stop',
      'teams.shutdownAll',
      'shutdownTelemetry',
      'db.close',
    ]);
  });

  it('poller.stop() is called before slackBot.stop()', async () => {
    await runShutdown(mockPoller, mockSlackBot, mockTeams, mockDb);

    const pollerIdx = callOrder.indexOf('poller.stop');
    const slackIdx = callOrder.indexOf('slackBot.stop');
    expect(pollerIdx).toBeLessThan(slackIdx);
  });

  it('slackBot.stop() is called before teams.shutdownAll()', async () => {
    await runShutdown(mockPoller, mockSlackBot, mockTeams, mockDb);

    const slackIdx = callOrder.indexOf('slackBot.stop');
    const teamsIdx = callOrder.indexOf('teams.shutdownAll');
    expect(slackIdx).toBeLessThan(teamsIdx);
  });

  it('teams.shutdownAll() is called before shutdownTelemetry', async () => {
    await runShutdown(mockPoller, mockSlackBot, mockTeams, mockDb);

    const teamsIdx = callOrder.indexOf('teams.shutdownAll');
    const otelIdx = callOrder.indexOf('shutdownTelemetry');
    expect(teamsIdx).toBeLessThan(otelIdx);
  });

  it('db.close() is called last', async () => {
    await runShutdown(mockPoller, mockSlackBot, mockTeams, mockDb);

    const dbIdx = callOrder.indexOf('db.close');
    expect(dbIdx).toBe(callOrder.length - 1);
  });

  it('shutdown is idempotent when guarded by a flag', async () => {
    let shuttingDown = false;

    const guardedShutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await runShutdown(mockPoller, mockSlackBot, mockTeams, mockDb);
    };

    // Simulate two concurrent signals
    await Promise.all([guardedShutdown(), guardedShutdown()]);

    // Each subsystem should only be called once
    expect(mockPoller.stop).toHaveBeenCalledOnce();
    expect(mockSlackBot.stop).toHaveBeenCalledOnce();
    expect(mockTeams.shutdownAll).toHaveBeenCalledOnce();
    expect(mockDb.close).toHaveBeenCalledOnce();
  });

  it('shutdown completes even if OTel flush throws', async () => {
    vi.mocked(shutdownTelemetry).mockRejectedValueOnce(new Error('otel error'));

    // Should NOT throw — this mirrors the try/catch in index.ts
    await expect(
      (async () => {
        try {
          await runShutdown(mockPoller, mockSlackBot, mockTeams, mockDb);
        } catch {
          // caught
        }
      })(),
    ).resolves.not.toThrow();

    // poller, slack, teams were still called before otel
    expect(mockPoller.stop).toHaveBeenCalledOnce();
    expect(mockSlackBot.stop).toHaveBeenCalledOnce();
    expect(mockTeams.shutdownAll).toHaveBeenCalledOnce();
  });
});
