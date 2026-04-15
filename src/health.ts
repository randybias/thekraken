/**
 * Health endpoint for The Kraken.
 *
 * Provides /healthz for Kubernetes liveness and readiness probes.
 *
 * Composition strategy:
 * - In socket mode: call createHealthServer(port, db) — Bolt doesn't start its own
 *   HTTP server in socket mode.
 * - In http mode: register makeHealthHandler(db) on Bolt's ExpressReceiver.
 */
import {
  createServer,
  IncomingMessage,
  ServerResponse,
  Server,
} from 'node:http';
import type Database from 'better-sqlite3';

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
}

/**
 * Run a lightweight health check against the SQLite database.
 *
 * A failing SELECT 1 means the DB file is corrupt, locked, or the
 * process's fd limit is hit — all conditions worth surfacing to the
 * Kubernetes readiness probe.
 *
 * @param db - Open better-sqlite3 Database instance. If undefined, the
 *             check is skipped and 'ok' is returned (used in tests that
 *             don't wire a DB).
 * @returns HealthResponse with 'ok' or 'error'.
 */
export function checkHealth(db?: Database.Database): HealthResponse {
  if (!db) return { status: 'ok' };
  try {
    db.prepare('SELECT 1').get();
    return { status: 'ok' };
  } catch {
    return { status: 'error' };
  }
}

/**
 * Creates a standalone HTTP server that serves GET /healthz.
 *
 * Used when Slack Bolt is in Socket Mode (Bolt does not start its own HTTP
 * server in that mode). In HTTP mode, use makeHealthHandler on Bolt's receiver.
 *
 * @param port - Port to listen on.
 * @param db - Open SQLite database for liveness check. Optional.
 * @returns The HTTP Server instance (call server.close() for test teardown).
 */
export function createHealthServer(
  port: number,
  db?: Database.Database,
): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const body = checkHealth(db);
      const statusCode = body.status === 'ok' ? 200 : 503;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
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
 * Register via: receiver.router.get('/healthz', makeHealthHandler(db))
 *
 * @param db - Open SQLite database for liveness check. Optional.
 * @returns Express-compatible handler function.
 */
export function makeHealthHandler(
  db?: Database.Database,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    const body = checkHealth(db);
    const statusCode = body.status === 'ok' ? 200 : 503;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

/**
 * Legacy healthHandler for backwards compatibility.
 * Use makeHealthHandler(db) instead when a DB instance is available.
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
