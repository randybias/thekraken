/**
 * SQLite deployments table operations for git-state deploy/rollback flows.
 *
 * The deployments table is a mirror of the git log for tentacle deploys.
 * Each row represents one deploy or rollback operation.
 *
 * Deploy types:
 *   - 'deploy': agent-initiated forward deploy
 *   - 'rollback': user-initiated rollback to a prior version
 *
 * Status values:
 *   - 'pending': deploy initiated, not yet confirmed by MCP
 *   - 'success': wf_apply returned OK
 *   - 'failed': wf_apply returned error or git ops failed
 */

import type Database from 'better-sqlite3';
import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'deployments-db' });

export interface DeploymentRow {
  id: number;
  enclave: string;
  tentacle: string;
  version: number;
  git_sha: string;
  git_tag: string;
  deploy_type: 'deploy' | 'rollback';
  summary: string;
  details: string | null;
  deployed_by_email: string;
  triggered_by_channel: string;
  triggered_by_ts: string;
  created_at: string;
  status: 'pending' | 'success' | 'failed';
  status_detail: string | null;
}

export interface InsertDeploymentParams {
  enclave: string;
  tentacle: string;
  version: number;
  gitSha: string;
  gitTag: string;
  deployType: 'deploy' | 'rollback';
  summary: string;
  details?: string;
  deployedByEmail: string;
  triggeredByChannel: string;
  triggeredByTs: string;
}

export class DeploymentDb {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a new deployment record with status 'pending'.
   * Returns the row ID.
   */
  insert(params: InsertDeploymentParams): number {
    const result = this.db
      .prepare(
        `INSERT INTO deployments
           (enclave, tentacle, version, git_sha, git_tag, deploy_type,
            summary, details, deployed_by_email,
            triggered_by_channel, triggered_by_ts, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        params.enclave,
        params.tentacle,
        params.version,
        params.gitSha,
        params.gitTag,
        params.deployType,
        params.summary,
        params.details ?? null,
        params.deployedByEmail,
        params.triggeredByChannel,
        params.triggeredByTs,
      );
    const id = result.lastInsertRowid as number;
    log.debug(
      { id, enclave: params.enclave, tentacle: params.tentacle },
      'deployment inserted',
    );
    return id;
  }

  /**
   * Update the status of a deployment record.
   */
  updateStatus(
    id: number,
    status: 'success' | 'failed',
    statusDetail?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE deployments SET status = ?, status_detail = ? WHERE id = ?`,
      )
      .run(status, statusDetail ?? null, id);
    log.debug({ id, status }, 'deployment status updated');
  }

  /**
   * Get the most recent successful deployment for a tentacle in an enclave.
   */
  getLatestSuccessful(
    enclave: string,
    tentacle: string,
  ): DeploymentRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM deployments
         WHERE enclave = ? AND tentacle = ? AND status = 'success'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(enclave, tentacle) as DeploymentRow | undefined;
  }

  /**
   * List recent deployments for an enclave (default: last 10).
   */
  listForEnclave(enclave: string, limit = 10): DeploymentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM deployments
         WHERE enclave = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(enclave, limit) as DeploymentRow[];
  }

  /**
   * Check if a git tag already exists in the deployments table.
   * Used to prevent duplicate deploys of the same tag.
   */
  tagExists(enclave: string, tentacle: string, gitTag: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM deployments
         WHERE enclave = ? AND tentacle = ? AND git_tag = ?
         LIMIT 1`,
      )
      .get(enclave, tentacle, gitTag);
    return row !== undefined;
  }
}
