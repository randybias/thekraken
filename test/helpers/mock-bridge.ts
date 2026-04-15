/**
 * Mock TeamBridge factory for unit tests.
 *
 * Replaces the real pi-RPC subprocess with a simple recording stub so
 * tests can exercise TeamLifecycleManager without a pi binary or
 * network/IPC plumbing. The mock:
 *   - records start/stop calls
 *   - satisfies the TeamBridgeLike interface (start/stop/isActive)
 *   - stores the options it was constructed with so tests can assert
 *     the provider/model/env/appendSystemPrompt values
 */
import { vi } from 'vitest';
import type {
  TeamBridgeFactory,
  TeamBridgeLike,
} from '../../src/teams/lifecycle.js';
import type { TeamBridgeOptions } from '../../src/teams/bridge.js';

export interface MockBridge extends TeamBridgeLike {
  opts: TeamBridgeOptions;
  startMock: ReturnType<typeof vi.fn>;
  stopMock: ReturnType<typeof vi.fn>;
  /** Simulate an upstream pi process exit (invokes onExit). */
  fireExit(code: number | null): void;
}

export interface MockBridgeFactoryResult {
  factory: TeamBridgeFactory;
  bridges: MockBridge[];
}

export function createMockBridgeFactory(): MockBridgeFactoryResult {
  const bridges: MockBridge[] = [];
  const factory: TeamBridgeFactory = (opts: TeamBridgeOptions) => {
    let active = false;
    let exited = false;
    const startMock = vi.fn(async () => {
      active = true;
    });
    const stopMock = vi.fn(async () => {
      active = false;
    });
    const bridge: MockBridge = {
      opts,
      startMock,
      stopMock,
      start: startMock,
      stop: stopMock,
      isActive: () => active && !exited,
      fireExit: (code) => {
        exited = true;
        active = false;
        opts.onExit?.(code);
      },
    };
    bridges.push(bridge);
    return bridge;
  };
  return { factory, bridges };
}
