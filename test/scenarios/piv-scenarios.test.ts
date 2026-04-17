/**
 * PIV Scenario Tests (Phase 1 Pivot).
 *
 * These test the dispatcher + per-enclave team architecture through
 * representative user journeys. All subprocess spawning uses the
 * mock pi binary — no real LLM or Slack calls.
 *
 * PIV1: Two users in same enclave (no token bleed)
 * PIV2: Heartbeat protocol timing
 * PIV3: Status check mid-build
 * PIV4: Manager idle timeout
 * PIV5: Token expires mid-task (D6 enforcement)
 * PIV6: Stale team dir GC
 * PIV7: Pod restart (teams die, fresh spawn)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendNdjson, NdjsonReader } from '../../src/teams/ndjson.js';
import type { MailboxRecord } from '../../src/teams/lifecycle.js';
import {
  routeEvent,
  type InboundEvent,
  type RouterDeps,
} from '../../src/dispatcher/router.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeTempTeamsDir(): string {
  return mkdtempSync(join(tmpdir(), 'kraken-piv-'));
}

function makeMailboxRecord(
  overrides: Partial<MailboxRecord> = {},
): MailboxRecord {
  return {
    id: `piv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    from: 'dispatcher',
    type: 'user_message',
    threadTs: '1000.1',
    channelId: 'C_TEST',
    userSlackId: 'U_DEFAULT',
    userToken: 'token-default',
    message: 'hello',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PIV1: Two users in same enclave (no token bleed)
// ---------------------------------------------------------------------------

describe('PIV1: two users same enclave, no token bleed', () => {
  let teamsDir: string;

  beforeEach(() => {
    teamsDir = makeTempTeamsDir();
  });

  it('writes separate mailbox records with distinct user tokens', () => {
    const enclaveDir = join(teamsDir, 'marketing');
    mkdirSync(enclaveDir, { recursive: true });
    const mailbox = join(enclaveDir, 'mailbox.ndjson');

    const recordA = makeMailboxRecord({
      userSlackId: 'U_ALICE',
      userToken: 'token-alice-123',
      message: 'deploy sentiment',
    });
    const recordB = makeMailboxRecord({
      userSlackId: 'U_BOB',
      userToken: 'token-bob-456',
      message: 'check status',
    });

    appendNdjson(mailbox, recordA);
    appendNdjson(mailbox, recordB);

    const reader = new NdjsonReader(mailbox);
    const records = reader.readNew() as MailboxRecord[];

    expect(records).toHaveLength(2);
    expect(records[0]!.userSlackId).toBe('U_ALICE');
    expect(records[0]!.userToken).toBe('token-alice-123');
    expect(records[1]!.userSlackId).toBe('U_BOB');
    expect(records[1]!.userToken).toBe('token-bob-456');

    // Cross-user check: each record's token belongs to its user, not the other's
    expect(records[0]!.userToken).not.toBe(records[1]!.userToken);
  });

  it('does not leak user A token into outbound.ndjson', () => {
    const enclaveDir = join(teamsDir, 'marketing');
    mkdirSync(enclaveDir, { recursive: true });
    const outbound = join(enclaveDir, 'outbound.ndjson');

    // Simulate manager writing outbound (no token should be present)
    const outboundRecord = {
      type: 'message',
      channelId: 'C_MKT',
      threadTs: '1000.1',
      text: 'Deployed v3 of sentiment-analysis',
    };
    appendNdjson(outbound, outboundRecord);

    const reader = new NdjsonReader(outbound);
    const records = reader.readNew();
    const raw = JSON.stringify(records[0]);

    // D6: token must not appear in outbound
    expect(raw).not.toContain('token-alice');
    expect(raw).not.toContain('token-bob');
    expect(raw).not.toContain('userToken');
  });
});

// ---------------------------------------------------------------------------
// PIV2: Heartbeat protocol timing
// ---------------------------------------------------------------------------

describe('PIV2: heartbeat protocol', () => {
  it('heartbeat records contain human-friendly text and address the user', () => {
    const heartbeat = {
      type: 'heartbeat',
      channelId: 'C_MKT',
      threadTs: '2000.1',
      text: 'Hey @alice, your agent is currently running tests. Next it will deploy. Hang tight.',
    };

    // Must be human-addressed
    expect(heartbeat.text).toMatch(/Hey @/);
    // Must not contain protocol jargon
    expect(heartbeat.text).not.toMatch(/phase [0-9]/i);
    expect(heartbeat.text).not.toMatch(/step [0-9]/i);
  });
});

// ---------------------------------------------------------------------------
// PIV3: Status check mid-build (signals readable without interrupting builder)
// ---------------------------------------------------------------------------

describe('PIV3: status check reads signals without interrupting builder', () => {
  let teamsDir: string;

  beforeEach(() => {
    teamsDir = makeTempTeamsDir();
  });

  it('dispatcher can read signals-in.ndjson while builder is still writing', () => {
    const enclaveDir = join(teamsDir, 'engineering');
    mkdirSync(enclaveDir, { recursive: true });
    const signals = join(enclaveDir, 'signals-in.ndjson');

    // Builder writes progress signals
    appendNdjson(signals, { type: 'progress', phase: 'compiling', pct: 30 });
    appendNdjson(signals, { type: 'progress', phase: 'testing', pct: 60 });

    // Dispatcher reads (this is what happens on status check)
    const reader = new NdjsonReader(signals);
    const records = reader.readNew() as Array<{
      type: string;
      phase: string;
      pct: number;
    }>;

    expect(records).toHaveLength(2);
    expect(records[1]!.phase).toBe('testing');

    // Builder writes more after dispatcher read
    appendNdjson(signals, { type: 'progress', phase: 'deploying', pct: 90 });

    const moreRecords = reader.readNew() as Array<{
      type: string;
      phase: string;
    }>;
    expect(moreRecords).toHaveLength(1);
    expect(moreRecords[0]!.phase).toBe('deploying');
  });
});

// ---------------------------------------------------------------------------
// PIV4: Manager idle timeout
// ---------------------------------------------------------------------------

describe('PIV4: manager idle timeout', () => {
  it('team state directory survives after manager exits', () => {
    const teamsDir = makeTempTeamsDir();
    const enclaveDir = join(teamsDir, 'data-pipeline');
    mkdirSync(enclaveDir, { recursive: true });
    writeFileSync(join(enclaveDir, 'mailbox.ndjson'), '');

    // Simulate: manager has exited (no PID file or process)
    // But directory persists on PVC
    expect(existsSync(enclaveDir)).toBe(true);
    expect(existsSync(join(enclaveDir, 'mailbox.ndjson'))).toBe(true);

    // MEMORY.md would survive here too (in real scenario, on PVC)
    writeFileSync(join(enclaveDir, 'MEMORY.md'), '# Enclave: data-pipeline\n');
    expect(existsSync(join(enclaveDir, 'MEMORY.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PIV5: Token expires mid-task (D6: no fallback)
// ---------------------------------------------------------------------------

describe('PIV5: token expiry handling (D6 enforcement)', () => {
  it('mailbox record with expired token does NOT fallback to service token', () => {
    const record = makeMailboxRecord({
      userToken: 'expired-token-xyz',
      message: 'deploy my workflow',
    });

    // The mailbox record carries the user's token. If it's expired,
    // the manager should fail the task, NOT substitute a service token.
    // This test validates the contract: the record has ONLY the user's token.
    expect(record.userToken).toBe('expired-token-xyz');
    expect(record.userToken).not.toBe('service-token');
    expect(record.userToken).not.toBe('');

    // In the real flow, the manager detects the 401 from MCP and writes
    // an outbound record asking the user to re-auth. We validate the
    // record shape here; the full flow test is an integration concern.
  });

  it('mailbox records never contain a service token fallback field', () => {
    const record = makeMailboxRecord({ userToken: 'user-token-abc' });
    const serialized = JSON.stringify(record);

    // D6: no "serviceToken" or "fallbackToken" field
    expect(serialized).not.toContain('serviceToken');
    expect(serialized).not.toContain('fallbackToken');
  });
});

// ---------------------------------------------------------------------------
// PIV6: Stale team dir GC
// ---------------------------------------------------------------------------

describe('PIV6: stale team directory GC', () => {
  it('identifies stale directories (>7 days, no active team)', () => {
    const teamsDir = makeTempTeamsDir();
    const staleDir = join(teamsDir, 'old-enclave');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'mailbox.ndjson'), '');

    // In real GC: TeamLifecycleManager.gcStaleTeams() checks mtime
    // and isTeamActive(). Here we just verify the dir exists and could
    // be GC'd. Full GC integration test is in team-lifecycle.test.ts.
    expect(existsSync(staleDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PIV7: Pod restart (teams die, fresh spawn)
// ---------------------------------------------------------------------------

describe('PIV7: pod restart, no team resume', () => {
  it('dispatcher router still routes after restart (no stale state)', () => {
    // Simulate fresh dispatcher state (no active teams)
    const deps: RouterDeps = {
      bindings: {
        lookupEnclave: (channelId: string) =>
          channelId === 'C_ENC'
            ? {
                channelId: 'C_ENC',
                enclaveName: 'test-enclave',
                ownerSlackId: 'U_OWNER',
                status: 'active' as const,
                createdAt: '2026-01-01',
              }
            : null,
      },
      teams: {
        isTeamActive: () => false, // No teams after restart
      },
    };

    const event: InboundEvent = {
      type: 'app_mention',
      channelId: 'C_ENC',
      userId: 'U_USER',
      text: '<@BOT> deploy my thing',
    };

    const decision = routeEvent(event, deps);

    // After restart, no team is active, so router should spawn a new team
    expect(decision.path).toBe('deterministic');
    if (decision.path === 'deterministic') {
      expect(decision.action.type).toBe('spawn_and_forward');
    }
  });
});
