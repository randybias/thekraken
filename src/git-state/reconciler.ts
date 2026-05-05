/**
 * Pod-startup reconciler for the git-state deployments table.
 *
 * On startup, Kraken may have lost its SQLite state (PVC reset, pod
 * reschedule, etc.). This reconciler reads cluster annotations from every
 * known enclave via the MCP `wf_list` tool and reconstructs missing DB rows
 * so the manager can answer version-management questions without gaps.
 *
 * Key properties:
 *   - Idempotent: re-running produces no duplicate rows.
 *   - Non-destructive: existing rows with real summaries are never overwritten.
 *   - Non-fatal: errors per enclave are logged and skipped; startup continues.
 */

import type Database from 'better-sqlite3';
import {
  findByEnclaveTentacleSha,
  insertReconstructed,
} from './deployments-db.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'git-state-reconciler' });

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Minimal MCP reader interface consumed by the reconciler.
 *
 * In production this is implemented by a thin adapter over createMcpConnection.
 * In tests it is a simple mock.
 */
export interface McpReader {
  wfList: (enclave: string) => Promise<{
    workflows: Array<{
      name: string;
      enclave?: string;
      annotations?: Record<string, string>;
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

/**
 * Reconcile missing Kraken DB rows from cluster annotations.
 *
 * For each enclave in `enclaves`, calls `mcp.wfList(enclave)` and inspects
 * the `tentacular.io/git-sha` annotation on each returned workflow. If no DB
 * row exists for that (enclave, tentacle, sha) triple, a reconstructed row is
 * inserted.
 *
 * @param db       - Open Database instance (production or in-memory for tests).
 * @param mcp      - MCP reader (wraps wf_list tool).
 * @param enclaves - List of enclave names to reconcile.
 * @returns Counts of inserted and skipped workflows.
 */
export async function runReconciler(
  db: Database.Database,
  mcp: McpReader,
  enclaves: string[],
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  for (const enclave of enclaves) {
    let result: Awaited<ReturnType<McpReader['wfList']>>;
    try {
      result = await mcp.wfList(enclave);
    } catch (err) {
      log.warn({ err, enclave }, 'reconciler: wfList failed, skipping enclave');
      continue;
    }

    for (const wf of result.workflows) {
      const sha = wf.annotations?.['tentacular.io/git-sha'];
      const deployer = wf.annotations?.['tentacular.io/deployed-by'];

      if (!sha) {
        log.debug(
          { enclave, tentacle: wf.name },
          'reconciler: skipping (no git-sha annotation)',
        );
        continue;
      }

      const existing = findByEnclaveTentacleSha(db, enclave, wf.name, sha);
      if (existing) {
        skipped++;
        continue;
      }

      insertReconstructed(db, {
        enclave,
        tentacle: wf.name,
        gitSha: sha,
        deployedByEmail: deployer ?? 'unknown',
        deployedAt: wf.annotations?.['tentacular.io/deployed-at'],
      });
      inserted++;
      log.debug(
        { enclave, tentacle: wf.name, sha },
        'reconciler: inserted reconstructed row',
      );
    }
  }

  log.info({ inserted, skipped }, 'reconciler: complete');
  return { inserted, skipped };
}
