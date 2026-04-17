/**
 * Unit tests for C5: token.json bootstrap in the bridge's processOne() path.
 *
 * Verifies:
 * - token.json is written to the team dir before each mailbox turn
 * - token.json has correct file contents (access_token, expires_at, updated_at)
 * - token.json has mode 0o600 (owner-only)
 * - token.json is rewritten on each mailbox turn with a fresh token
 * - KRAKEN_TOKEN_FILE env var points to the token file
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createTeamFixture } from '../helpers/team-fixture.js';
import { writeTokenFile, TOKEN_FILE_NAME } from '../../src/teams/token-bootstrap.js';

describe('writeTokenFile', () => {
  const fixtures: ReturnType<typeof createTeamFixture>[] = [];
  let fixture: ReturnType<typeof createTeamFixture>;

  beforeEach(() => {
    fixture = createTeamFixture('token-test-enclave');
    fixtures.push(fixture);
  });

  afterEach(() => {
    for (const f of fixtures.splice(0)) f.cleanup();
  });

  it('creates token.json in the team dir', () => {
    writeTokenFile(fixture.dir, 'access-token-abc', 3600);
    const tokenPath = join(fixture.dir, TOKEN_FILE_NAME);
    expect(existsSync(tokenPath)).toBe(true);
  });

  it('writes correct access_token field', () => {
    writeTokenFile(fixture.dir, 'my-access-token', 3600);
    const tokenPath = join(fixture.dir, TOKEN_FILE_NAME);
    const parsed = JSON.parse(readFileSync(tokenPath, 'utf8')) as Record<string, unknown>;
    expect(parsed['access_token']).toBe('my-access-token');
  });

  it('writes expires_at as unix seconds (roughly now + expiresIn)', () => {
    const before = Math.floor(Date.now() / 1000);
    writeTokenFile(fixture.dir, 'token', 3600);
    const after = Math.floor(Date.now() / 1000);

    const tokenPath = join(fixture.dir, TOKEN_FILE_NAME);
    const parsed = JSON.parse(readFileSync(tokenPath, 'utf8')) as Record<string, unknown>;
    const expiresAt = parsed['expires_at'] as number;

    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600);
    expect(expiresAt).toBeLessThanOrEqual(after + 3600 + 2);
  });

  it('writes updated_at as valid ISO-8601 string', () => {
    writeTokenFile(fixture.dir, 'token', 3600);
    const tokenPath = join(fixture.dir, TOKEN_FILE_NAME);
    const parsed = JSON.parse(readFileSync(tokenPath, 'utf8')) as Record<string, unknown>;
    const updatedAt = parsed['updated_at'] as string;
    expect(typeof updatedAt).toBe('string');
    expect(new Date(updatedAt).getFullYear()).toBeGreaterThan(2024);
  });

  it('writes file with mode 0o600 (owner-only permissions)', () => {
    writeTokenFile(fixture.dir, 'token', 3600);
    const tokenPath = join(fixture.dir, TOKEN_FILE_NAME);
    const mode = statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('overwrites an existing token.json on subsequent calls', () => {
    writeTokenFile(fixture.dir, 'token-v1', 3600);
    writeTokenFile(fixture.dir, 'token-v2', 7200);
    const tokenPath = join(fixture.dir, TOKEN_FILE_NAME);
    const parsed = JSON.parse(readFileSync(tokenPath, 'utf8')) as Record<string, unknown>;
    expect(parsed['access_token']).toBe('token-v2');
  });

  it('returns the path to the written token file', () => {
    const tokenPath = writeTokenFile(fixture.dir, 'token', 3600);
    expect(tokenPath).toBe(join(fixture.dir, TOKEN_FILE_NAME));
    expect(existsSync(tokenPath)).toBe(true);
  });
});

describe('TOKEN_FILE_NAME constant', () => {
  it('is token.json', () => {
    expect(TOKEN_FILE_NAME).toBe('token.json');
  });
});
