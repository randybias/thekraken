import { describe, it, expect, beforeEach } from 'vitest';
import { MockSlackWebClient } from '../mocks/slack-client.js';
import {
  createAppMention,
  createMessage,
  createChannelArchive,
  createChannelRename,
  createMemberLeftChannel,
} from '../mocks/event-simulator.js';

describe('MockSlackWebClient', () => {
  let client: MockSlackWebClient;

  beforeEach(() => {
    client = new MockSlackWebClient();
  });

  it('records chat.postMessage calls', async () => {
    const chatClient = client.chat as {
      postMessage: (args: Record<string, unknown>) => Promise<unknown>;
    };
    await chatClient.postMessage({ channel: 'C123', text: 'hello' });

    const last = client.lastCall('chat.postMessage');
    expect(last).toBeDefined();
    expect(last!.method).toBe('chat.postMessage');
    expect(last!.args).toMatchObject({ channel: 'C123', text: 'hello' });
    expect(last!.timestamp).toBeGreaterThan(0);
  });

  it('records multiple calls for the same method', async () => {
    const chatClient = client.chat as {
      postMessage: (args: Record<string, unknown>) => Promise<unknown>;
    };
    await chatClient.postMessage({ channel: 'C1', text: 'first' });
    await chatClient.postMessage({ channel: 'C2', text: 'second' });

    expect(client.calls['chat.postMessage']).toHaveLength(2);
    expect(client.lastCall('chat.postMessage')!.args).toMatchObject({
      channel: 'C2',
    });
  });

  it('returns default { ok: true } for unscripted calls', async () => {
    const chatClient = client.chat as {
      postMessage: (args: Record<string, unknown>) => Promise<unknown>;
    };
    const result = await chatClient.postMessage({
      channel: 'C1',
      text: 'test',
    });
    expect(result).toEqual({ ok: true });
  });

  it('returns scripted response via addResponse (FIFO)', async () => {
    client.addResponse('chat.postMessage', { ok: true, ts: '111.001' });
    client.addResponse('chat.postMessage', { ok: true, ts: '222.002' });

    const chatClient = client.chat as {
      postMessage: (args: Record<string, unknown>) => Promise<{ ts: string }>;
    };
    const r1 = await chatClient.postMessage({ channel: 'C1', text: 'first' });
    const r2 = await chatClient.postMessage({ channel: 'C1', text: 'second' });

    expect(r1).toMatchObject({ ts: '111.001' });
    expect(r2).toMatchObject({ ts: '222.002' });
  });

  it('falls back to { ok: true } after scripted responses are exhausted', async () => {
    client.addResponse('chat.postMessage', { ok: true, ts: '999.001' });

    const chatClient = client.chat as {
      postMessage: (args: Record<string, unknown>) => Promise<unknown>;
    };
    await chatClient.postMessage({ channel: 'C1', text: 'first' });
    const r2 = await chatClient.postMessage({ channel: 'C1', text: 'second' });

    expect(r2).toEqual({ ok: true });
  });

  it('records calls on users.info', async () => {
    const usersClient = client.users as {
      info: (args: Record<string, unknown>) => Promise<unknown>;
    };
    await usersClient.info({ user: 'U123' });

    const last = client.lastCall('users.info');
    expect(last).toBeDefined();
    expect(last!.args).toMatchObject({ user: 'U123' });
  });

  it('reset() clears all calls and responses', async () => {
    client.addResponse('chat.postMessage', { ok: true, ts: 'xxx' });
    const chatClient = client.chat as {
      postMessage: (args: Record<string, unknown>) => Promise<unknown>;
    };
    await chatClient.postMessage({ channel: 'C1', text: 'hi' });

    client.reset();
    expect(client.calls).toEqual({});
    expect(client.lastCall('chat.postMessage')).toBeUndefined();

    // After reset, scripted response should be gone too
    const r = await chatClient.postMessage({
      channel: 'C1',
      text: 'post-reset',
    });
    expect(r).toEqual({ ok: true });
  });
});

describe('SlackEventSimulator', () => {
  it('createAppMention produces valid event_callback envelope', () => {
    const e = createAppMention({
      channel: 'C123',
      user: 'U456',
      text: '<@UBOTID> help',
    });
    expect(e.type).toBe('event_callback');
    expect(e.event.type).toBe('app_mention');
    expect(e.event.channel).toBe('C123');
    expect(e.event.user).toBe('U456');
    expect(e.event.text).toBe('<@UBOTID> help');
    expect(e.event_id).toMatch(/^Ev\d{9}$/);
    expect(e.team_id).toBe('T0000TEST');
  });

  it('createAppMention includes thread_ts when provided', () => {
    const e = createAppMention({
      channel: 'C123',
      user: 'U456',
      text: 'reply',
      threadTs: '1234567890.000001',
    });
    expect(e.event['thread_ts']).toBe('1234567890.000001');
  });

  it('createMessage produces valid message envelope', () => {
    const e = createMessage({ channel: 'C123', user: 'U789', text: 'hello' });
    expect(e.type).toBe('event_callback');
    expect(e.event.type).toBe('message');
    expect(e.event.channel).toBe('C123');
    expect(e.event.user).toBe('U789');
  });

  it('createChannelArchive produces valid archive envelope', () => {
    const e = createChannelArchive({ channel: 'C999' });
    expect(e.type).toBe('event_callback');
    expect(e.event.type).toBe('channel_archive');
    expect(e.event.channel).toBe('C999');
  });

  it('createChannelRename produces valid rename envelope', () => {
    const e = createChannelRename({ channel: 'C111', name: 'new-name' });
    expect(e.type).toBe('event_callback');
    expect(e.event.type).toBe('channel_rename');
    const ch = e.event['channel'] as { id: string; name: string };
    expect(ch.id).toBe('C111');
    expect(ch.name).toBe('new-name');
  });

  it('createMemberLeftChannel produces valid member_left envelope', () => {
    const e = createMemberLeftChannel({ channel: 'C222', user: 'U333' });
    expect(e.type).toBe('event_callback');
    expect(e.event.type).toBe('member_left_channel');
    expect(e.event.user).toBe('U333');
    expect(e.event.channel).toBe('C222');
  });

  it('generates unique event_id for each envelope', () => {
    const e1 = createAppMention({ channel: 'C1', user: 'U1', text: 'a' });
    const e2 = createAppMention({ channel: 'C1', user: 'U1', text: 'b' });
    expect(e1.event_id).not.toBe(e2.event_id);
  });
});
