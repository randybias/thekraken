/**
 * Manager subprocess context injection (2026-06-01 Chroma + identity bugfix).
 *
 * The dispatcher knows both config.chroma.baseUrl and the resolved Slack bot
 * user id, but neither reached the manager subprocess. These tests pin the
 * wiring: the lifecycle manager must surface both into the subprocess env AND
 * into the manager prompt built for the spawned bridge.
 *
 * Captured via a mock bridgeFactory so no real pi subprocess (or DB) is needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TeamLifecycleManager } from '../../../src/teams/lifecycle.js';
import type { TeamBridgeLike } from '../../../src/teams/lifecycle.js';
import type { TeamBridgeOptions } from '../../../src/teams/bridge.js';
import type { KrakenConfig } from '../../../src/config.js';

const noopBridge: TeamBridgeLike = {
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  isActive: () => true,
};

const fakeDb = {
  prepare: () => ({ run: () => {}, get: () => null, all: () => [] }),
} as unknown as import('better-sqlite3').Database;

function makeConfig(teamsDir: string, chromaBaseUrl: string): KrakenConfig {
  return {
    teamsDir,
    gitState: { dir: join(teamsDir, 'git'), repoUrl: 'https://example.com' },
    cluster: { name: 'test' },
    mcp: { url: 'http://localhost:9090' },
    llm: {
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
      allowedProviders: ['anthropic'],
    },
    slack: { botToken: 'xoxb-test', signingSecret: 'sig', mode: 'http' },
    oidc: { issuerUrl: '', clientId: '', clientSecret: '', callbackUrl: '' },
    chroma: { baseUrl: chromaBaseUrl },
    server: { port: 3000 },
    observability: { otlpEndpoint: undefined },
  } as unknown as KrakenConfig;
}

describe('manager subprocess context injection', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lifecycle-ctx-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function spawnAndCapture(
    chromaBaseUrl: string,
    botUserId?: string,
  ): Promise<TeamBridgeOptions> {
    const teamsDir = join(dir, 'teams');
    let captured: TeamBridgeOptions | undefined;
    const manager = new TeamLifecycleManager(
      makeConfig(teamsDir, chromaBaseUrl),
      fakeDb,
      {
        bridgeFactory: (opts) => {
          captured = opts;
          return noopBridge;
        },
      },
    );
    if (botUserId !== undefined) manager.setBotUserId(botUserId);
    await manager.spawnTeam('voyager', 'U1', 'tok');
    await manager.shutdownAll();
    if (!captured) throw new Error('bridgeFactory was not called');
    return captured;
  }

  it('injects KRAKEN_CHROMA_BASE_URL and KRAKEN_BOT_USER_ID into the subprocess env', async () => {
    const opts = await spawnAndCapture(
      'https://chroma.example.com',
      'U0BOTKRAKEN',
    );
    expect(opts.env['KRAKEN_CHROMA_BASE_URL']).toBe('https://chroma.example.com');
    expect(opts.env['KRAKEN_BOT_USER_ID']).toBe('U0BOTKRAKEN');
  });

  it('passes chromaBaseUrl and botUserId through to the manager prompt', async () => {
    const opts = await spawnAndCapture(
      'https://chroma.example.com',
      'U0BOTKRAKEN',
    );
    expect(opts.appendSystemPrompt).toContain(
      'https://chroma.example.com/enclaves/voyager',
    );
    expect(opts.appendSystemPrompt).toContain('<@U0BOTKRAKEN>');
  });

  it('omits the env vars when Chroma is unconfigured and no bot id is resolved', async () => {
    const opts = await spawnAndCapture('');
    expect(opts.env['KRAKEN_CHROMA_BASE_URL']).toBeUndefined();
    expect(opts.env['KRAKEN_BOT_USER_ID']).toBeUndefined();
    // Prompt still mentions Chroma, but as not-configured, with no fake URL.
    expect(opts.appendSystemPrompt).toMatch(/not configured/i);
    expect(opts.appendSystemPrompt).not.toContain('/enclaves/');
  });
});
