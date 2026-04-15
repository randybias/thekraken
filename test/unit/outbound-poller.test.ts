/**
 * OutboundPoller unit tests (T11).
 *
 * Coverage:
 * - start() begins polling
 * - stop() performs final drain
 * - Records from outbound.ndjson are posted to Slack
 * - Heartbeat records are posted like normal messages
 * - Dedup: already-posted records are skipped
 * - Multiple teams polled in each cycle
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createTeamFixture } from '../helpers/team-fixture.js';
import { waitForRecord } from '../helpers/ndjson.js';
import { OutboundPoller } from '../../src/teams/outbound-poller.js';
import { createDatabase } from '../../src/db/migrations.js';
import { OutboundTracker } from '../../src/slack/outbound.js';
import type { KrakenConfig } from '../../src/config.js';
import * as formatter from '../../src/slack/formatter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(teamsDir: string): KrakenConfig {
  return {
    teamsDir,
    gitState: {
      repoUrl: 'https://github.com/x/y.git',
      branch: 'main',
      dir: '/tmp/git-state',
    },
    slack: { botToken: 'xoxb-test', mode: 'http' },
    oidc: {
      issuer: 'https://keycloak',
      clientId: 'kraken',
      clientSecret: 'sec',
    },
    mcp: { url: 'http://mcp:8080', port: 8080 },
    llm: {
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
      allowedProviders: ['anthropic'],
      allowedModels: {},
      disallowedModels: [],
      anthropicApiKey: 'sk-ant-test',
    },
    server: { port: 3000 },
    observability: { otlpEndpoint: '', logLevel: 'silent' },
  } as KrakenConfig;
}

function makeOutboundRecord(overrides: object = {}): object {
  return {
    id: `out-${Date.now()}`,
    timestamp: new Date().toISOString(),
    type: 'slack_message',
    channelId: 'C_TEST',
    threadTs: '1111.000',
    text: 'Build complete!',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OutboundPoller', () => {
  const fixtures: ReturnType<typeof createTeamFixture>[] = [];
  let postedMessages: Array<{
    channel: string;
    thread_ts?: string;
    text: string;
  }>;
  let poller: OutboundPoller;

  beforeEach(() => {
    postedMessages = [];
  });

  afterEach(async () => {
    if (poller) await poller.stop();
    for (const f of fixtures.splice(0)) f.cleanup();
    vi.clearAllMocks();
  });

  function makePoller(
    fixture: ReturnType<typeof createTeamFixture>,
    activeTeams: string[],
  ): OutboundPoller {
    const db = createDatabase(':memory:');
    const tracker = new OutboundTracker(db);

    return new OutboundPoller({
      config: makeConfig(fixture.teamsDir),
      teams: {
        isTeamActive: (name: string) => activeTeams.includes(name),
      },
      slack: {
        postMessage: vi.fn(async (params) => {
          postedMessages.push(params);
          return { ts: `1234.${postedMessages.length}` };
        }),
      },
      tracker,
      getActiveTeams: () => activeTeams,
    });
  }

  it('posts outbound records to Slack', async () => {
    const f = createTeamFixture('test-enc');
    fixtures.push(f);

    // Write a record BEFORE starting the poller
    f.appendOutbound(makeOutboundRecord({ text: 'hello from team' }));

    poller = makePoller(f, ['test-enc']);
    await poller.stop(); // immediate stop = drain

    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0]!.text).toBe('hello from team');
    expect(postedMessages[0]!.channel).toBe('C_TEST');
  });

  it('posts heartbeat records to Slack (D5)', async () => {
    const f = createTeamFixture('heartbeat-enc');
    fixtures.push(f);

    f.appendOutbound(
      makeOutboundRecord({
        type: 'heartbeat',
        text: 'Your builder is working on the sentiment analyser.',
        mentionUser: 'U_ALICE',
      }),
    );

    poller = makePoller(f, ['heartbeat-enc']);
    await poller.stop();

    expect(postedMessages).toHaveLength(1);
    // mentionUser should be prepended
    expect(postedMessages[0]!.text).toContain('<@U_ALICE>');
    expect(postedMessages[0]!.text).toContain('Your builder is working');
  });

  it('posts to correct thread_ts', async () => {
    const f = createTeamFixture('thread-enc');
    fixtures.push(f);

    f.appendOutbound(
      makeOutboundRecord({ channelId: 'C_CHAN', threadTs: '9999.123' }),
    );

    poller = makePoller(f, ['thread-enc']);
    await poller.stop();

    expect(postedMessages[0]!.thread_ts).toBe('9999.123');
    expect(postedMessages[0]!.channel).toBe('C_CHAN');
  });

  it('polls multiple teams', async () => {
    const f1 = createTeamFixture('enc-one');
    const f2 = createTeamFixture('enc-two');
    fixtures.push(f1, f2);

    f1.appendOutbound(
      makeOutboundRecord({ text: 'from enc-one', channelId: 'C_ONE' }),
    );
    f2.appendOutbound(
      makeOutboundRecord({ text: 'from enc-two', channelId: 'C_TWO' }),
    );

    // Create a merged teamsDir — both fixtures live in their own teamsDir.
    // We need enc-two's outbound.ndjson visible under f1's teamsDir.
    // Use symlink to avoid src===dest issue when dirs overlap in /tmp.
    const { symlinkSync, existsSync } = await import('node:fs');
    const twoLink = f1.teamsDir + '/enc-two';
    if (!existsSync(twoLink)) {
      symlinkSync(f2.dir, twoLink);
    }

    const db = createDatabase(':memory:');
    const tracker = new OutboundTracker(db);
    poller = new OutboundPoller({
      config: makeConfig(f1.teamsDir),
      teams: { isTeamActive: () => true },
      slack: {
        postMessage: vi.fn(async (params) => {
          postedMessages.push(params);
          return { ts: `ts-${postedMessages.length}` };
        }),
      },
      tracker,
      getActiveTeams: () => ['enc-one', 'enc-two'],
    });

    await poller.stop(); // drain

    const channels = postedMessages.map((m) => m.channel);
    expect(channels).toContain('C_ONE');
    expect(channels).toContain('C_TWO');
  });

  it('deduplicates records already in SQLite (pod restart)', async () => {
    const f = createTeamFixture('dedup-enc');
    fixtures.push(f);

    f.appendOutbound(makeOutboundRecord({ text: 'first message' }));

    // Pre-populate SQLite to simulate a prior post
    const db = createDatabase(':memory:');
    const tracker = new OutboundTracker(db);
    tracker.store('C_TEST', '1111.000', 'ts-1', 'first message');

    poller = new OutboundPoller({
      config: makeConfig(f.teamsDir),
      teams: { isTeamActive: () => true },
      slack: {
        postMessage: vi.fn(async (p) => {
          postedMessages.push(p);
          return { ts: 'ts-2' };
        }),
      },
      tracker,
      getActiveTeams: () => ['dedup-enc'],
    });

    await poller.stop();

    // Should not post again — dedup says already posted
    expect(postedMessages).toHaveLength(0);
  });

  it('applies formatter blocks when postMessage is called', async () => {
    const f = createTeamFixture('fmt-enc');
    fixtures.push(f);

    const fakeBlock = {
      type: 'section' as const,
      text: { type: 'mrkdwn' as const, text: 'hi' },
    };
    vi.spyOn(formatter, 'formatAgentResponse').mockReturnValue({
      blocks: [fakeBlock],
      text: 'hi',
    });

    f.appendOutbound(makeOutboundRecord({ text: 'hi' }));
    poller = makePoller(f, ['fmt-enc']);
    await poller.stop();

    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0]!.blocks).toEqual([fakeBlock]);

    vi.restoreAllMocks();
  });

  it('posts overflow batches as follow-up messages in the same thread', async () => {
    const f = createTeamFixture('overflow-enc');
    fixtures.push(f);

    const mainBlock = {
      type: 'section' as const,
      text: { type: 'mrkdwn' as const, text: 'main' },
    };
    const overflowBlock = {
      type: 'section' as const,
      text: { type: 'mrkdwn' as const, text: 'overflow' },
    };

    vi.spyOn(formatter, 'formatAgentResponse').mockReturnValue({
      blocks: [mainBlock],
      text: 'main text',
      overflow: [[overflowBlock]],
    });

    f.appendOutbound(
      makeOutboundRecord({
        text: 'long message',
        channelId: 'C_OVER',
        threadTs: '1234.000',
      }),
    );

    poller = makePoller(f, ['overflow-enc']);
    await poller.stop();

    // Main message + 1 overflow batch = 2 posts
    expect(postedMessages).toHaveLength(2);
    expect(postedMessages[0]!.blocks).toEqual([mainBlock]);
    expect(postedMessages[1]!.blocks).toEqual([overflowBlock]);
    // Both go to the same channel
    expect(postedMessages[1]!.channel).toBe('C_OVER');

    vi.restoreAllMocks();
  });

  it('skips outbound records with empty text and does not post to Slack (Bug 3)', async () => {
    const f = createTeamFixture('empty-text-enc');
    fixtures.push(f);

    // Write one empty-text record and one valid record
    f.appendOutbound(
      makeOutboundRecord({ text: '', id: 'empty-1' }),
    );
    f.appendOutbound(
      makeOutboundRecord({ text: 'real message', id: 'real-1' }),
    );

    poller = makePoller(f, ['empty-text-enc']);
    await poller.stop();

    // Only the valid record should have been posted
    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0]!.text).toBe('real message');
  });

  it('skips outbound records with whitespace-only text (Bug 3)', async () => {
    const f = createTeamFixture('whitespace-enc');
    fixtures.push(f);

    f.appendOutbound(makeOutboundRecord({ text: '   \n  ' }));

    poller = makePoller(f, ['whitespace-enc']);
    await poller.stop();

    expect(postedMessages).toHaveLength(0);
  });

  it('falls back to mailbox channelId/threadTs when outbound record lacks them (Bug 2)', async () => {
    const f = createTeamFixture('fallback-enc');
    fixtures.push(f);

    // Write a mailbox record with valid channel/thread info
    f.appendMailbox({
      id: 'mb-1',
      timestamp: new Date().toISOString(),
      from: 'dispatcher',
      type: 'user_message',
      threadTs: '9876.543',
      channelId: 'C_FALLBACK',
      userSlackId: 'U_BOB',
      userToken: 'tok-bob',
      message: 'hello',
    });

    // Write an outbound record that is missing channelId and threadTs
    f.appendOutbound({
      id: 'out-no-channel',
      timestamp: new Date().toISOString(),
      type: 'slack_message',
      channelId: '',
      threadTs: '',
      text: 'agent reply without channel',
    });

    poller = makePoller(f, ['fallback-enc']);
    await poller.stop();

    // Should have posted using the mailbox fallback values
    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0]!.channel).toBe('C_FALLBACK');
    expect(postedMessages[0]!.thread_ts).toBe('9876.543');
    expect(postedMessages[0]!.text).toBe('agent reply without channel');
  });

  it('skips outbound record when no channelId and no mailbox fallback available (Bug 2)', async () => {
    const f = createTeamFixture('no-fallback-enc');
    fixtures.push(f);

    // No mailbox.ndjson written — fallback unavailable
    f.appendOutbound({
      id: 'out-orphan',
      timestamp: new Date().toISOString(),
      type: 'slack_message',
      channelId: '',
      threadTs: '',
      text: 'orphan message',
    });

    poller = makePoller(f, ['no-fallback-enc']);
    await poller.stop();

    // Should have been skipped (no channel to post to)
    expect(postedMessages).toHaveLength(0);
  });

  it('start() and stop() lifecycle', async () => {
    const f = createTeamFixture('lifecycle-enc');
    fixtures.push(f);

    poller = makePoller(f, ['lifecycle-enc']);
    poller.start();

    // Write a record after start
    f.appendOutbound(
      makeOutboundRecord({ text: 'async record', threadTs: '5555.000' }),
    );

    // Wait for it to be picked up
    await waitForRecord(
      f.outboundPath,
      (r) => (r as { text: string }).text === 'async record',
      2000,
    );

    await poller.stop();

    // Should have been posted
    const texts = postedMessages.map((m) => m.text);
    expect(texts).toContain('async record');
  });
});
