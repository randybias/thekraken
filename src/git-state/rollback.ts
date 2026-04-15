/**
 * Rollback flow: re-deploy a prior version of a tentacle from git history.
 *
 * Checks out the tentacle directory at the given git SHA into a temporary
 * working path, then calls `tntc deploy` against it. The result is a new
 * monotonically increasing version number in the deployments table, so the
 * audit trail is always append-only.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

export interface RollbackParams {
  /** Absolute path to the tentacle directory inside the git-state repo. */
  tentacleDir: string;
  /** Name of the target enclave (cluster). Passed to tntc --cluster. */
  enclaveName: string;
  /** The user's OIDC access token. Set as TNTC_ACCESS_TOKEN env var. */
  userToken: string;
  /** Working directory (root of the git-state repo). */
  gitStateDir: string;
  /** The git SHA to roll back to. */
  targetSha: string;
}

export interface RollbackResult {
  success: boolean;
  /** Combined stdout from tntc deploy during rollback. */
  output: string;
  /** Error detail on failure. */
  error?: string;
  /** The git SHA that was checked out for the rollback. */
  rolledBackToSha: string;
}

/**
 * Roll back a tentacle to a prior git SHA.
 *
 * Uses `git show` to extract the tentacle directory at the target SHA into
 * a temporary directory, then delegates to `tntc deploy`. Returns a
 * RollbackResult; the caller is responsible for recording the new version
 * in the deployments table.
 *
 * @param params - Rollback parameters.
 * @returns A RollbackResult describing whether rollback succeeded.
 */
export async function rollbackTentacle(
  params: RollbackParams,
): Promise<RollbackResult> {
  const { tentacleDir, enclaveName, userToken, gitStateDir, targetSha } =
    params;

  try {
    // Restore the tentacle directory at the target SHA using `git checkout`.
    // This mutates the working tree in-place; the caller must ensure the
    // git-state repo is not otherwise in use during rollback.
    await execFileAsync('git', ['checkout', targetSha, '--', tentacleDir], {
      cwd: gitStateDir,
      timeout: 30_000,
    });

    logger.info(
      { enclave: enclaveName, tentacle: tentacleDir, targetSha },
      'git checkout for rollback succeeded',
    );

    // Re-deploy using the restored directory.
    const { stdout } = await execFileAsync(
      'tntc',
      ['deploy', '--cluster', enclaveName, tentacleDir],
      {
        env: {
          ...process.env,
          TNTC_ACCESS_TOKEN: userToken,
        },
        cwd: gitStateDir,
        timeout: 120_000,
      },
    );

    logger.info(
      { enclave: enclaveName, tentacle: tentacleDir, targetSha },
      'rollback deploy succeeded',
    );
    return {
      success: true,
      output: stdout,
      rolledBackToSha: targetSha,
    };
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    logger.warn(
      { enclave: enclaveName, tentacle: tentacleDir, targetSha, err },
      'rollback failed',
    );
    return {
      success: false,
      output: nodeErr.stdout ?? '',
      error:
        nodeErr.stderr ?? (err instanceof Error ? err.message : String(err)),
      rolledBackToSha: targetSha,
    };
  }
}
