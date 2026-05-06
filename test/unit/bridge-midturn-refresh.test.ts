/**
 * Unit tests for the mid-turn token refresh tick (C5 / Task 14).
 *
 * Tests the exported midTurnRefreshTick helper directly — no timer plumbing
 * required. The helper is the actual body of the 60-second interval tick
 * inside TeamBridge; testing it directly gives full coverage without needing
 * to construct a full bridge instance.
 *
 * Cases covered:
 *   1. Calls writeFile with the fresh token when getTokenForUser returns one.
 *   2. Skips writeFile when getTokenForUser returns null.
 *   3. Skips writeFile when currentRecord is null.
 *   4. Skips writeFile when getTokenForUser is undefined.
 *   5. Logs warn but does NOT throw when getTokenForUser rejects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { midTurnRefreshTick } from '../../src/teams/bridge.js';

// Suppress pino output during tests
vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  createChildLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

const FAKE_ENCLAVE = 'test-enclave';
const FAKE_TEAM_DIR = '/tmp/team-dir-test';
const FAKE_USER = 'U_ALICE';

const FAKE_RECORD = { userSlackId: FAKE_USER };

/**
 * Build a minimal JWT with an exp claim (expired is fine for unit tests;
 * extractExpiresIn reads the claim, clamps to at least 60s).
 */
function makeJwt(expOffset = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString(
    'base64url',
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ sub: 'U_ALICE', exp: now + expOffset }),
  ).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('midTurnRefreshTick', () => {
  let writeFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeFile = vi.fn();
  });

  it('calls writeFile with the fresh token when getTokenForUser returns one', async () => {
    const token = makeJwt();
    const getTokenForUser = vi.fn(async (_userId: string) => token);

    await midTurnRefreshTick({
      enclaveName: FAKE_ENCLAVE,
      teamDir: FAKE_TEAM_DIR,
      currentRecord: FAKE_RECORD,
      getTokenForUser,
      writeFile,
    });

    expect(getTokenForUser).toHaveBeenCalledWith(FAKE_USER);
    expect(writeFile).toHaveBeenCalledOnce();
    const [dir, tok] = writeFile.mock.calls[0] as [string, string, number];
    expect(dir).toBe(FAKE_TEAM_DIR);
    expect(tok).toBe(token);
  });

  it('passes a positive expiresIn to writeFile', async () => {
    const token = makeJwt(7200);
    const getTokenForUser = vi.fn(async (_userId: string) => token);

    await midTurnRefreshTick({
      enclaveName: FAKE_ENCLAVE,
      teamDir: FAKE_TEAM_DIR,
      currentRecord: FAKE_RECORD,
      getTokenForUser,
      writeFile,
    });

    const [, , expiresIn] = writeFile.mock.calls[0] as [string, string, number];
    expect(expiresIn).toBeGreaterThan(0);
  });

  it('skips writeFile when getTokenForUser returns null', async () => {
    const getTokenForUser = vi.fn(async (_userId: string) => null);

    await midTurnRefreshTick({
      enclaveName: FAKE_ENCLAVE,
      teamDir: FAKE_TEAM_DIR,
      currentRecord: FAKE_RECORD,
      getTokenForUser,
      writeFile,
    });

    expect(getTokenForUser).toHaveBeenCalledWith(FAKE_USER);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('skips writeFile when currentRecord is null', async () => {
    const getTokenForUser = vi.fn(async (_userId: string) => makeJwt());

    await midTurnRefreshTick({
      enclaveName: FAKE_ENCLAVE,
      teamDir: FAKE_TEAM_DIR,
      currentRecord: null,
      getTokenForUser,
      writeFile,
    });

    expect(getTokenForUser).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('skips writeFile when getTokenForUser is undefined', async () => {
    await midTurnRefreshTick({
      enclaveName: FAKE_ENCLAVE,
      teamDir: FAKE_TEAM_DIR,
      currentRecord: FAKE_RECORD,
      getTokenForUser: undefined,
      writeFile,
    });

    expect(writeFile).not.toHaveBeenCalled();
  });

  it('does not throw when getTokenForUser rejects', async () => {
    const getTokenForUser = vi.fn(async (_userId: string) => {
      throw new Error('refresh-rejected');
    });

    await expect(
      midTurnRefreshTick({
        enclaveName: FAKE_ENCLAVE,
        teamDir: FAKE_TEAM_DIR,
        currentRecord: FAKE_RECORD,
        getTokenForUser,
        writeFile,
      }),
    ).resolves.toBeUndefined();

    expect(writeFile).not.toHaveBeenCalled();
  });
});
