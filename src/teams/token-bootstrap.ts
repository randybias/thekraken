/**
 * Token bootstrap utilities — C5.
 *
 * Writes a fresh token.json file to the team directory before each mailbox
 * turn. This gives manager and dev team subprocesses access to a current
 * access token without embedding it in the subprocess spawn environment
 * (which is frozen at spawn time).
 *
 * File format:
 *   {
 *     "access_token": "<jwt>",
 *     "expires_at": <unix-seconds>,
 *     "updated_at": "<ISO-8601>"
 *   }
 *
 * The file is written with mode 0o600 (owner-only) to protect the token.
 *
 * Subprocess reads the token via:
 *   export TNTC_ACCESS_TOKEN=$(cat "$KRAKEN_TOKEN_FILE" | jq -r .access_token)
 *
 * KRAKEN_TOKEN_FILE env var is set in subprocess env (lifecycle.ts C3).
 * The frozen TNTC_ACCESS_TOKEN env var is still set (B2 removes it in the
 * next PR; this PR adds the file-based path alongside the env-based path).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Name of the token file within the team directory. */
export const TOKEN_FILE_NAME = 'token.json';

/** Structure written to token.json. */
export interface TokenFileContents {
  access_token: string;
  /** Unix timestamp (seconds) when the token expires. */
  expires_at: number;
  /** ISO-8601 timestamp of when this file was written. */
  updated_at: string;
}

/**
 * Write a fresh token.json to the team directory.
 *
 * Creates or overwrites token.json with mode 0o600.
 *
 * @param teamDir - Absolute path to the team directory (e.g. /app/data/teams/myenclave).
 * @param accessToken - The OIDC access token string.
 * @param expiresIn - Token lifetime in seconds from now (used to compute expires_at).
 * @returns The absolute path to the written token file.
 */
export function writeTokenFile(
  teamDir: string,
  accessToken: string,
  expiresIn: number,
): string {
  const tokenPath = join(teamDir, TOKEN_FILE_NAME);
  const now = Math.floor(Date.now() / 1000);
  const contents: TokenFileContents = {
    access_token: accessToken,
    expires_at: now + expiresIn,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(tokenPath, JSON.stringify(contents, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'w',
  });
  return tokenPath;
}
