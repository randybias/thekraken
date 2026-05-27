/**
 * N4: outbound-poller threadTs trust tests.
 *
 * Production incident 2026-05-27: a tentacle emitted outbound record with
 * threadTs='' (top-of-channel intent). The poller treated '' as falsy and
 * replaced it with the manager's current threadTs from mailbox fallback,
 * so the channel-level report landed inside the management thread.
 *
 * Fix: threadTs is trusted exactly as written by the tentacle/team.
 * Only channelId still falls back to mailbox when absent.
 *
 * Coverage:
 * - Empty threadTs → posted at top of channel (no thread_ts in postMessage)
 * - Explicit threadTs → posts in that thread
 * - Missing channelId → falls back to mailbox channelId (unchanged behaviour)
 * - Empty channelId AND empty threadTs AND no mailbox → skipped with error
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTeamFixture } from '../../helpers/team-fixture.js';
import { OutboundPoller } from '../../../src/teams/outbound-poller.js';
import { createDatabase } from '../../../src/db/migrations.js';
import { initCursorStore } from '../../../src/db/cursors.js';
import { OutboundTracker } from '../../../src/slack/outbound.js';
import type { KrakenConfig } from '../../../src/config.js';

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
    cluster: { name: 'eastus' },
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

function makePoller(
  fixture: ReturnType<typeof createTeamFixture>,
  activeTeams: string[],
  postedMessages: Array<{ channel: string; thread_ts?: string; text: string }>,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('N4: outbound-poller threadTs trust', () => {
  const fixtures: ReturnType<typeof createTeamFixture>[] = [];
  let pollers: OutboundPoller[] = [];

  beforeEach(() => {
    initCursorStore(createDatabase(':memory:'));
  });

  afterEach(async () => {
    for (const p of pollers.splice(0)) await p.stop();
    for (const f of fixtures.splice(0)) f.cleanup();
    vi.clearAllMocks();
  });

  it('empty threadTs → posts at top of channel (no thread_ts in postMessage)', async () => {
    const posted: Array<{ channel: string; thread_ts?: string; text: string }> =
      [];
    const f = createTeamFixture('n4-empty-ts');
    fixtures.push(f);

    // Mailbox has a non-empty threadTs — must NOT be used to override ''
    f.appendMailbox({
      id: 'mb-1',
      timestamp: new Date().toISOString(),
      from: 'dispatcher',
      type: 'user_message',
      threadTs: 'T_mgr',
      channelId: 'C_ENCLAVE',
      userSlackId: 'U_ALICE',
      userToken: 'tok-alice',
      message: 'weekly check',
    });

    const poller = makePoller(f, ['n4-empty-ts'], posted);
    pollers.push(poller);
    await poller.drainOnce();

    // Tentacle emits top-of-channel report (threadTs='')
    f.appendOutbound({
      id: 'out-report',
      timestamp: new Date().toISOString(),
      type: 'slack_message',
      channelId: 'C123',
      threadTs: '',
      text: 'Weekly NVIDIA digest',
    });
    await poller.stop();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.channel).toBe('C123');
    // thread_ts must be absent (undefined) — not 'T_mgr'
    expect(posted[0]!.thread_ts).toBeUndefined();
    expect(posted[0]!.text).toBe('Weekly NVIDIA digest');
  });

  it('explicit threadTs → posts in that thread', async () => {
    const posted: Array<{ channel: string; thread_ts?: string; text: string }> =
      [];
    const f = createTeamFixture('n4-explicit-ts');
    fixtures.push(f);

    const poller = makePoller(f, ['n4-explicit-ts'], posted);
    pollers.push(poller);
    await poller.drainOnce();

    f.appendOutbound({
      id: 'out-progress',
      timestamp: new Date().toISOString(),
      type: 'slack_message',
      channelId: 'C123',
      threadTs: 'T_task',
      text: 'Build progress update',
    });
    await poller.stop();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.channel).toBe('C123');
    expect(posted[0]!.thread_ts).toBe('T_task');
  });

  it('missing channelId → falls back to mailbox channelId; threadTs is trusted', async () => {
    const posted: Array<{ channel: string; thread_ts?: string; text: string }> =
      [];
    const f = createTeamFixture('n4-no-channel');
    fixtures.push(f);

    f.appendMailbox({
      id: 'mb-1',
      timestamp: new Date().toISOString(),
      from: 'dispatcher',
      type: 'user_message',
      threadTs: 'T_mailbox',
      channelId: 'C_fallback',
      userSlackId: 'U_BOB',
      userToken: 'tok-bob',
      message: 'hi',
    });

    const poller = makePoller(f, ['n4-no-channel'], posted);
    pollers.push(poller);
    await poller.drainOnce();

    f.appendOutbound({
      id: 'out-no-ch',
      timestamp: new Date().toISOString(),
      type: 'slack_message',
      channelId: '',
      threadTs: 'T_x',
      text: 'message with no channel',
    });
    await poller.stop();

    expect(posted).toHaveLength(1);
    // channelId recovered from mailbox
    expect(posted[0]!.channel).toBe('C_fallback');
    // threadTs trusted as written — NOT overridden with 'T_mailbox'
    expect(posted[0]!.thread_ts).toBe('T_x');
  });

  it('empty channelId AND empty threadTs with no mailbox fallback → skipped, no Slack call', async () => {
    const posted: Array<{ channel: string; thread_ts?: string; text: string }> =
      [];
    const f = createTeamFixture('n4-no-fallback');
    fixtures.push(f);

    // No mailbox.ndjson written at all
    const poller = makePoller(f, ['n4-no-fallback'], posted);
    pollers.push(poller);
    await poller.drainOnce();

    f.appendOutbound({
      id: 'out-orphan',
      timestamp: new Date().toISOString(),
      type: 'slack_message',
      channelId: '',
      threadTs: '',
      text: 'orphan message',
    });
    await poller.stop();

    // No channel to post to → skipped
    expect(posted).toHaveLength(0);
  });
});
