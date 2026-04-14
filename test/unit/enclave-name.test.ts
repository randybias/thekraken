import { describe, it, expect } from 'vitest';
import { isValidEnclaveName } from '../../src/enclave/binding.js';

describe('isValidEnclaveName', () => {
  // Valid names
  it('accepts a simple lowercase name', () => {
    expect(isValidEnclaveName('marketing')).toBe(true);
  });

  it('accepts a name with hyphens', () => {
    expect(isValidEnclaveName('data-engineering')).toBe(true);
  });

  it('accepts a name with digits', () => {
    expect(isValidEnclaveName('team42')).toBe(true);
  });

  it('accepts a name starting with a digit', () => {
    expect(isValidEnclaveName('2fast')).toBe(true);
  });

  it('accepts a single character name', () => {
    expect(isValidEnclaveName('a')).toBe(true);
  });

  it('accepts a 63-character name (max length)', () => {
    expect(isValidEnclaveName('a'.repeat(63))).toBe(true);
  });

  it('accepts mixed hyphens and digits', () => {
    expect(isValidEnclaveName('web-app-v2')).toBe(true);
  });

  // Invalid names

  it('rejects empty string', () => {
    expect(isValidEnclaveName('')).toBe(false);
  });

  it('rejects a name starting with a hyphen', () => {
    expect(isValidEnclaveName('-marketing')).toBe(false);
  });

  it('rejects a name with uppercase letters', () => {
    expect(isValidEnclaveName('Marketing')).toBe(false);
  });

  it('rejects a name with underscores', () => {
    expect(isValidEnclaveName('my_team')).toBe(false);
  });

  it('rejects a name with spaces', () => {
    expect(isValidEnclaveName('my team')).toBe(false);
  });

  it('rejects a name with path traversal (..)', () => {
    expect(isValidEnclaveName('../etc/passwd')).toBe(false);
  });

  it('rejects a name with path traversal (slash)', () => {
    expect(isValidEnclaveName('foo/bar')).toBe(false);
  });

  it('rejects a name longer than 63 characters', () => {
    expect(isValidEnclaveName('a'.repeat(64))).toBe(false);
  });

  it('rejects a name with special characters', () => {
    expect(isValidEnclaveName('team@company')).toBe(false);
  });

  it('rejects a name with dots', () => {
    expect(isValidEnclaveName('my.team')).toBe(false);
  });

  it('rejects null-byte injection', () => {
    expect(isValidEnclaveName('team\x00name')).toBe(false);
  });
});
