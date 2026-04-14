import { describe, it, expect, vi } from 'vitest';
import {
  postAuthCard,
  postAuthSuccess,
  postAuthTimeout,
  postAuthDenial,
} from '../../src/slack/auth-card.js';
import type { WebClient } from '@slack/web-api';

// ---------------------------------------------------------------------------
// Mock Slack WebClient
// ---------------------------------------------------------------------------

function makeClient(): {
  mock: WebClient;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const mock = {
    chat: {
      postEphemeral: vi.fn().mockImplementation(async (args: unknown) => {
        calls.push(args as Record<string, unknown>);
        return { ok: true };
      }),
    },
  } as unknown as WebClient;
  return { mock, calls };
}

// ---------------------------------------------------------------------------
// postAuthCard
// ---------------------------------------------------------------------------

describe('postAuthCard', () => {
  it('calls chat.postEphemeral with correct channel and user', async () => {
    const { mock, calls } = makeClient();
    await postAuthCard(mock, {
      channel: 'C001',
      userId: 'U001',
      verificationUri: 'https://kc.example.com/activate',
      userCode: 'ABCD-EFGH',
      expiresIn: 600,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!['channel']).toBe('C001');
    expect(calls[0]!['user']).toBe('U001');
  });

  it('includes verificationUri in text fallback', async () => {
    const { mock, calls } = makeClient();
    await postAuthCard(mock, {
      channel: 'C001',
      userId: 'U001',
      verificationUri: 'https://kc.example.com/activate',
      userCode: 'WXYZ-1234',
      expiresIn: 300,
    });

    expect(calls[0]!['text']).toContain('https://kc.example.com/activate');
    expect(calls[0]!['text']).toContain('WXYZ-1234');
  });

  it('includes user code in blocks', async () => {
    const { mock, calls } = makeClient();
    await postAuthCard(mock, {
      channel: 'C001',
      userId: 'U001',
      verificationUri: 'https://kc.example.com/activate',
      userCode: 'TEST-CODE',
      expiresIn: 600,
    });

    const blocks = calls[0]!['blocks'] as unknown[];
    const blocksStr = JSON.stringify(blocks);
    expect(blocksStr).toContain('TEST-CODE');
  });

  it('shows expiry time in minutes in blocks', async () => {
    const { mock, calls } = makeClient();
    await postAuthCard(mock, {
      channel: 'C001',
      userId: 'U001',
      verificationUri: 'https://kc.example.com/activate',
      userCode: 'ABCD',
      expiresIn: 600, // 10 minutes
    });

    const blocksStr = JSON.stringify(calls[0]!['blocks']);
    expect(blocksStr).toContain('10 minutes');
  });
});

// ---------------------------------------------------------------------------
// postAuthSuccess
// ---------------------------------------------------------------------------

describe('postAuthSuccess', () => {
  it('calls postEphemeral with channel and user', async () => {
    const { mock, calls } = makeClient();
    await postAuthSuccess(mock, 'C002', 'U002');

    expect(calls[0]!['channel']).toBe('C002');
    expect(calls[0]!['user']).toBe('U002');
  });

  it('mentions 12-hour session in text', async () => {
    const { mock, calls } = makeClient();
    await postAuthSuccess(mock, 'C002', 'U002');

    expect(calls[0]!['text']).toContain('12 hours');
  });
});

// ---------------------------------------------------------------------------
// postAuthTimeout
// ---------------------------------------------------------------------------

describe('postAuthTimeout', () => {
  it('calls postEphemeral with channel and user', async () => {
    const { mock, calls } = makeClient();
    await postAuthTimeout(mock, 'C003', 'U003');

    expect(calls[0]!['channel']).toBe('C003');
    expect(calls[0]!['user']).toBe('U003');
  });

  it('mentions timed out in message text', async () => {
    const { mock, calls } = makeClient();
    await postAuthTimeout(mock, 'C003', 'U003');

    const text = (calls[0]!['text'] as string).toLowerCase();
    expect(text).toMatch(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// postAuthDenial
// ---------------------------------------------------------------------------

describe('postAuthDenial', () => {
  it('calls postEphemeral with the reason text', async () => {
    const { mock, calls } = makeClient();
    await postAuthDenial(
      mock,
      'C004',
      'U004',
      "You don't have permission to do that.",
    );

    expect(calls[0]!['channel']).toBe('C004');
    expect(calls[0]!['user']).toBe('U004');
    expect(calls[0]!['text']).toContain("don't have permission");
  });
});
