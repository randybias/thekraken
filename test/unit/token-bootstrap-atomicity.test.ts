/**
 * Atomicity tests for writeTokenFile — rc.13 rescue finding #4.
 *
 * Verifies that the atomic write (tmp → fsync → rename) implementation:
 * - Writes the correct access_token field (schema unchanged)
 * - Overwrites correctly on repeated calls (rename replaces atomically)
 * - Preserves mode 0o600
 * - Does not leave behind *.tmp files after successful writes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeTokenFile } from '../../src/teams/token-bootstrap.js';

describe('writeTokenFile atomicity (rc.13)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'token-atomic-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes token.json with the access_token field', () => {
    writeTokenFile(dir, 'a-token', 300);
    const json = JSON.parse(readFileSync(join(dir, 'token.json'), 'utf8')) as Record<string, unknown>;
    expect(json['access_token']).toBe('a-token');
  });

  it('overwrites previous content atomically (no partial state)', () => {
    writeTokenFile(dir, 'first', 100);
    writeTokenFile(dir, 'second', 200);
    const json = JSON.parse(readFileSync(join(dir, 'token.json'), 'utf8')) as Record<string, unknown>;
    expect(json['access_token']).toBe('second');
  });

  it('written file has mode 0o600', () => {
    writeTokenFile(dir, 't', 300);
    const stat = statSync(join(dir, 'token.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('does not leave behind .tmp files after successful write', () => {
    writeTokenFile(dir, 't', 300);
    writeTokenFile(dir, 't2', 300);
    writeTokenFile(dir, 't3', 300);
    const files = readdirSync(dir);
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
  });

  it('returns the absolute path to token.json', () => {
    const result = writeTokenFile(dir, 'tok', 60);
    expect(result).toBe(join(dir, 'token.json'));
  });

  it('written JSON contains expires_at and updated_at fields', () => {
    const before = Math.floor(Date.now() / 1000);
    writeTokenFile(dir, 'tok', 3600);
    const after = Math.floor(Date.now() / 1000);
    const json = JSON.parse(readFileSync(join(dir, 'token.json'), 'utf8')) as Record<string, unknown>;
    expect(typeof json['expires_at']).toBe('number');
    expect(json['expires_at'] as number).toBeGreaterThanOrEqual(before + 3600);
    expect(json['expires_at'] as number).toBeLessThanOrEqual(after + 3600 + 2);
    expect(typeof json['updated_at']).toBe('string');
    expect(new Date(json['updated_at'] as string).getFullYear()).toBeGreaterThan(2024);
  });
});
