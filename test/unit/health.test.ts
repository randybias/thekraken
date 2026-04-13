import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { createHealthServer } from '../../src/health.js';

let server: Server;

afterEach(() => {
  if (server) {
    server.close();
  }
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
    expect(body).toEqual({ status: 'ok' });

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
