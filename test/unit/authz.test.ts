import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveRole,
  checkModeBit,
  checkAccess,
  invalidateCache,
  type EnclaveInfo,
  type Operation,
  type Role,
} from '../../src/enclave/authz.js';

const FULL_MODE = 'rwxrwxrwx';
const READ_ONLY_MEMBER = 'rwxr--r--';
const OWNER_ONLY = 'rwx------';
const READ_EXEC_MEMBER = 'rwxr-xr-x';

function makeInfo(overrides: Partial<EnclaveInfo> = {}): EnclaveInfo {
  return {
    owner: 'alice@example.com',
    members: ['bob@example.com'],
    mode: FULL_MODE,
    status: 'active',
    name: 'test-enclave',
    ...overrides,
  };
}

function makeMcpCall(
  info: EnclaveInfo | null,
): (tool: string, params: Record<string, unknown>) => Promise<unknown> {
  return async (_tool, _params) => {
    if (info === null) throw new Error('enclave not found');
    return info;
  };
}

beforeEach(() => {
  invalidateCache('test-enclave');
  invalidateCache('frozen-enclave');
  invalidateCache('member-read-only');
  invalidateCache('missing-enclave');
});

describe('resolveRole', () => {
  const info = makeInfo();

  it('returns owner for the owner email', () => {
    expect(resolveRole('alice@example.com', info)).toBe('owner');
  });

  it('is case-insensitive for owner', () => {
    expect(resolveRole('Alice@Example.COM', info)).toBe('owner');
  });

  it('returns member for a member email', () => {
    expect(resolveRole('bob@example.com', info)).toBe('member');
  });

  it('is case-insensitive for members', () => {
    expect(resolveRole('BOB@EXAMPLE.COM', info)).toBe('member');
  });

  it('returns visitor for an unknown email', () => {
    expect(resolveRole('eve@example.com', info)).toBe('visitor');
  });
});

describe('checkModeBit', () => {
  it('owner always gets true regardless of mode bits', () => {
    expect(checkModeBit('---', 'owner', 'read')).toBe(true);
    expect(checkModeBit('---', 'owner', 'write')).toBe(true);
    expect(checkModeBit('---', 'owner', 'execute')).toBe(true);
  });

  it('member can read when member bits allow read', () => {
    // "rwxrwxr-x" -> member bits: chars 3-5 = "rwx"
    expect(checkModeBit('rwxrwxr-x', 'member', 'read')).toBe(true);
  });

  it('member cannot write when member bits deny write', () => {
    // "rwxr-xr-x" -> member bits: chars 3-5 = "r-x"
    expect(checkModeBit('rwxr-xr-x', 'member', 'write')).toBe(false);
  });

  it('member can execute when member bits allow execute', () => {
    expect(checkModeBit('rwxrwxr-x', 'member', 'execute')).toBe(true);
  });

  it('visitor can read when visitor bits allow read', () => {
    expect(checkModeBit('rwxrwxr--', 'visitor', 'read')).toBe(true);
  });

  it('visitor cannot write when visitor bits deny write', () => {
    expect(checkModeBit('rwxrwxr--', 'visitor', 'write')).toBe(false);
  });

  it('visitor cannot execute when visitor bits deny execute', () => {
    expect(checkModeBit('rwxrwxr--', 'visitor', 'execute')).toBe(false);
  });

  it('handles fully restricted mode', () => {
    expect(checkModeBit('---------', 'member', 'read')).toBe(false);
    expect(checkModeBit('---------', 'visitor', 'read')).toBe(false);
  });
});

describe('checkAccess — owner bypass', () => {
  it('owner always gets access for any operation', async () => {
    const mcpCall = makeMcpCall(makeInfo({ mode: '---------' }));
    const r = await checkAccess(
      'alice@example.com',
      'test-enclave',
      'write',
      mcpCall,
    );
    invalidateCache('test-enclave');
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('owner');
  });
});

describe('checkAccess — member mode bits', () => {
  it('member allowed when mode permits', async () => {
    const mcpCall = makeMcpCall(makeInfo({ mode: READ_ONLY_MEMBER }));
    const r = await checkAccess(
      'bob@example.com',
      'test-enclave',
      'read',
      mcpCall,
    );
    invalidateCache('test-enclave');
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('member');
  });

  it('member denied write on read-only mode', async () => {
    const mcpCall = makeMcpCall(makeInfo({ mode: READ_ONLY_MEMBER }));
    const r = await checkAccess(
      'bob@example.com',
      'test-enclave',
      'write',
      mcpCall,
    );
    invalidateCache('test-enclave');
    expect(r.allowed).toBe(false);
    expect(r.role).toBe('member');
    expect(r.reason).toBeTruthy();
  });
});

