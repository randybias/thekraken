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

/**
 * Sensitive keyword pattern used to scrub stderr lines before returning
 * error details to callers (which may forward them to Slack).
 */
const SENSITIVE_LINE_RE = /token|secret|password|key/i;

/**
 * Build a minimal allow-listed subprocess env.
 *
 * D6 compliance: never spread process.env — it leaks OIDC_CLIENT_SECRET,
 * SLACK_BOT_TOKEN, and other runtime secrets into the subprocess shell.
 * Only the four variables below are required for `tntc deploy`.
 */
function buildSubprocessEnv(userToken: string): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/home/node',
    NODE_ENV: process.env['NODE_ENV'] ?? 'production',
    TNTC_ACCESS_TOKEN: userToken,
  };
}

/**
 * Sanitize stderr before surfacing it to callers.
 *
 * - Strips lines that match sensitive keywords (token, secret, password, key).
 * - Truncates the result to 500 characters.
 */
function sanitizeStderr(raw: string): string {
  const filtered = raw
    .split('\n')
    .filter((line) => !SENSITIVE_LINE_RE.test(line))
    .join('\n');
  return filtered.length > 500 ? filtered.slice(0, 500) + '…' : filtered;
}

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
        env: buildSubprocessEnv(userToken),
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
      code?: number | string;
    };
    // Log full stderr at warn level — stays in pod logs, never sent to Slack.
    logger.warn(
      { enclave: enclaveName, tentacle: tentacleDir, err },
      'deploy failed',
    );
    const rawStderr =
      nodeErr.stderr ?? (err instanceof Error ? err.message : String(err));
    return {
      success: false,
      output: nodeErr.stdout ?? '',
      error: sanitizeStderr(rawStderr),
    };
  }
}
