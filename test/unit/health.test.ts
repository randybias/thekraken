import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { Server } from 'node:http';

// ---------------------------------------------------------------------------
// Mock auth/index.js so getRefreshLoopStatus is controllable per-test.
// vi.hoisted ensures the mock fn is available when the vi.mock factory runs.
// ---------------------------------------------------------------------------

const { mockGetRefreshLoopStatus } = vi.hoisted(() => ({
  mockGetRefreshLoopStatus: vi.fn(),
}));

vi.mock('../../src/auth/index.js', () => ({
  getRefreshLoopStatus: mockGetRefreshLoopStatus,
}));

// Import health module AFTER the mock is registered so it picks up the stub.
import { createHealthServer, checkHealth } from '../../src/health.js';

let server: Server;

// Default before each: loop ran recently (healthy) so original HTTP tests pass.
beforeEach(() => {
  mockGetRefreshLoopStatus.mockReturnValue({
    lastSweepAt: Date.now() - 30_000, // 30 s ago — well within the 10 min threshold
    lastSweepRefreshed: 0,
    lastSweepFailed: 0,
    lastSweepDeleted: 0,
  });
});

afterEach(() => {
  if (server) {
    server.close();
  }
  vi.clearAllMocks();
});

describe('createHealthServer', () => {
  it('returns 200 with {"status":"ok"} on GET /healthz', async () => {
    server = createHealthServer(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));

    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('unexpected server address');
    }
    const port = addr.port;

    const res = await fetch(`http://localhost:${port}/healthz`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');

    const contentType = res.headers.get('content-type');
    expect(contentType).toBe('application/json');
  });

  it('returns 404 for unknown paths', async () => {
    server = createHealthServer(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));

    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('unexpected server address');
    }
    const port = addr.port;

    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);
  });
});

describe('checkHealth — refresh loop liveness (rc.11)', () => {
  it('returns degraded when the refresh loop has never run', () => {
    mockGetRefreshLoopStatus.mockReturnValue({
      lastSweepAt: null,
      lastSweepRefreshed: 0,
      lastSweepFailed: 0,
      lastSweepDeleted: 0,
    });
    const r = checkHealth();
    expect(r.status).toBe('degraded');
    expect(r.refreshLoop?.lastSweepAt).toBeNull();
  });

  it('returns degraded when the last sweep is older than 2x interval', () => {
    const elevenMinAgo = Date.now() - 11 * 60 * 1000;
    mockGetRefreshLoopStatus.mockReturnValue({
      lastSweepAt: elevenMinAgo,
      lastSweepRefreshed: 0,
      lastSweepFailed: 0,
      lastSweepDeleted: 0,
    });
    expect(checkHealth().status).toBe('degraded');
  });

  it('returns ok when the last sweep is recent', () => {
    mockGetRefreshLoopStatus.mockReturnValue({
      lastSweepAt: Date.now() - 30_000,
      lastSweepRefreshed: 0,
      lastSweepFailed: 0,
      lastSweepDeleted: 0,
    });
    expect(checkHealth().status).toBe('ok');
  });

  it('exposes refresh-loop counts in the response body', () => {
    mockGetRefreshLoopStatus.mockReturnValue({
      lastSweepAt: Date.now() - 60_000,
      lastSweepRefreshed: 3,
      lastSweepFailed: 1,
      lastSweepDeleted: 2,
    });
    const r = checkHealth();
    expect(r.refreshLoop?.refreshed).toBe(3);
    expect(r.refreshLoop?.failed).toBe(1);
    expect(r.refreshLoop?.deleted).toBe(2);
  });

  it('degraded status returns HTTP 200 (not 503)', async () => {
    mockGetRefreshLoopStatus.mockReturnValue({
      lastSweepAt: null,
      lastSweepRefreshed: 0,
      lastSweepFailed: 0,
      lastSweepDeleted: 0,
    });

    server = createHealthServer(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));

    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('unexpected server address');
    }
    const port = addr.port;

    const res = await fetch(`http://localhost:${port}/healthz`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('degraded');
  });
});
