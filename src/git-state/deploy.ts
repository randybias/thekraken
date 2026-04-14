/**
 * Deploy flow: explanation gate, git commit/tag/push, MCP wf_apply.
 *
 * Flow:
 *   1. Validate agent explanation (10-80 chars, no jargon, not boilerplate)
 *   2. git add <tentacle dir> (stage all changes)
 *   3. git commit (pre-commit hook auto-bumps version in workflow.yaml)
 *   4. Read new version from workflow.yaml
 *   5. git tag v{version}
 *   6. git push + git push --tags
 *   7. Call MCP wf_apply with version + git_sha
 *   8. Record deploy in SQLite deployments table
 *
 * D6: Uses the user's OIDC token — no service tokens.
 * MCP cross-repo: wf_apply is the expected server-side MCP tool.
 *   Expected params: { enclave, tentacle, version, git_sha, git_tag }
 *   Expected response: { ok: boolean, message?: string }
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createChildLogger } from '../logger.js';
import { DeploymentDb } from './deployments-db.js';

const log = createChildLogger({ module: 'deploy' });

// ---------------------------------------------------------------------------
// Explanation validation
// ---------------------------------------------------------------------------

const MIN_EXPLANATION_LENGTH = 10;
const MAX_EXPLANATION_LENGTH = 80;

/**
 * Boilerplate patterns that indicate the agent did not write a real explanation.
 */
const BOILERPLATE_PATTERNS: RegExp[] = [
  /^deploy(ing)?\s+tentacle/i,
  /^updated?\s+tentacle/i,
  /^modified?\s+tentacle/i,
  /^changes?\s+to\s+tentacle/i,
  /^tentacle\s+update/i,
  /^auto\s*deploy/i,
  /^automated?\s+deploy/i,
  /^no\s+change/i,
  /^test\s*deploy/i,
  /^wip\b/i,
];

/**
 * Jargon terms that should not appear in user-facing deploy explanations.
 */
const JARGON_TERMS: RegExp[] = [
  /\bkubernetes\b/i,
  /\bk8s\b/i,
  /\bnamespace\b/i,
  /\bpod\b/i,
  /\bcontainer\b/i,
  /\bdocker\b/i,
  /\bhelm\b/i,
  /\bkubectl\b/i,
  /\btntc\b/i,
  /\bgit\s+sha\b/i,
  /\bgit\s+commit\b/i,
  /\bdag\b/i,
];

export interface ExplanationValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate an agent-generated deploy explanation.
 * Must be 10-80 chars, no jargon, not boilerplate.
 */
export function validateExplanation(
  explanation: string,
): ExplanationValidationResult {
  const trimmed = explanation.trim();

  if (trimmed.length < MIN_EXPLANATION_LENGTH) {
    return {
      valid: false,
      reason: `Explanation too short (${trimmed.length} chars, minimum ${MIN_EXPLANATION_LENGTH})`,
    };
  }

  if (trimmed.length > MAX_EXPLANATION_LENGTH) {
    return {
      valid: false,
      reason: `Explanation too long (${trimmed.length} chars, maximum ${MAX_EXPLANATION_LENGTH})`,
    };
  }

  for (const pattern of JARGON_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        reason: `Explanation contains technical jargon. Describe what the change does for users, not how it works.`,
      };
    }
  }

  for (const pattern of BOILERPLATE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        reason: `Explanation is boilerplate. Describe specifically what changed and why.`,
      };
    }
  }

  return { valid: true };
}

// Export JARGON_TERMS under the expected name used in validation
const JARGON_PATTERNS = JARGON_TERMS;

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export interface GitOps {
  /** Run a git command in the repo dir. Returns stdout. */
  exec(args: string, cwd: string): string;
}

/**
 * Production git operations using child_process.execSync.
 */
