/**
 * Rollback flow: checkout prior version, commit as new monotonic version, deploy.
 *
 * Flow:
 *   1. Verify target git tag exists
 *   2. git checkout <tag> -- <tentacle dir> (restore source to tagged state)
 *   3. git add <tentacle dir>
 *   4. git commit with rollback message (pre-commit hook bumps to next version)
 *   5. Read new version from workflow.yaml
 *   6. git tag v{new_version} (monotonically higher than all prior tags)
 *   7. git push + git push --tags
 *   8. Call MCP wf_apply with new version + git_sha
 *   9. Record rollback in SQLite deployments table
 *
 * The rollback creates a NEW commit with a NEW higher version number.
 * This preserves monotonic version ordering and avoids git history rewriting.
 */

import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createChildLogger } from '../logger.js';
import { DeploymentDb } from './deployments-db.js';
import {
  readVersionFromWorkflow,
  type GitOps,
  type McpCallFn,
  type WfApplyResult,
  realGitOps,
} from './deploy.js';

const log = createChildLogger({ module: 'rollback' });

// ---------------------------------------------------------------------------
// Rollback params and result
// ---------------------------------------------------------------------------

export interface RollbackParams {
  enclave: string;
  tentacle: string;
  /** The git tag to roll back to (e.g. "my-tentacle-v3"). */
  targetTag: string;
  /** Absolute path to the git-state repo root. */
  gitDir: string;
  /** Path to the tentacle directory relative to gitDir. */
  tentacleRelPath: string;
  /** User requesting rollback (for audit). */
  requestedByEmail: string;
  /** Slack channel ID that triggered the rollback. */
  triggeredByChannel: string;
  /** Slack message ts that triggered the rollback. */
  triggeredByTs: string;
  /** User OIDC token for MCP calls. */
  userToken: string;
}

export interface RollbackResult {
  ok: boolean;
  message: string;
  newVersion?: number;
  newTag?: string;
  gitSha?: string;
}

// ---------------------------------------------------------------------------
// rollback()
// ---------------------------------------------------------------------------

/**
 * Execute the rollback flow for a tentacle.
 *
 * Dependencies are injected for testability:
 *   - db: SQLite database (deployments table)
 *   - mcpCall: function to invoke MCP tools with user token
 *   - git: git operations (default: realGitOps, override in tests)
 */
export async function rollback(
  params: RollbackParams,
  db: Database.Database,
  mcpCall: McpCallFn,
  git: GitOps = realGitOps,
): Promise<RollbackResult> {
  const {
    enclave,
    tentacle,
    targetTag,
    gitDir,
    tentacleRelPath,
    requestedByEmail,
    triggeredByChannel,
    triggeredByTs,
    userToken,
  } = params;

  const deployDb = new DeploymentDb(db);
  let deployId: number | undefined;

  try {
    // Step 1: Verify the target tag exists
    let tagSha: string;
    try {
      tagSha = git.exec(`rev-list -n 1 ${targetTag}`, gitDir);
    } catch {
      return {
        ok: false,
        message: `Rollback target tag "${targetTag}" does not exist in the repository.`,
      };
    }

    if (!tagSha) {
      return {
        ok: false,
        message: `Rollback target tag "${targetTag}" does not exist in the repository.`,
      };
    }

    log.info({ enclave, tentacle, targetTag, tagSha }, 'rollback tag verified');

    // Step 2: git checkout <tag> -- <tentacle dir>
    git.exec(`checkout ${targetTag} -- ${tentacleRelPath}`, gitDir);
    log.info({ enclave, tentacle, targetTag }, 'git checkout complete');

    // Step 3: git add
    git.exec(`add ${tentacleRelPath}`, gitDir);
    log.info({ enclave, tentacle }, 'git add complete');

    // Step 4: git commit (pre-commit hook bumps to next monotonic version)
    const commitMessage = `rollback(${tentacle}): revert to ${targetTag}`;
    git.exec(`commit -m "${commitMessage.replace(/"/g, '\\"')}"`, gitDir);
    log.info({ enclave, tentacle }, 'git commit complete');

    // Step 5: Read new version from workflow.yaml (post-hook bump)
    const workflowYamlPath = join(gitDir, tentacleRelPath, 'workflow.yaml');
    const newVersion = readVersionFromWorkflow(workflowYamlPath);
    const newTag = `${tentacle}-v${newVersion}`;

    // Step 6: git tag
    git.exec(
      `tag -a ${newTag} -m "Rollback ${tentacle} to ${targetTag} as v${newVersion}"`,
      gitDir,
    );
    log.info({ enclave, tentacle, newVersion, newTag }, 'git tag created');

    // Step 7: git push
    git.exec('push', gitDir);
    git.exec('push --tags', gitDir);
    log.info({ enclave, tentacle }, 'git push complete');

    // Get the new commit SHA
    const gitSha = git.exec('rev-parse HEAD', gitDir);

    // Step 8: Record rollback as pending
    const summary = `Rollback to ${targetTag}`;
    deployId = deployDb.insert({
      enclave,
      tentacle,
      version: newVersion,
      gitSha,
      gitTag: newTag,
      deployType: 'rollback',
      summary,
      details: `Reverted source to tag ${targetTag} (sha: ${tagSha})`,
      deployedByEmail: requestedByEmail,
      triggeredByChannel,
      triggeredByTs,
    });

    // Step 9: Call MCP wf_apply
    const rawResult = await mcpCall(
      'wf_apply',
      {
        enclave,
        tentacle,
        version: newVersion,
        git_sha: gitSha,
        git_tag: newTag,
      },
      userToken,
    );
    const result = rawResult as WfApplyResult;

    if (!result?.ok) {
      const errMsg =
        result?.message ?? 'wf_apply returned not-ok without message';
      deployDb.updateStatus(deployId, 'failed', errMsg);
      return {
        ok: false,
        message: `Rollback deploy failed: ${errMsg}`,
        newVersion,
        newTag,
        gitSha,
      };
    }

    deployDb.updateStatus(deployId, 'success');
    log.info(
      { enclave, tentacle, newVersion, newTag, targetTag },
      'rollback successful',
    );

    return {
      ok: true,
      message: `Rolled back ${tentacle} to ${targetTag}. New version: v${newVersion} (${newTag}).`,
      newVersion,
      newTag,
      gitSha,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ err, enclave, tentacle, targetTag }, 'rollback failed');

    if (deployId !== undefined) {
      deployDb.updateStatus(deployId, 'failed', errMsg);
    }

    return { ok: false, message: `Rollback error: ${errMsg}` };
  }
}
