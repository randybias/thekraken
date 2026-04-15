/**
 * deployTentacle unit tests.
 *
 * Coverage:
 * - Returns success result when tntc exits 0
 * - Returns failure result when tntc exits non-zero
 * - Error message is sanitized (sensitive lines stripped, truncated to 500 chars)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock node:child_process so execFile invokes its callback synchronously.
// promisify wraps execFile with a callback, so the mock must accept:
//   (cmd, args, opts, callback)
// and invoke callback(err, {stdout, stderr}).
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  return { execFile };
});

const { execFile } = await import('node:child_process');
const mockExecFile = execFile as ReturnType<typeof vi.fn>;

const { deployTentacle } = await import('../../src/git-state/deploy.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExecCallback = (
  err: (Error & { stdout?: string; stderr?: string; code?: number }) | null,
  result?: { stdout: string; stderr: string },
) => void;

function makeParams(
  overrides: Partial<Parameters<typeof deployTentacle>[0]> = {},
) {
  return {
    tentacleDir: '/git-state/my-enclave/my-tentacle',
    enclaveName: 'my-enclave',
    userToken: 'token-abc123',
    gitStateDir: '/git-state',
    ...overrides,
  };
}

function mockSuccess(stdout: string): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback): void => {
      cb(null, { stdout, stderr: '' });
    },
  );
}

function mockFailure(stderr: string, stdout = ''): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback): void => {
      const err = Object.assign(new Error('tntc failed'), {
        stdout,
        stderr,
        code: 1,
      });
      cb(err);
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockExecFile.mockReset();
});

describe('deployTentacle', () => {
  it('returns success=true and stdout when tntc exits 0', async () => {
    mockSuccess('Deployed successfully\n');

    const result = await deployTentacle(makeParams());

    expect(result.success).toBe(true);
    expect(result.output).toBe('Deployed successfully\n');
    expect(result.error).toBeUndefined();
  });

  it('returns success=false when tntc exits non-zero', async () => {
    mockFailure('Error: connection refused', 'partial stdout');

    const result = await deployTentacle(makeParams());

    expect(result.success).toBe(false);
    expect(result.output).toBe('partial stdout');
  });

  it('strips lines containing "token" from error output', async () => {
    mockFailure('bearer token: abc123\nActual error occurred');

    const result = await deployTentacle(makeParams());

    expect(result.error).not.toContain('token');
    expect(result.error).toContain('Actual error occurred');
  });

  it('strips lines containing "secret" from error output', async () => {
    mockFailure('OIDC_CLIENT_SECRET=mysecret\nDeploy failed');

    const result = await deployTentacle(makeParams());

    expect(result.error).not.toContain('secret');
    expect(result.error).toContain('Deploy failed');
  });

  it('strips lines containing "password" from error output', async () => {
    mockFailure('password=hunter2\nConnection failed');

    const result = await deployTentacle(makeParams());

    expect(result.error).not.toContain('password');
    expect(result.error).toContain('Connection failed');
  });

  it('strips lines containing "key" from error output (case-insensitive)', async () => {
    mockFailure('API_KEY=sk-1234\nInvalid configuration');

    const result = await deployTentacle(makeParams());

    expect(result.error).not.toContain('API_KEY');
    expect(result.error).toContain('Invalid configuration');
  });

  it('truncates error output to 500 characters', async () => {
    const longError = 'x'.repeat(1000);
    mockFailure(longError);

    const result = await deployTentacle(makeParams());

    // 500 chars + ellipsis char = at most 501
    expect(result.error!.length).toBeLessThanOrEqual(501);
  });
});
