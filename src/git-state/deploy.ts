/**
 * Deploy flow: run `tntc deploy` for a tentacle directory.
 *
 * Executes tntc as a subprocess with the user's OIDC token passed via the
 * TNTC_ACCESS_TOKEN environment variable. Returns a structured result so
 * callers can record the outcome in the deployments table and report back
 * to Slack.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

export interface DeployParams {
  /** Absolute path to the tentacle directory inside the git-state repo. */
  tentacleDir: string;
  /** Name of the target enclave (cluster). Passed to tntc --cluster. */
  enclaveName: string;
  /** The user's OIDC access token. Set as TNTC_ACCESS_TOKEN env var. */
  userToken: string;
  /** Working directory for the subprocess (root of the git-state repo). */
  gitStateDir: string;
}

export interface DeployResult {
  success: boolean;
  /** Combined stdout from tntc deploy. */
  output: string;
  /** Error detail (stderr or exception message) on failure. */
  error?: string;
}

/**
 * Deploy a tentacle by shelling out to `tntc deploy`.
 *
 * @param params - Deploy parameters.
 * @returns A DeployResult describing whether deployment succeeded.
 */
export async function deployTentacle(
  params: DeployParams,
): Promise<DeployResult> {
  const { tentacleDir, enclaveName, userToken, gitStateDir } = params;

  try {
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
      { enclave: enclaveName, tentacle: tentacleDir },
      'deploy succeeded',
    );
    return { success: true, output: stdout };
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    logger.warn(
      { enclave: enclaveName, tentacle: tentacleDir, err },
      'deploy failed',
    );
    return {
      success: false,
      output: nodeErr.stdout ?? '',
      error:
        nodeErr.stderr ?? (err instanceof Error ? err.message : String(err)),
    };
  }
}
