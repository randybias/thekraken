/**
 * Cross-restart cursor verification for OutboundPoller (rc.13).
 *
 * Codex rescue finding #2: the rc.12 fix for outbound replay
 * (startAtEnd: true) introduced a different bug — records appended
 * to outbound.ndjson while the pod was down were silently dropped.
 * rc.13 replaces startAtEnd with a SQLite-backed cursor; this test
 * proves the cursor wiring works.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OutboundPoller } from '../../src/teams/outbound-poller.js';
import { OutboundTracker } from '../../src/slack/outbound.js';
import { createDatabase } from '../../src/db/migrations.js';
import { initCursorStore, getCursor } from '../../src/db/cursors.js';
import type { KrakenConfig } from '../../src/config.js';

function makeConfig(teamsDir: string): KrakenConfig {
  return {
    teamsDir,
    gitState: {
      repoUrl: 'x',
      branch: 'main',
      dir: join(teamsDir, '..', 'git-state'),
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

function appendOutbound(path: string, record: object): void {
  appendFileSync(path, JSON.stringify(record) + '\n');
}

describe('OutboundPoller cross-restart cursor (rc.13)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'poller-restart-'));
    // Initialize the shared cursor store with a fresh in-memory DB.
    // Both "pod" pollers in each test share this store, simulating
    // a PVC-backed SQLite DB that survives pod restarts.
    initCursorStore(createDatabase(':memory:'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('records appended while pod was down are picked up on next pod boot', async () => {
    const enclave = 'e1';
    const teamsDir = join(tmp, 'teams');
    const teamDir = join(teamsDir, enclave);
    mkdirSync(teamDir, { recursive: true });
    const outboundPath = join(teamDir, 'outbound.ndjson');

    // Simulate first boot: post one record, run poll, save cursor.
    appendOutbound(outboundPath, {
      id: 'r1',
      timestamp: '2026-05-07T00:00:00Z',
      type: 'slack_message',
      channelId: 'C1',
      threadTs: '1.0',
      text: 'boot-one record',
    });

    const db = createDatabase(':memory:');
    const tracker = new OutboundTracker(db);
    const posted: Array<{ text: string }> = [];
    const slack = {
      postMessage: vi.fn(async (params: { text: string }) => {
        posted.push(params);
        return { ts: `t-${posted.length}` };
      }),
    };

    const poller1 = new OutboundPoller({
      config: makeConfig(teamsDir),
      teams: { isTeamActive: () => true },
      slack,
      tracker,
      getActiveTeams: () => [enclave],
    });
    await poller1.stop(); // single drain
    expect(posted.map((m) => m.text)).toEqual(['boot-one record']);

    // Cursor should have advanced past r1.
    const cursor1 = getCursor(enclave, 'outbound.ndjson');
    expect(cursor1).toBeGreaterThan(0);

    // Simulate first boot going down. Records get appended to the PVC file
    // while the process is offline.
    appendOutbound(outboundPath, {
      id: 'r2',
      timestamp: '2026-05-07T00:00:01Z',
      type: 'slack_message',
      channelId: 'C1',
      threadTs: '1.0',
      text: 'queued while offline',
    });

    // Second boot. The cursor store retains cursor1 (shared in-memory DB
    // simulates PVC-backed SQLite). The new poller resumes from cursor1
    // and picks up r2.
    const poller2 = new OutboundPoller({
      config: makeConfig(teamsDir),
      teams: { isTeamActive: () => true },
      slack,
      tracker,
      getActiveTeams: () => [enclave],
    });
    await poller2.stop();
    expect(posted.map((m) => m.text)).toEqual([
      'boot-one record',
      'queued while offline',
    ]);
  });

  it('records present at first-ever boot (no prior cursor) are picked up from offset 0', async () => {
    // With persistent cursors, no-prior-cursor means offset 0.
    // Records in the file at boot time get processed — they may have been
    // written by a prior process that never had a chance to drain them.
    const enclave = 'fresh';
    const teamsDir = join(tmp, 'teams');
    const teamDir = join(teamsDir, enclave);
    mkdirSync(teamDir, { recursive: true });
    const outboundPath = join(teamDir, 'outbound.ndjson');

    // No prior cursor for this enclave. The outbound.ndjson has a record
    // that was never processed (written before the cursor existed).
    appendOutbound(outboundPath, {
      id: 'r1',
      timestamp: '2026-05-07T00:00:00Z',
      type: 'slack_message',
      channelId: 'C1',
      threadTs: '1.0',
      text: 'unread at fresh boot',
    });

    const db = createDatabase(':memory:');
    const tracker = new OutboundTracker(db);
    const posted: Array<{ text: string }> = [];
    const slack = {
      postMessage: vi.fn(async (params: { text: string }) => {
        posted.push(params);
        return { ts: `t-${posted.length}` };
      }),
    };

    const poller = new OutboundPoller({
      config: makeConfig(teamsDir),
      teams: { isTeamActive: () => true },
      slack,
      tracker,
      getActiveTeams: () => [enclave],
    });
    await poller.stop();

    // With persistent cursors starting at 0, the record gets processed.
    expect(posted.map((m) => m.text)).toEqual(['unread at fresh boot']);
  });
});
