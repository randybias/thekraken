import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  defaultCookiePath,
  loadCookies,
  saveCookies,
  waitForCookies,
  type Cookie,
} from '../../e2e-chroma/chroma-session.js';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('chroma-session cookie jar', () => {
  let dir: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-session-'));
    origEnv = process.env.KRAKEN_E2E_CHROMA_COOKIES;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.KRAKEN_E2E_CHROMA_COOKIES;
    else process.env.KRAKEN_E2E_CHROMA_COOKIES = origEnv;
  });

  describe('defaultCookiePath', () => {
    it('honors KRAKEN_E2E_CHROMA_COOKIES env var', () => {
      process.env.KRAKEN_E2E_CHROMA_COOKIES = '/tmp/test/foo.json';
      expect(defaultCookiePath()).toBe('/tmp/test/foo.json');
    });

    it('defaults to ~/.kraken-e2e-chroma/cookies.json when env var unset', () => {
      delete process.env.KRAKEN_E2E_CHROMA_COOKIES;
      expect(defaultCookiePath()).toMatch(
        /\.kraken-e2e-chroma\/cookies\.json$/,
      );
    });
  });

  describe('loadCookies', () => {
    it('returns empty array when file is missing', async () => {
      const cookies = await loadCookies(join(dir, 'missing.json'));
      expect(cookies).toEqual([]);
    });

    it('reads back what saveCookies wrote', async () => {
      const path = join(dir, 'cookies.json');
      const cookies: Cookie[] = [
        { name: 'session', value: 'abc', domain: 'chroma.test', path: '/' },
      ];
      await saveCookies(path, cookies);
      const loaded = await loadCookies(path);
      expect(loaded).toEqual(cookies);
    });
  });

  describe('saveCookies', () => {
    it('creates parent directories if missing', async () => {
      const path = join(dir, 'nested', 'deep', 'cookies.json');
      await saveCookies(path, []);
      expect(existsSync(path)).toBe(true);
    });

    it('writes file with mode 0o600', async () => {
      const path = join(dir, 'cookies.json');
      await saveCookies(path, []);
      const s = statSync(path);
      expect(s.mode & 0o777).toBe(0o600);
    });

    it('overwrites previous contents', async () => {
      const path = join(dir, 'cookies.json');
      await saveCookies(path, [{ name: 'a', value: '1' }]);
      await saveCookies(path, [{ name: 'b', value: '2' }]);
      const loaded = await loadCookies(path);
      expect(loaded).toEqual([{ name: 'b', value: '2' }]);
    });
  });

  describe('waitForCookies', () => {
    it('returns immediately when file already exists with content', async () => {
      const path = join(dir, 'cookies.json');
      writeFileSync(path, '[]');
      const start = Date.now();
      await waitForCookies(path, 5_000);
      expect(Date.now() - start).toBeLessThan(2_000);
    });

    it('throws on timeout when file never appears', async () => {
      const path = join(dir, 'never.json');
      await expect(waitForCookies(path, 1_500)).rejects.toThrow(/timed out/i);
    });

    it('returns when file is created before timeout', async () => {
      const path = join(dir, 'late.json');
      // Schedule file creation 500ms in the future
      setTimeout(() => writeFileSync(path, '[]'), 500);
      const start = Date.now();
      await waitForCookies(path, 5_000);
      expect(Date.now() - start).toBeLessThan(3_000);
    });

    it('does not return on zero-size file (waits for content)', async () => {
      const path = join(dir, 'empty.json');
      writeFileSync(path, ''); // empty file
      // Schedule actual content 500ms later
      setTimeout(() => writeFileSync(path, '[{"name":"a","value":"b"}]'), 500);
      const start = Date.now();
      await waitForCookies(path, 5_000);
      const elapsed = Date.now() - start;
      // Should have waited at least 500ms (until content arrived)
      expect(elapsed).toBeGreaterThanOrEqual(400);
    });
  });
});
