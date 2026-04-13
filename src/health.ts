/**
 * Health endpoint for The Kraken v2.
 *
 * Provides /healthz for Kubernetes liveness and readiness probes.
 *
 * Composition strategy:
 * - In socket mode: call createHealthServer(port) — Bolt doesn't start its own
 *   HTTP server in socket mode.
 * - In http mode: register healthHandler on Bolt's ExpressReceiver (Phase 1).
 *
 * For Phase 0, only createHealthServer is tested.
 */
import {
  createServer,
  IncomingMessage,
  ServerResponse,
  Server,
} from 'node:http';

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
}

/**
 * Creates a standalone HTTP server that serves GET /healthz.
 *
 * Used when Slack Bolt is in Socket Mode (Bolt does not start its own HTTP
 * server in that mode). In HTTP mode, use healthHandler on Bolt's receiver.
 *
 * @param port - Port to listen on.
 * @returns The HTTP Server instance (call server.close() for test teardown).
 */
export function createHealthServer(port: number): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const body: HealthResponse = { status: 'ok' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port);
  return server;
}

/**
 * Express-compatible request handler for mounting on Bolt's HTTP receiver.
 *
 * Used in HTTP mode where Bolt owns the HTTP server on port 3000.
 * Register via: receiver.router.get('/healthz', healthHandler)
 *
 * @param _req - Incoming request (unused).
 * @param res - Server response.
 */
export function healthHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const body: HealthResponse = { status: 'ok' };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
