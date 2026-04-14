import { describe, it, expect } from 'vitest';
import {
  checkModeBit,
  resolveRole,
  classifyOperation,
  buildDenialMessage,
} from '../../src/enclave/authz.js';

describe('resolveRole', () => {
  const info = {
    owner: 'alice@example.com',
    members: ['bob@example.com', 'carol@example.com'],
    mode: 'rwxrwx---', status: 'active', name: 'test-enclave',
  };

  it('resolves owner', () => { expect(resolveRole('alice@example.com', info)).toBe('owner'); });
  it('resolves owner case-insensitive', () => { expect(resolveRole('Alice@Example.COM', info)).toBe('owner'); });
  it('resolves member', () => { expect(resolveRole('bob@example.com', info)).toBe('member'); });
  it('resolves visitor', () => { expect(resolveRole('stranger@example.com', info)).toBe('visitor'); });
});

describe('checkModeBit', () => {
  it('owner always allowed', () => { expect(checkModeBit('------', 'owner', 'write')).toBe(true); });
  it('member read allowed with rwxrwx---', () => { expect(checkModeBit('rwxrwx---', 'member', 'read')).toBe(true); });
  it('member write allowed with rwxrwx---', () => { expect(checkModeBit('rwxrwx---', 'member', 'write')).toBe(true); });
  it('visitor denied with rwxrwx---', () => { expect(checkModeBit('rwxrwx---', 'visitor', 'read')).toBe(false); });
  it('visitor read allowed with rwxrwxr--', () => { expect(checkModeBit('rwxrwxr--', 'visitor', 'read')).toBe(true); });
  it('visitor write denied with rwxrwxr--', () => { expect(checkModeBit('rwxrwxr--', 'visitor', 'write')).toBe(false); });
});

describe('classifyOperation', () => {
  it('classifies deploy as write', () => { expect(classifyOperation('deploy my-tentacle')).toBe('write'); });
  it('classifies run as execute', () => { expect(classifyOperation('run the workflow')).toBe('execute'); });
  it('classifies status check as read', () => { expect(classifyOperation('show me the status')).toBe('read'); });
  it('defaults ambiguous text to read', () => { expect(classifyOperation('hello kraken')).toBe('read'); });
});

describe('buildDenialMessage', () => {
  it('frozen enclave message', () => { expect(buildDenialMessage('member', 'write', 'frozen')).toContain('frozen'); });
  it('visitor message suggests asking owner', () => { expect(buildDenialMessage('visitor', 'read', 'active')).toContain('owner'); });
  it('never uses jargon', () => {
    const msg = buildDenialMessage('member', 'execute', 'active');
    expect(msg).not.toContain('POSIX');
    expect(msg).not.toContain('namespace');
    expect(msg).not.toContain('authorization');
    expect(msg).not.toContain('mode bit');
  });
});
