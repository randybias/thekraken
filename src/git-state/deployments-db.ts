/**
 * SQLite operations for the deployments table.
 *
 * All functions accept a better-sqlite3 Database instance so they can be
 * used with the application database or an in-memory database in tests.
 * No connection management here — callers obtain the DB via initDatabase().
 */

import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeploymentRecord {
  id: number;
  enclave: string;
  tentacle: string;
  version: number;
  git_sha: string;
  git_tag: string;
  deploy_type: string;
  summary: string;
  details: string | null;
  deployed_by_email: string;
  triggered_by_channel: string;
  triggered_by_ts: string;
  created_at: string;
  status: string;
  status_detail: string | null;
}

export interface RecordDeploymentParams {
  enclave: string;
  tentacle: string;
  version: number;
  git_sha: string;
  git_tag: string;
  deploy_type: string;
  summary: string;
  details?: string;
  deployed_by_email: string;
  triggered_by_channel: string;
  triggered_by_ts: string;
  /** Initial status. Defaults to 'pending'. */
  status?: string;
  status_detail?: string;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

/**
 * Record a new deployment in the deployments table.
 *
 * @param db - Open Database instance.
 * @param params - Deployment parameters.
 * @returns The auto-incremented row ID of the new deployment.
 */
export function recordDeployment(
  db: Database.Database,
  params: RecordDeploymentParams,
): number {
  const stmt = db.prepare(`
    INSERT INTO deployments (
      enclave, tentacle, version, git_sha, git_tag, deploy_type,
      summary, details, deployed_by_email, triggered_by_channel,
      triggered_by_ts, status, status_detail
    ) VALUES (
      @enclave, @tentacle, @version, @git_sha, @git_tag, @deploy_type,
      @summary, @details, @deployed_by_email, @triggered_by_channel,
      @triggered_by_ts, @status, @status_detail
    )
  `);

  const result = stmt.run({
    ...params,
    details: params.details ?? null,
    status: params.status ?? 'pending',
    status_detail: params.status_detail ?? null,
  });

  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Retrieve deployment history for a specific enclave+tentacle pair,
 * ordered from newest to oldest.
 *
 * @param db - Open Database instance.
 * @param enclave - Enclave name.
 * @param tentacle - Tentacle name.
 * @param limit - Maximum number of records to return (default 20).
 * @returns Array of DeploymentRecord, newest first.
 */
export function getDeploymentHistory(
  db: Database.Database,
  enclave: string,
  tentacle: string,
  limit = 20,
): DeploymentRecord[] {
  return db
    .prepare(
      `
      SELECT * FROM deployments
      WHERE enclave = ? AND tentacle = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
      `,
    )
    .all(enclave, tentacle, limit) as DeploymentRecord[];
}

/**
 * Retrieve the most recent deployment for a specific enclave+tentacle pair.
 *
 * @param db - Open Database instance.
 * @param enclave - Enclave name.
 * @param tentacle - Tentacle name.
 * @returns The most recent DeploymentRecord, or null if none exists.
 */
export function getLatestDeployment(
  db: Database.Database,
  enclave: string,
  tentacle: string,
): DeploymentRecord | null {
  const row = db
    .prepare(
      `
      SELECT * FROM deployments
      WHERE enclave = ? AND tentacle = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      `,
    )
    .get(enclave, tentacle) as DeploymentRecord | undefined;

  return row ?? null;
}

/**
 * Update the status of a deployment by ID.
 *
 * @param db - Open Database instance.
 * @param id - Deployment row ID.
 * @param status - New status value (e.g. 'success', 'failed').
 * @param status_detail - Optional detail message.
 */
export function updateDeploymentStatus(
  db: Database.Database,
  id: number,
  status: string,
  status_detail?: string,
): void {
  db.prepare(
    `
    UPDATE deployments
    SET status = ?, status_detail = ?
    WHERE id = ?
    `,
  ).run(status, status_detail ?? null, id);
}
