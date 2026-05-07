/**
 * Cookie-jar persistence for Chroma E2E browser session.
 *
 * The runner loads cookies from disk on startup and hands them to
 * Playwright's BrowserContext via addCookies(). At end of run the
 * post-session cookies get saved back. On first run with no cookie
 * file, the runner prompts the user to log in (boot-driver.ts handles
 * the prompt; this module provides the file I/O primitives).
 *
 * Spec: docs/superpowers/specs/2026-05-07-chroma-e2e-platform-tests-design.md
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Playwright cookie shape, kept narrow so we don't bind the public
 * Cookie type from playwright (which would require importing it at
 * module load).
 */
export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'None' | 'Strict';
}

/**
 * Default location for the persisted cookie jar.
 *
 * Override via KRAKEN_E2E_CHROMA_COOKIES env var. Default is
 * ~/.kraken-e2e-chroma/cookies.json — outside the repo, mode 0o600.
 */
export function defaultCookiePath(): string {
  const env = process.env.KRAKEN_E2E_CHROMA_COOKIES;
  if (env) return env;
  return join(homedir(), '.kraken-e2e-chroma', 'cookies.json');
}

/**
 * Read cookies from disk.
 *
 * Returns [] when the file does not exist (first-run path). Throws
 * on other I/O errors so the caller learns about permission problems.
 */
export async function loadCookies(path: string): Promise<Cookie[]> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as Cookie[];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Write cookies to disk atomically (temp + rename) with mode 0o600.
 *
 * Creates parent directories if missing.
 */
export async function saveCookies(
  path: string,
  cookies: Cookie[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cookies, null, 2), { mode: 0o600 });
}

/**
 * Wait for a cookies file to appear at the given path.
 *
 * Used after prompting the user to log in: poll every 1 second until
 * the file exists AND has non-zero size (so we don't read mid-write).
 * Throws on timeout.
 */
export async function waitForCookies(
  path: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const s = await stat(path);
      if (s.size > 0) return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for cookies file at ${path}`);
}
