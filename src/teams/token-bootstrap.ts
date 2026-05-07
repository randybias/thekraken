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
 * TNTC_ACCESS_TOKEN is NOT in the spawn env (B2, lifecycle.ts).
 * Subprocesses must read the token from KRAKEN_TOKEN_FILE on each call.
 *
 * rc.13: writeTokenFile uses atomic write semantics (write tmp, fsync,
 * rename) so concurrent readers see either the old intact file or the new
 * intact file, never a half-written or empty token.json. Codex rescue
 * finding #4.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
 * Uses atomic write semantics: writes to a temp file, fsyncs, then renames
 * over token.json. POSIX rename() is atomic — concurrent readers (including
 * the pi-coding-agent subprocess reading via 'cat $KRAKEN_TOKEN_FILE | jq
 * -r .access_token' on every tntc/MCP call) see either the old file
 * (intact) or the new file (intact), never a partial write.
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
  const tmpPath = `${tokenPath}.${randomUUID().slice(0, 8)}.tmp`;

  const now = Math.floor(Date.now() / 1000);
  const contents: TokenFileContents = {
    access_token: accessToken,
    expires_at: now + expiresIn,
    updated_at: new Date().toISOString(),
  };
  const payload = JSON.stringify(contents, null, 2) + '\n';

  try {
    writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    const fd = openSync(tmpPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, tokenPath);
  } catch (err) {
    // Clean up the tmp file on failure to avoid leaking *.tmp files.
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp may not exist if writeFileSync threw early
    }
    throw err;
  }

  return tokenPath;
}
