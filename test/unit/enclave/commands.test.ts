import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../../src/enclave/commands.js';

describe('parseCommand: provision', () => {
  it('matches bare `provision`', () => {
    const parsed = parseCommand('<@U123BOT> provision');
    expect(parsed?.command).toBe('provision');
    expect(parsed?.rawArgs).toBe('');
  });

  it('matches `provision as <name>`', () => {
    const parsed = parseCommand('<@U123BOT> provision as my-enclave');
    expect(parsed?.command).toBe('provision');
    expect(parsed?.rawArgs).toBe('as my-enclave');
  });

  it('matches `provision description <text>`', () => {
    const parsed = parseCommand(
      '<@U123BOT> provision description Test enclave',
    );
    expect(parsed?.command).toBe('provision');
    expect(parsed?.rawArgs).toBe('description Test enclave');
  });

  it('matches `provision as <name> description <text>`', () => {
    const parsed = parseCommand(
      '<@U123BOT> provision as my-enclave description Test enclave from E7',
    );
    expect(parsed?.command).toBe('provision');
    expect(parsed?.rawArgs).toBe(
      'as my-enclave description Test enclave from E7',
    );
  });

  it('does NOT match `provision this channel`', () => {
    const parsed = parseCommand('<@U123BOT> provision this channel');
    expect(parsed).toBeNull();
  });

  it('provision does NOT require @USER mention (unlike add/remove)', () => {
    const parsed = parseCommand('<@U123BOT> provision as foo');
    expect(parsed).not.toBeNull();
    expect(parsed?.command).toBe('provision');
  });

  it('does NOT match `provision as` (no name)', () => {
    const parsed = parseCommand('<@U123BOT> provision as');
    expect(parsed).toBeNull();
  });

  it('does NOT match `provision as ` (no name, trailing space)', () => {
    const parsed = parseCommand('<@U123BOT> provision as ');
    expect(parsed).toBeNull();
  });
});
