import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkModeBit,
  resolveRole,
  classifyOperation,
  buildDenialMessage,
  checkAccess,
  invalidateAuthzCache,
} from '../../src/enclave/authz.js';

describe('resolveRole', () => {
  const info = {
    owner: 'alice@example.com',
    members: ['bob@example.com', 'carol@example.com'],
    mode: 'rwxrwx---',
    status: 'active',
    name: 'test-enclave',
  };

  it('resolves owner', () => {
    expect(resolveRole('alice@example.com', info)).toBe('owner');
  });
  it('resolves owner case-insensitive', () => {
    expect(resolveRole('Alice@Example.COM', info)).toBe('owner');
  });
  it('resolves member', () => {
    expect(resolveRole('bob@example.com', info)).toBe('member');
  });
  it('resolves visitor', () => {
    expect(resolveRole('stranger@example.com', info)).toBe('visitor');
  });
});

describe('checkModeBit', () => {
  it('owner always allowed', () => {
    expect(checkModeBit('------', 'owner', 'write')).toBe(true);
  });
  it('member read allowed with rwxrwx---', () => {
    expect(checkModeBit('rwxrwx---', 'member', 'read')).toBe(true);
  });
  it('member write allowed with rwxrwx---', () => {
    expect(checkModeBit('rwxrwx---', 'member', 'write')).toBe(true);
  });
  it('visitor denied with rwxrwx---', () => {
    expect(checkModeBit('rwxrwx---', 'visitor', 'read')).toBe(false);
  });
  it('visitor read allowed with rwxrwxr--', () => {
    expect(checkModeBit('rwxrwxr--', 'visitor', 'read')).toBe(true);
  });
  it('visitor write denied with rwxrwxr--', () => {
    expect(checkModeBit('rwxrwxr--', 'visitor', 'write')).toBe(false);
  });
});

describe('classifyOperation', () => {
  it('classifies deploy as write', () => {
    expect(classifyOperation('deploy my-tentacle')).toBe('write');
  });
  it('classifies run as execute', () => {
    expect(classifyOperation('run the workflow')).toBe('execute');
  });
  it('classifies status check as read', () => {
    expect(classifyOperation('show me the status')).toBe('read');
  });
  it('defaults ambiguous text to read', () => {
    expect(classifyOperation('hello kraken')).toBe('read');
  });
});

describe('checkAccess', () => {
  const mockMcpCall = async (
    _tool: string,
    _params: Record<string, unknown>,
  ) => ({
    owner: 'alice@example.com',
    members: ['bob@example.com'],
    mode: 'rwxrwx---',
    status: 'active',
    name: 'test-enclave',
  });

  beforeEach(() => {
    invalidateAuthzCache('test-enclave');
    invalidateAuthzCache('some-channel');
  });

  it('allows owner for any operation', async () => {
    const decision = await checkAccess(
      'alice@example.com',
      'test-enclave',
      'execute',
      mockMcpCall,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.role).toBe('owner');
  });

  it('allows member read', async () => {
    const decision = await checkAccess(
      'bob@example.com',
      'test-enclave',
      'read',
      mockMcpCall,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.role).toBe('member');
  });

  it('denies visitor', async () => {
    const decision = await checkAccess(
      'stranger@example.com',
      'test-enclave',
      'read',
      mockMcpCall,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.role).toBe('visitor');
  });

  it('denies non-owner write on frozen enclave', async () => {
    const frozenMcp = async (
      _tool: string,
      _params: Record<string, unknown>,
    ) => ({
      owner: 'alice@example.com',
      members: ['bob@example.com'],
      mode: 'rwxrwx---',
      status: 'frozen',
      name: 'test-enclave',
    });
    // Must invalidate so the frozen mock is used, not the cached active entry.
    invalidateAuthzCache('test-enclave');
    const decision = await checkAccess(
      'bob@example.com',
      'test-enclave',
      'write',
      frozenMcp,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('frozen');
  });

  it('allows when not an enclave (mcpCall returns no owner)', async () => {
    const noEnclaveMcp = async (
      _tool: string,
      _params: Record<string, unknown>,
    ) => ({});
    const decision = await checkAccess(
      'anyone@example.com',
      'some-channel',
      'write',
      noEnclaveMcp,
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('buildDenialMessage', () => {
  it('frozen enclave message', () => {
    expect(buildDenialMessage('member', 'write', 'frozen')).toContain('frozen');
  });
  it('visitor message suggests asking owner', () => {
    expect(buildDenialMessage('visitor', 'read', 'active')).toContain('owner');
  });
  it('never uses jargon', () => {
    const msg = buildDenialMessage('member', 'execute', 'active');
    expect(msg).not.toContain('POSIX');
    expect(msg).not.toContain('namespace');
    expect(msg).not.toContain('authorization');
    expect(msg).not.toContain('mode bit');
  });
});