export const realGitOps: GitOps = {
  exec(args: string, cwd: string): string {
    return execSync(`git ${args}`, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  },
};

/**
 * Read the version from a workflow.yaml file.
 * Expects: version: <number>
 */
export function readVersionFromWorkflow(workflowYamlPath: string): number {
  const content = readFileSync(workflowYamlPath, 'utf8');
  const match = content.match(/^version:\s*(\d+)\s*$/m);
  if (!match) {
    throw new Error(
      `Could not parse version from workflow.yaml at ${workflowYamlPath}`,
    );
  }
  // noUncheckedIndexedAccess: match[1] exists because the regex has a capture group
  return parseInt(match[1]!, 10);
}

// ---------------------------------------------------------------------------
// MCP wf_apply interface (cross-repo dependency)
// ---------------------------------------------------------------------------

export interface WfApplyParams {
  enclave: string;
  tentacle: string;
  version: number;
  git_sha: string;
  git_tag: string;
}

export interface WfApplyResult {
  ok: boolean;
  message?: string;
}

export type McpCallFn = (
  tool: string,
  params: Record<string, unknown>,
  userToken: string,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Deploy params and result
// ---------------------------------------------------------------------------

export interface DeployParams {
  enclave: string;
  tentacle: string;
  /** Absolute path to the git-state repo root. */
  gitDir: string;
  /** Path to the tentacle directory relative to gitDir. */
  tentacleRelPath: string;
  /** Agent-generated explanation. Validated before proceeding. */
  explanation: string;
  /** Deploying user's email (for audit). */
  deployedByEmail: string;
  /** Slack channel ID that triggered the deploy. */
  triggeredByChannel: string;
  /** Slack message ts that triggered the deploy. */
  triggeredByTs: string;
  /** User OIDC token for MCP calls. */
  userToken: string;
}

export interface DeployResult {
  ok: boolean;
  message: string;
  version?: number;
  gitTag?: string;
  gitSha?: string;
}

// ---------------------------------------------------------------------------
// deploy()
// ---------------------------------------------------------------------------

/**
 * Execute the full deploy flow for a tentacle.
 *
 * Dependencies are injected for testability:
 *   - db: SQLite database (deployments table)
 *   - mcpCall: function to invoke MCP tools with user token
 *   - git: git operations (default: realGitOps, override in tests)
 */
export async function deploy(
  params: DeployParams,
  db: Database.Database,
  mcpCall: McpCallFn,
  git: GitOps = realGitOps,
): Promise<DeployResult> {
  const {
    enclave,
    tentacle,
    gitDir,
    tentacleRelPath,
    explanation,
    deployedByEmail,
    triggeredByChannel,
    triggeredByTs,
    userToken,
  } = params;

  // Step 1: Validate explanation
  const validation = validateExplanation(explanation);
  if (!validation.valid) {
    return {
      ok: false,
      message: `Invalid deploy explanation: ${validation.reason}`,
    };
  }

  const deployDb = new DeploymentDb(db);
  let deployId: number | undefined;

  try {
    // Step 2: git add
    git.exec(`add ${tentacleRelPath}`, gitDir);
    log.info({ enclave, tentacle }, 'git add complete');

    // Step 3: git commit (pre-commit hook bumps version)
    const commitMessage = `deploy(${tentacle}): ${explanation}`;
    git.exec(`commit -m "${commitMessage.replace(/"/g, '\\"')}"`, gitDir);
    log.info({ enclave, tentacle }, 'git commit complete');

    // Step 4: Read new version from workflow.yaml
    const workflowYamlPath = join(gitDir, tentacleRelPath, 'workflow.yaml');
    const version = readVersionFromWorkflow(workflowYamlPath);
    const gitTag = `${tentacle}-v${version}`;

    // Step 5: git tag
    git.exec(
      `tag -a ${gitTag} -m "Deploy ${tentacle} v${version}: ${explanation}"`,
      gitDir,
    );
    log.info({ enclave, tentacle, version, gitTag }, 'git tag created');

    // Step 6: git push
    git.exec('push', gitDir);
    git.exec('push --tags', gitDir);
    log.info({ enclave, tentacle }, 'git push complete');

    // Step 7: Get the commit SHA for the tag
    const gitSha = git.exec(`rev-parse HEAD`, gitDir);

    // Step 8: Record deploy as pending
    deployId = deployDb.insert({
      enclave,
      tentacle,
      version,
      gitSha,
      gitTag,
      deployType: 'deploy',
      summary: explanation,
      deployedByEmail,
      triggeredByChannel,
      triggeredByTs,
    });

    // Step 9: Call MCP wf_apply
    const applyParams: WfApplyParams = {
      enclave,
      tentacle,
      version,
      git_sha: gitSha,
      git_tag: gitTag,
    };

    const rawResult = await mcpCall(
      'wf_apply',
      applyParams as unknown as Record<string, unknown>,
      userToken,
    );
    const result = rawResult as WfApplyResult;

    if (!result?.ok) {
      const errMsg =
        result?.message ?? 'wf_apply returned not-ok without message';
      deployDb.updateStatus(deployId, 'failed', errMsg);
      return {
        ok: false,
        message: `Deploy failed: ${errMsg}`,
        version,
        gitTag,
        gitSha,
      };
    }

    deployDb.updateStatus(deployId, 'success');
    log.info({ enclave, tentacle, version, gitTag }, 'deploy successful');

    return {
      ok: true,
      message: `Deployed ${tentacle} v${version} to ${enclave}. ${explanation}`,
      version,
      gitTag,
      gitSha,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ err, enclave, tentacle }, 'deploy failed');

    if (deployId !== undefined) {
      deployDb.updateStatus(deployId, 'failed', errMsg);
    }

    return { ok: false, message: `Deploy error: ${errMsg}` };
  }
}
