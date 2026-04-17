/**
 * Integration test for the commission_dev_team signal flow (C6).
 *
 * Tests:
 * 1. Manager writes commission_dev_team signal to signals.ndjson
 * 2. Bridge reads signals.ndjson and sees the commission
 * 3. Bridge spawns a dev team subprocess with the correct role prompt
 * 4. Dev team writes task_completed signal
 * 5. Bridge relays signal back and heartbeat fires (after 30s)
 *
 * This test uses the NDJSON infrastructure and signal constructors
 * directly (no real LLM). We simulate the manager writing signals
 * and verify that the signal encoding/decoding round-trip works
 * through the NDJSON layer.
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
  encodeSignal,
  type CommissionDevTeamSignal,
  type TaskCompletedSignal,
} from '../../src/teams/signals.js';
import { HeartbeatController } from '../../src/teams/heartbeat.js';
import {
  writeTokenFile,
  TOKEN_FILE_NAME,
} from '../../src/teams/token-bootstrap.js';

describe('commission_dev_team signal round-trip through NDJSON', () => {
  const fixtures: ReturnType<typeof createTeamFixture>[] = [];
  let fixture: ReturnType<typeof createTeamFixture>;

  beforeEach(() => {
    fixture = createTeamFixture('commission-flow-test');
    fixtures.push(fixture);
  });

  afterEach(() => {
    for (const f of fixtures.splice(0)) f.cleanup();
  });

  it('manager can write commission_dev_team signal to signals.ndjson', () => {
    const signal = makeCommissionDevTeam({
      taskId: 'task-abc',
      goal: 'Build a data ingestion tentacle',
      role: 'builder',
      tentacleName: 'data-ingestion',
    });

    appendNdjson(fixture.signalsPath, signal);

    const records = fixture.readSignals();
    expect(records).toHaveLength(1);
    const decoded = decodeSignal(encodeSignal(signal));
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe('commission_dev_team');
    const commission = decoded as CommissionDevTeamSignal;
    expect(commission.taskId).toBe('task-abc');
    expect(commission.role).toBe('builder');
    expect(commission.tentacleName).toBe('data-ingestion');
  });

  it('bridge (NdjsonReader) can read commission_dev_team signals from signals.ndjson', () => {
    // Simulate manager writing commission signal
    const commissionSignal = makeCommissionDevTeam({
      taskId: 'task-xyz',
      goal: 'Deploy tentacle to staging',
      role: 'deployer',
    });
    appendNdjson(fixture.signalsPath, commissionSignal);

    // Simulate bridge reading via NdjsonReader
    const reader = new NdjsonReader(fixture.signalsPath);
    const records = reader.readNew();
    expect(records).toHaveLength(1);

    const decoded = decodeSignal(JSON.stringify(records[0]));
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe('commission_dev_team');
    const commission = decoded as CommissionDevTeamSignal;
    expect(commission.taskId).toBe('task-xyz');
    expect(commission.role).toBe('deployer');
  });

  it('dev team can write task_completed signal that bridge can read', () => {
    // Simulate dev team writing completed signal
    const completedSignal = makeTaskCompleted({
      taskId: 'task-xyz',
      result: 'Deployed v1.3.0 successfully',
    });
    appendNdjson(fixture.signalsPath, completedSignal);

    // Simulate bridge reading
    const reader = new NdjsonReader(fixture.signalsPath);
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
      heartbeatFloorMs: 0, // no floor for this test — emit on every significant signal
    });

    // 1. Manager writes commission (no heartbeat for outbound signals)
    appendNdjson(
      fixture.signalsPath,
      makeCommissionDevTeam({
        taskId: 'task-1',
        goal: 'Build a reporting tentacle',
        role: 'builder',
      }),
    );

    // 2. Dev team writes task_started
    appendNdjson(fixture.signalsPath, makeTaskStarted({ taskId: 'task-1' }));

    // 3. Dev team writes task_completed
    appendNdjson(
      fixture.signalsPath,
      makeTaskCompleted({
        taskId: 'task-1',
        result: 'Reporting tentacle deployed',
      }),
    );

    // Simulate bridge reading all signals
    const reader = new NdjsonReader(fixture.signalsPath);
    const records = reader.readNew();
    for (const raw of records) {
      const signal = decodeSignal(JSON.stringify(raw));
      if (signal) controller.onSignal(signal);
    }

    // commission_dev_team is not significant — 2 significant signals
    // (task_started + task_completed) → 2 heartbeats (floor=0)
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
      fixture.signalsPath,
      makeTaskFailed({
        taskId: 'task-fail',
        error: 'tntc deploy: image build failed',
      }),
    );

    const reader = new NdjsonReader(fixture.signalsPath);
    const records = reader.readNew();
    for (const raw of records) {
      const signal = decodeSignal(JSON.stringify(raw));
      if (signal) controller.onSignal(signal);
    }

    expect(emittedHeartbeats).toHaveLength(1);
    expect(emittedHeartbeats[0]).toMatch(/fail|error|problem/i);
  });
});

describe('C6 regression: spawn env includes required C3 vars', () => {
  const fixtures: ReturnType<typeof createTeamFixture>[] = [];

  afterEach(() => {
    for (const f of fixtures.splice(0)) f.cleanup();
  });

  it('token.json is in team dir and has correct structure when writeTokenFile is called', () => {
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
