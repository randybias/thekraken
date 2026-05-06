/**
 * Health endpoint for The Kraken.
 *
 * Provides /healthz for Kubernetes liveness and readiness probes.
 *
 * Status semantics:
 * - 'ok'       — DB live + refresh loop ran recently.
 * - 'degraded' — DB live but refresh loop has stalled (> 2× interval).
 *                HTTP 200 so K8s readiness keeps the pod in service.
 *                Operators see the degraded field in the response body.
 * - 'error'    — DB SELECT 1 failed.  HTTP 503 trips the probe.
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
import { getRefreshLoopStatus } from './auth/index.js';

// Stale threshold for the refresh loop. The loop fires every 5 min;
// if the last sweep was > 2x interval ago, surface degraded.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const REFRESH_STALE_THRESHOLD_MS = 2 * REFRESH_INTERVAL_MS;

export interface HealthRefreshLoop {
  lastSweepAt: number | null;
  ageMs: number | null;
  refreshed: number;
  failed: number;
  deleted: number;
}

/**
 * Health response returned by checkHealth and serialised to /healthz.
 *
 * - 'ok'       — all subsystems healthy.
 * - 'degraded' — DB is live but the token-refresh loop hasn't run in
 *                the expected window. HTTP 200 (not 503) so Kubernetes
 *                readiness keeps the pod in service — this is observability
 *                only, not a probe trip.
 * - 'error'    — DB is unhealthy. HTTP 503.
 *
 * refreshLoop is always present when a DB is wired (or even without a DB,
 * once the refresh loop has started).
 */
export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  refreshLoop?: HealthRefreshLoop;
}

/**
 * Run a lightweight health check against the SQLite database and the
 * token-refresh loop.
 *
 * A failing SELECT 1 means the DB file is corrupt, locked, or the
 * process's fd limit is hit — all conditions worth surfacing to the
 * Kubernetes readiness probe.
 *
 * The refresh loop is considered stale if it has never run, or if its
 * last sweep was more than 2× REFRESH_INTERVAL_MS (10 minutes) ago.
 * A stale loop surfaces as 'degraded' with HTTP 200 — the pod stays in
 * service but operators can see the issue in the response body.
 *
 * @param db - Open better-sqlite3 Database instance. If undefined, the
 *             DB check is skipped (used in tests that don't wire a DB).
 * @returns HealthResponse with 'ok', 'degraded', or 'error'.
 */
export function checkHealth(db?: Database.Database): HealthResponse {
  // DB liveness — error trumps everything.
  if (db) {
    try {
      db.prepare('SELECT 1').get();
    } catch {
      return { status: 'error' };
    }
  }

  // Refresh loop liveness — degraded if the loop hasn't run recently.
  const s = getRefreshLoopStatus();
  const ageMs = s.lastSweepAt === null ? null : Date.now() - s.lastSweepAt;
  const refreshLoopOk =
    s.lastSweepAt !== null &&
    (ageMs ?? Number.POSITIVE_INFINITY) <= REFRESH_STALE_THRESHOLD_MS;

  return {
    status: refreshLoopOk ? 'ok' : 'degraded',
    refreshLoop: {
      lastSweepAt: s.lastSweepAt,
      ageMs,
      refreshed: s.lastSweepRefreshed,
      failed: s.lastSweepFailed,
      deleted: s.lastSweepDeleted,
    },
  };
}

/**
 * Creates a standalone HTTP server that serves GET /healthz.
 *
 * Used when Slack Bolt is in Socket Mode (Bolt does not start its own HTTP
 * server in that mode). In HTTP mode, use makeHealthHandler on Bolt's receiver.
 *
 * HTTP status mapping:
 * - 'ok' or 'degraded' → 200 (pod stays in service)
 * - 'error'            → 503 (trips readiness probe)
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
      const statusCode = body.status === 'error' ? 503 : 200;
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
 * HTTP status mapping:
 * - 'ok' or 'degraded' → 200 (pod stays in service)
 * - 'error'            → 503 (trips readiness probe)
 *
 * @param db - Open SQLite database for liveness check. Optional.
 * @returns Express-compatible handler function.
 */
export function makeHealthHandler(
  db?: Database.Database,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    const body = checkHealth(db);
    const statusCode = body.status === 'error' ? 503 : 200;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}
