import { describe, it, expect } from 'vitest';
import { injectContext } from '../../src/agent/context-injector.js';

describe('injectContext', () => {
  it('prepends [CONTEXT] block to message in enclave mode', () => {
    const result = injectContext('list workflows', {
      enclaveName: 'production',
      userEmail: 'alice@example.com',
      slackUserId: 'U012ABC',
      mode: 'enclave',
    });

    expect(result).toBe(
      '[CONTEXT]\n' +
        'enclave: production\n' +
        'user_email: alice@example.com\n' +
        'slack_user_id: U012ABC\n' +
        'mode: enclave\n' +
        '[/CONTEXT]\n' +
        '\n' +
        'list workflows',
    );
  });

  it('prepends [CONTEXT] block to message in DM mode', () => {
    const result = injectContext('what enclaves exist?', {
      enclaveName: null,
      userEmail: 'unknown',
      slackUserId: 'U999XYZ',
      mode: 'dm',
    });

    expect(result).toBe(
      '[CONTEXT]\n' +
        'enclave: none\n' +
        'user_email: unknown\n' +
        'slack_user_id: U999XYZ\n' +
        'mode: dm\n' +
        '[/CONTEXT]\n' +
        '\n' +
        'what enclaves exist?',
    );
  });

  it('uses "none" for enclave when enclaveName is null', () => {
    const result = injectContext('hello', {
      enclaveName: null,
      userEmail: 'unknown',
      slackUserId: 'U001',
      mode: 'dm',
    });
    expect(result).toContain('enclave: none');
  });

  it('preserves the original message text exactly', () => {
    const message = 'multi-line\nmessage with\tspecial chars!';
    const result = injectContext(message, {
      enclaveName: 'test',
      userEmail: 'unknown',
      slackUserId: 'U001',
      mode: 'enclave',
    });
    expect(result).toContain(message);
    // The message should appear after the [/CONTEXT] block
    const contextEnd = result.indexOf('[/CONTEXT]');
    const messageStart = result.indexOf(message);
    expect(messageStart).toBeGreaterThan(contextEnd);
  });

  it('block format: [CONTEXT] tag on first line', () => {
    const result = injectContext('test', {
      enclaveName: 'x',
      userEmail: 'unknown',
      slackUserId: 'U1',
      mode: 'enclave',
    });
    expect(result.startsWith('[CONTEXT]\n')).toBe(true);
  });

  it('block format: [/CONTEXT] closing tag present', () => {
    const result = injectContext('test', {
      enclaveName: 'x',
      userEmail: 'unknown',
      slackUserId: 'U1',
      mode: 'enclave',
    });
    expect(result).toContain('[/CONTEXT]');
  });

  it('Phase 1 placeholder: user_email can be "unknown"', () => {
    const result = injectContext('test', {
      enclaveName: 'x',
      userEmail: 'unknown',
      slackUserId: 'U1',
      mode: 'enclave',
    });
    expect(result).toContain('user_email: unknown');
  });
});
