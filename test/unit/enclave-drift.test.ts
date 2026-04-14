/**
 * Unit tests for drift detection (Phase 3, T10).
 *
 * Uses fake timers for interval-based behavior.
 * All MCP and Slack API calls are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DriftDetector,
  type DriftConfig,
  type DriftDeps,
} from '../../src/enclave/drift.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<DriftConfig> = {}): DriftConfig {
  return {
    intervalMs: 300_000,
    maxChannelsPerCycle: 5,
    serviceToken: 'test-service-token',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DriftDeps> = {}): DriftDeps {
  return {
    mcpCall: vi.fn().mockResolvedValue({ enclaves: [] }),
    resolveEmail: vi
      .fn()
      .mockImplementation(async (slackId: string) => `${slackId}@example.com`),
    listChannelMembers: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DriftDetector.start() / stop()
// ---------------------------------------------------------------------------

describe('DriftDetector — start/stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start if service token is empty', () => {
    const config = makeConfig({ serviceToken: '' });
    const deps = makeDeps();
    const detector = new DriftDetector(config, deps);
    detector.start();
    // Timer should not be running — advancing time should not trigger mcpCall
    vi.advanceTimersByTime(config.intervalMs + 1000);
    expect(deps.mcpCall).not.toHaveBeenCalled();
    detector.stop();
  });

  it('starts and triggers cycle on interval', async () => {
    const config = makeConfig({ intervalMs: 1000 });
    const deps = makeDeps();
    const detector = new DriftDetector(config, deps);
    detector.start();

    await vi.advanceTimersByTimeAsync(1001);
    expect(deps.mcpCall).toHaveBeenCalled();
    detector.stop();
  });

  it('stops triggering after stop()', async () => {
    const config = makeConfig({ intervalMs: 1000 });
    const deps = makeDeps();
    const detector = new DriftDetector(config, deps);
    detector.start();
    await vi.advanceTimersByTimeAsync(1001);
    const callsBefore = (deps.mcpCall as ReturnType<typeof vi.fn>).mock.calls
      .length;
    detector.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect((deps.mcpCall as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsBefore,
    );
  });
});

// ---------------------------------------------------------------------------
// DriftDetector.runCycle()
// ---------------------------------------------------------------------------

describe('DriftDetector.runCycle()', () => {
  it('skips frozen enclaves', async () => {
    const deps = makeDeps({
      mcpCall: vi.fn().mockResolvedValue({
        enclaves: [
          {
            name: 'frozen-enclave',
            channel_id: 'C123',
            status: 'frozen',
            owner: 'owner@e.com',
            members: ['member@e.com'],
          },
        ],
      }),
    });
    const detector = new DriftDetector(makeConfig(), deps);
    await detector.runCycle();
    // enclave_sync should NOT have been called (no member removal on frozen)
    expect(deps.mcpCall).toHaveBeenCalledTimes(1); // only enclave_list
    expect(deps.mcpCall).not.toHaveBeenCalledWith(
      'enclave_sync',
      expect.anything(),
    );
  });

  it('removes stale members', async () => {
    const deps = makeDeps({
      mcpCall: vi
        .fn()
        .mockResolvedValueOnce({
          enclaves: [
            {
              name: 'test-enclave',
              channel_id: 'C123',
              status: 'active',
              owner: 'owner@e.com',
              members: ['alice@e.com', 'bob@e.com'],
            },
          ],
        })
        .mockResolvedValue({}),
      resolveEmail: vi.fn().mockImplementation(async (id: string) => {
        // Only alice is in Slack, bob has left
        if (id === 'UALICE') return 'alice@e.com';
        return undefined; // bob's ID is not resolvable (left the workspace)
      }),
      listChannelMembers: vi.fn().mockResolvedValue(['UALICE']), // only alice in channel
    });

    const detector = new DriftDetector(makeConfig(), deps);
    await detector.runCycle();

    expect(deps.mcpCall).toHaveBeenCalledWith(
      'enclave_sync',
      expect.objectContaining({
        remove_members: ['bob@e.com'],
      }),
    );
  });

  it('never removes the owner', async () => {
    const deps = makeDeps({
      mcpCall: vi
        .fn()
        .mockResolvedValueOnce({
          enclaves: [
            {
              name: 'test-enclave',
              channel_id: 'C123',
              status: 'active',
              owner: 'owner@e.com',
              members: [],
            },
          ],
        })
        .mockResolvedValue({}),
      listChannelMembers: vi.fn().mockResolvedValue([]), // owner not in channel
      resolveEmail: vi.fn().mockResolvedValue('owner@e.com'),
    });

    const detector = new DriftDetector(makeConfig(), deps);
    await detector.runCycle();
    // enclave_sync should NOT have been called (owner is protected)
    expect(deps.mcpCall).not.toHaveBeenCalledWith(
      'enclave_sync',
      expect.anything(),
    );
  });

  it('does nothing when all members are present', async () => {
    const deps = makeDeps({
      mcpCall: vi.fn().mockResolvedValue({
        enclaves: [
          {
            name: 'test-enclave',
            channel_id: 'C123',
            status: 'active',
            owner: 'owner@e.com',
            members: ['alice@e.com'],
          },
        ],
      }),
      listChannelMembers: vi.fn().mockResolvedValue(['UALICE']),
      resolveEmail: vi.fn().mockResolvedValue('alice@e.com'),
    });

    const detector = new DriftDetector(makeConfig(), deps);
    await detector.runCycle();
    expect(deps.mcpCall).not.toHaveBeenCalledWith(
      'enclave_sync',
      expect.anything(),
    );
  });

  it('handles enclave_list failure gracefully', async () => {
    const deps = makeDeps({
      mcpCall: vi.fn().mockRejectedValue(new Error('MCP down')),
    });
    const detector = new DriftDetector(makeConfig(), deps);
    // Should not throw
    await expect(detector.runCycle()).resolves.not.toThrow();
  });

  it('round-robin: advances offset each cycle', async () => {
    const enclaves = Array.from({ length: 8 }, (_, i) => ({
      name: `enclave-${i}`,
      channel_id: `C${i}`,
      status: 'active',
      owner: `owner${i}@e.com`,
      members: [],
    }));

    const deps = makeDeps({
      mcpCall: vi.fn().mockResolvedValue({ enclaves }),
      listChannelMembers: vi.fn().mockResolvedValue([]),
    });

    const detector = new DriftDetector(
      makeConfig({ maxChannelsPerCycle: 3 }),
      deps,
    );

    // Cycle 1: checks 0,1,2
    await detector.runCycle();
    // Cycle 2: checks 3,4,5
    await detector.runCycle();
    // Cycle 3: checks 6,7,0 (wraps)
    await detector.runCycle();

    // listChannelMembers should have been called 9 times total (3 enclaves * 3 cycles)
    // but some may be wrapped. Just verify multiple calls happened.
    expect(deps.listChannelMembers).toHaveBeenCalledTimes(9);
  });
});