describe('checkAccess — visitor mode bits', () => {
  it('visitor allowed read when visitor bits permit', async () => {
    const info = makeInfo({ mode: 'rwxrwxr--', members: [] });
    const mcpCall = makeMcpCall(info);
    const r = await checkAccess(
      'eve@example.com',
      'test-enclave',
      'read',
      mcpCall,
    );
    invalidateCache('test-enclave');
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('visitor');
  });

  it('visitor denied write', async () => {
    const info = makeInfo({ mode: 'rwxrwxr--', members: [] });
    const mcpCall = makeMcpCall(info);
    const r = await checkAccess(
      'eve@example.com',
      'test-enclave',
      'write',
      mcpCall,
    );
    invalidateCache('test-enclave');
    expect(r.allowed).toBe(false);
    expect(r.role).toBe('visitor');
    expect(r.reason).toMatch(/visiting/);
  });
});

describe('checkAccess — frozen enclave', () => {
  it('member denied write in frozen enclave', async () => {
    const mcpCall = makeMcpCall(makeInfo({ status: 'frozen' }));
    const r = await checkAccess(
      'bob@example.com',
      'frozen-enclave',
      'write',
      mcpCall,
    );
    invalidateCache('frozen-enclave');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/frozen/);
  });

  it('member denied execute in frozen enclave', async () => {
    const mcpCall = makeMcpCall(
      makeInfo({ status: 'frozen', name: 'frozen-enclave' }),
    );
    const r = await checkAccess(
      'bob@example.com',
      'frozen-enclave',
      'execute',
      mcpCall,
    );
    invalidateCache('frozen-enclave');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/frozen/);
  });

  it('member allowed read in frozen enclave', async () => {
    const mcpCall = makeMcpCall(
      makeInfo({ status: 'frozen', mode: FULL_MODE }),
    );
    const r = await checkAccess(
      'bob@example.com',
      'frozen-enclave',
      'read',
      mcpCall,
    );
    invalidateCache('frozen-enclave');
    expect(r.allowed).toBe(true);
  });

  it('owner bypasses frozen enclave restriction', async () => {
    const mcpCall = makeMcpCall(makeInfo({ status: 'frozen' }));
    const r = await checkAccess(
      'alice@example.com',
      'frozen-enclave',
      'execute',
      mcpCall,
    );
    invalidateCache('frozen-enclave');
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('owner');
  });
});

describe('checkAccess — graceful degradation when enclave_info fails', () => {
  it('returns allowed=true when MCP call throws (enclave not found)', async () => {
    const mcpCall = makeMcpCall(null);
    const r = await checkAccess(
      'anyone@example.com',
      'missing-enclave',
      'write',
      mcpCall,
    );
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('visitor');
  });
});

describe('checkAccess — cache behavior', () => {
  it('uses cached result for second call', async () => {
    let callCount = 0;
    const mcpCall = async (_tool: string, _params: Record<string, unknown>) => {
      callCount++;
      return makeInfo();
    };

    await checkAccess('bob@example.com', 'test-enclave', 'read', mcpCall);
    await checkAccess('alice@example.com', 'test-enclave', 'write', mcpCall);
    invalidateCache('test-enclave');

    // Only one MCP call should have been made (cache hit on second)
    expect(callCount).toBe(1);
  });

  it('invalidateCache forces fresh fetch', async () => {
    let callCount = 0;
    const mcpCall = async (_tool: string, _params: Record<string, unknown>) => {
      callCount++;
      return makeInfo();
    };

    await checkAccess('alice@example.com', 'test-enclave', 'read', mcpCall);
    invalidateCache('test-enclave');
    await checkAccess('alice@example.com', 'test-enclave', 'read', mcpCall);
    invalidateCache('test-enclave');

    expect(callCount).toBe(2);
  });
});

describe('denial message content', () => {
  it('visitor denial mentions "visiting"', async () => {
    const info = makeInfo({ mode: OWNER_ONLY, members: [] });
    const mcpCall = makeMcpCall(info);
    const r = await checkAccess(
      'eve@example.com',
      'test-enclave',
      'write',
      mcpCall,
    );
    invalidateCache('test-enclave');
    expect(r.reason).toContain('visiting');
  });

  it('member write denial mentions "read-only"', async () => {
    const info = makeInfo({ mode: 'rwxr--r--' });
    const mcpCall = makeMcpCall(info);
    const r = await checkAccess(
      'bob@example.com',
      'test-enclave',
      'write',
      mcpCall,
    );
    invalidateCache('test-enclave');
    expect(r.reason).toContain('read-only');
  });

  it('member execute denial mentions "run tasks"', async () => {
    const info = makeInfo({ mode: 'rwxr--r--' });
    const mcpCall = makeMcpCall(info);
    const r = await checkAccess(
      'bob@example.com',
      'test-enclave',
      'execute',
      mcpCall,
    );
    invalidateCache('test-enclave');
    expect(r.reason).toContain('run tasks');
  });
});
