/**
 * Unit tests for the NDJSON signal round-trip (C6).
 *
 * Tests that signal constructors, encoding/decoding, and NDJSON I/O work
 * correctly end-to-end through the filesystem layer. No LLM, no real pi
 * subprocess — pure unit coverage of the signal protocol infrastructure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTeamFixture } from '../helpers/team-fixture.js';
import { appendNdjson, NdjsonReader } from '../../src/teams/ndjson.js';
import {
  makeCommissionDevTeam,
  makeTaskStarted,
  makeTaskCompleted,
  makeTaskFailed,
  decodeSignal,
  decodeOutboundSignal,
  decodeInboundSignal,
  encodeSignal,
  type CommissionDevTeamSignal,
  type TaskCompletedSignal,
} from '../../src/teams/signals.js';
import { HeartbeatController } from '../../src/teams/heartbeat.js';
import {
  writeTokenFile,
  TOKEN_FILE_NAME,
} from '../../src/teams/token-bootstrap.js';

describe('signal round-trip through NDJSON', () => {
  const fixtures: ReturnType<typeof createTeamFixture>[] = [];
  let fixture: ReturnType<typeof createTeamFixture>;

  beforeEach(() => {
    fixture = createTeamFixture('signals-rt-test');
    fixtures.push(fixture);
  });

  afterEach(() => {
    for (const f of fixtures.splice(0)) f.cleanup();
  });

  it('manager writes commission_dev_team to signals-out.ndjson', () => {
    const signal = makeCommissionDevTeam({
      taskId: 'task-abc',
      goal: 'Build a data ingestion tentacle',
      role: 'builder',
      tentacleName: 'data-ingestion',
    });

    appendNdjson(fixture.signalsOutPath, signal);

    const records = fixture.readSignalsOut();
    expect(records).toHaveLength(1);
    const decoded = decodeSignal(encodeSignal(signal));
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe('commission_dev_team');
    const commission = decoded as CommissionDevTeamSignal;
    expect(commission.taskId).toBe('task-abc');
    expect(commission.role).toBe('builder');
    expect(commission.tentacleName).toBe('data-ingestion');
  });

  it('NdjsonReader reads commission_dev_team from signals-out.ndjson', () => {
    const commissionSignal = makeCommissionDevTeam({
      taskId: 'task-xyz',
      goal: 'Deploy tentacle to staging',
      role: 'deployer',
    });
    appendNdjson(fixture.signalsOutPath, commissionSignal);

    const reader = new NdjsonReader(fixture.signalsOutPath);
    const records = reader.readNew();
    expect(records).toHaveLength(1);

    const decoded = decodeSignal(JSON.stringify(records[0]));
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe('commission_dev_team');
    const commission = decoded as CommissionDevTeamSignal;
    expect(commission.taskId).toBe('task-xyz');
    expect(commission.role).toBe('deployer');
  });

  it('dev team writes task_completed to signals-in.ndjson', () => {
    const completedSignal = makeTaskCompleted({
      taskId: 'task-xyz',
      result: 'Deployed v1.3.0 successfully',
    });
    appendNdjson(fixture.signalsInPath, completedSignal);

    const reader = new NdjsonReader(fixture.signalsInPath);
    const records = reader.readNew();
    expect(records).toHaveLength(1);

    const decoded = decodeSignal(JSON.stringify(records[0]));
    expect(decoded!.type).toBe('task_completed');
    const completed = decoded as TaskCompletedSignal;
    expect(completed.result).toBe('Deployed v1.3.0 successfully');
  });

  it('full flow: commission → task_started → task_completed → heartbeat emitted', () => {
    const emittedHeartbeats: string[] = [];
    const controller = new HeartbeatController({
      onHeartbeat: (text) => emittedHeartbeats.push(text),
      heartbeatFloorMs: 0, // no floor — emit on every significant signal
    });

    // 1. Manager writes commission to signals-out (no heartbeat for outbound signals)
    appendNdjson(
      fixture.signalsOutPath,
      makeCommissionDevTeam({
        taskId: 'task-1',
        goal: 'Build a reporting tentacle',
        role: 'builder',
      }),
    );

    // 2. Dev team writes task_started to signals-in
    appendNdjson(fixture.signalsInPath, makeTaskStarted({ taskId: 'task-1' }));

    // 3. Dev team writes task_completed to signals-in
    appendNdjson(
      fixture.signalsInPath,
      makeTaskCompleted({
        taskId: 'task-1',
        result: 'Reporting tentacle deployed',
      }),
    );

    // Simulate bridge reading signals-in
    const reader = new NdjsonReader(fixture.signalsInPath);
    const records = reader.readNew();
    for (const raw of records) {
      const signal = decodeSignal(JSON.stringify(raw));
      if (signal) controller.onSignal(signal);
    }

    // task_started + task_completed = 2 significant signals → 2 heartbeats (floor=0)
    expect(emittedHeartbeats).toHaveLength(2);
    expect(emittedHeartbeats[1]).toMatch(/done|complete|deployed/i);
  });

  it('task_failed signal results in a failure heartbeat', () => {
    const emittedHeartbeats: string[] = [];
    const controller = new HeartbeatController({
      onHeartbeat: (text) => emittedHeartbeats.push(text),
      heartbeatFloorMs: 0,
    });

    appendNdjson(
      fixture.signalsInPath,
      makeTaskFailed({
        taskId: 'task-fail',
        error: 'tntc deploy: image build failed',
      }),
    );

    const reader = new NdjsonReader(fixture.signalsInPath);
    const records = reader.readNew();
    for (const raw of records) {
      const signal = decodeSignal(JSON.stringify(raw));
      if (signal) controller.onSignal(signal);
    }

    expect(emittedHeartbeats).toHaveLength(1);
    expect(emittedHeartbeats[0]).toMatch(/fail|error|problem/i);
  });
});

describe('direction-aware decode rejects mismatched signals (Must-fix #3)', () => {
  it('decodeOutboundSignal accepts commission_dev_team', () => {
    const sig = makeCommissionDevTeam({
      taskId: 't',
      goal: 'g',
      role: 'builder',
    });
    expect(decodeOutboundSignal(encodeSignal(sig))).not.toBeNull();
  });

  it('decodeOutboundSignal accepts terminate_dev_team', () => {
    const sig = {
      type: 'terminate_dev_team',
      taskId: 't',
      timestamp: new Date().toISOString(),
    };
    expect(decodeOutboundSignal(JSON.stringify(sig))).not.toBeNull();
  });

  it('decodeOutboundSignal rejects inbound signal types written to wrong file', () => {
    const sig = makeTaskStarted({ taskId: 't' });
    expect(decodeOutboundSignal(encodeSignal(sig))).toBeNull();
  });

  it('decodeOutboundSignal rejects task_completed (inbound direction)', () => {
    const sig = makeTaskCompleted({ taskId: 't', result: 'r' });
    expect(decodeOutboundSignal(encodeSignal(sig))).toBeNull();
  });

  it('decodeInboundSignal accepts task_started', () => {
    const sig = makeTaskStarted({ taskId: 't' });
    expect(decodeInboundSignal(encodeSignal(sig))).not.toBeNull();
  });

  it('decodeInboundSignal accepts task_completed', () => {
    const sig = makeTaskCompleted({ taskId: 't', result: 'r' });
    expect(decodeInboundSignal(encodeSignal(sig))).not.toBeNull();
  });

  it('decodeInboundSignal accepts task_failed', () => {
    const sig = makeTaskFailed({ taskId: 't', error: 'e' });
    expect(decodeInboundSignal(encodeSignal(sig))).not.toBeNull();
  });

  it('decodeInboundSignal rejects commission_dev_team (outbound direction)', () => {
    const sig = makeCommissionDevTeam({
      taskId: 't',
      goal: 'g',
      role: 'builder',
    });
    expect(decodeInboundSignal(encodeSignal(sig))).toBeNull();
  });

  it('decodeInboundSignal rejects terminate_dev_team (outbound direction)', () => {
    const sig = {
      type: 'terminate_dev_team',
      taskId: 't',
      timestamp: new Date().toISOString(),
    };
    expect(decodeInboundSignal(JSON.stringify(sig))).toBeNull();
  });
});

describe('C6 regression: spawn env and token.json bootstrap', () => {
  const fixtures: ReturnType<typeof createTeamFixture>[] = [];

  afterEach(() => {
    for (const f of fixtures.splice(0)) f.cleanup();
  });

  it('token.json is written to team dir with correct structure', () => {
    const fixture = createTeamFixture('c6-env-test');
    fixtures.push(fixture);

    const tokenPath = writeTokenFile(fixture.dir, 'test-access-token', 3600);

    expect(existsSync(tokenPath)).toBe(true);
    expect(tokenPath).toBe(join(fixture.dir, TOKEN_FILE_NAME));

    const parsed = JSON.parse(readFileSync(tokenPath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(parsed['access_token']).toBe('test-access-token');
    expect(typeof parsed['expires_at']).toBe('number');
    expect(typeof parsed['updated_at']).toBe('string');
  });
});
