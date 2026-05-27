/**
 * N2: Per-task thread routing tests.
 *
 * Verifies that the heartbeat written to outbound.ndjson by the bridge
 * carries the threadTs from the originating commission_dev_team signal,
 * NOT the threadTs of the most-recently-active mailbox entry.
 *
 * The production failure: a dev team task (NVIDIA report) completed in
 * thread A, but its task_completed heartbeat appeared in thread B (the
 * membership-add thread) because the outbound poller fell back to the
 * last mailbox entry's threadTs.
 *
 * Fix: commission_dev_team signal carries threadTs; bridge stores it in
 * DevTeamHandle; pollSignalsIn() passes it to HeartbeatController.onSignal()
 * which forwards it to onHeartbeat(text, threadTs); writeHeartbeat() puts
 * it in the outbound record.
 */

import { describe, it, expect } from 'vitest';
import { HeartbeatController } from '../../../src/teams/heartbeat.js';
import {
  makeTaskStarted,
  makeProgressUpdate,
  makeTaskCompleted,
  makeTaskFailed,
} from '../../../src/teams/signals.js';

// ---------------------------------------------------------------------------
// HeartbeatController — threadTs pass-through
// ---------------------------------------------------------------------------

describe('HeartbeatController — N2 threadTs pass-through', () => {
  it('passes threadTs to onHeartbeat for task_started', () => {
    const received: Array<{ text: string; threadTs: string }> = [];
    const ctrl = new HeartbeatController({
      onHeartbeat: (text, threadTs) => received.push({ text, threadTs }),
      heartbeatFloorMs: 0, // no floor for tests
    });

    const signal = makeTaskStarted({ taskId: 'task-1' });
    ctrl.onSignal(signal, undefined, '1234567890.123456');

    expect(received).toHaveLength(1);
    expect(received[0]!.threadTs).toBe('1234567890.123456');
  });

  it('passes threadTs to onHeartbeat for progress_update', () => {
    const received: Array<{ text: string; threadTs: string }> = [];
    const ctrl = new HeartbeatController({
      onHeartbeat: (text, threadTs) => received.push({ text, threadTs }),
      heartbeatFloorMs: 0,
    });

    const signal = makeProgressUpdate({
      taskId: 'task-2',
      message: 'Scaffolded the tentacle',
    });
    ctrl.onSignal(signal, 'my-tentacle', '9999999999.000001');

    expect(received).toHaveLength(1);
    expect(received[0]!.threadTs).toBe('9999999999.000001');
  });

  it('passes threadTs to onHeartbeat for task_completed', () => {
    const received: Array<{ text: string; threadTs: string }> = [];
    const ctrl = new HeartbeatController({
      onHeartbeat: (text, threadTs) => received.push({ text, threadTs }),
      heartbeatFloorMs: 0,
    });

    const signal = makeTaskCompleted({
      taskId: 'task-3',
      result: 'Done! Deployed successfully.',
    });
    ctrl.onSignal(signal, undefined, '1111111111.000000');

    expect(received).toHaveLength(1);
    expect(received[0]!.threadTs).toBe('1111111111.000000');
  });

  it('passes threadTs to onHeartbeat for task_failed', () => {
    const received: Array<{ text: string; threadTs: string }> = [];
    const ctrl = new HeartbeatController({
      onHeartbeat: (text, threadTs) => received.push({ text, threadTs }),
      heartbeatFloorMs: 0,
    });

    const signal = makeTaskFailed({
      taskId: 'task-4',
      error: 'tntc deploy returned exit code 1',
    });
    ctrl.onSignal(signal, undefined, '2222222222.000000');

    expect(received).toHaveLength(1);
    expect(received[0]!.threadTs).toBe('2222222222.000000');
  });

  it('defaults threadTs to empty string when not provided', () => {
    const received: Array<{ text: string; threadTs: string }> = [];
    const ctrl = new HeartbeatController({
      onHeartbeat: (text, threadTs) => received.push({ text, threadTs }),
      heartbeatFloorMs: 0,
    });

    const signal = makeTaskCompleted({
      taskId: 'task-5',
      result: 'Done.',
    });
    // No threadTs argument — should default to ''
    ctrl.onSignal(signal);

    expect(received).toHaveLength(1);
    expect(received[0]!.threadTs).toBe('');
  });

  it('respects heartbeatFloorMs for non-terminal signals', () => {
    const received: Array<{ text: string; threadTs: string }> = [];
    const ctrl = new HeartbeatController({
      onHeartbeat: (text, threadTs) => received.push({ text, threadTs }),
      heartbeatFloorMs: 60_000, // 60s floor
    });

    // First progress_update should go through
    ctrl.onSignal(
      makeProgressUpdate({ taskId: 't', message: 'A' }),
      undefined,
      'ts-1',
    );
    expect(received).toHaveLength(1);

    // Second progress_update within floor — suppressed
    ctrl.onSignal(
      makeProgressUpdate({ taskId: 't', message: 'B' }),
      undefined,
      'ts-2',
    );
    expect(received).toHaveLength(1);

    // task_completed (terminal) — always goes through despite floor
    ctrl.onSignal(
      makeTaskCompleted({ taskId: 't', result: 'Done.' }),
      undefined,
      'ts-3',
    );
    expect(received).toHaveLength(2);
    expect(received[1]!.threadTs).toBe('ts-3');
  });

  it('two concurrent tasks each carry their own threadTs', () => {
    const received: Array<{ text: string; threadTs: string }> = [];
    const ctrl = new HeartbeatController({
      onHeartbeat: (text, threadTs) => received.push({ text, threadTs }),
      heartbeatFloorMs: 0,
    });

    // Task A is a build started from thread-a
    ctrl.onSignal(
      makeTaskStarted({ taskId: 'task-a' }),
      'build-tentacle',
      'thread-a-ts',
    );
    // Task B is a report builder from thread-b (different thread, different topic)
    ctrl.onSignal(
      makeTaskCompleted({ taskId: 'task-b', result: 'Report ready.' }),
      'nvidia-report',
      'thread-b-ts',
    );

    // task-a started in thread-a
    expect(received[0]!.threadTs).toBe('thread-a-ts');
    // task-b completed in thread-b (NOT thread-a!)
    expect(received[1]!.threadTs).toBe('thread-b-ts');
  });
});

// ---------------------------------------------------------------------------
// CommissionDevTeamSignal — threadTs field
// ---------------------------------------------------------------------------

import {
  makeCommissionDevTeam,
  decodeOutboundSignal,
  encodeSignal,
} from '../../../src/teams/signals.js';

describe('CommissionDevTeamSignal — threadTs field (N2)', () => {
  it('includes threadTs when provided', () => {
    const sig = makeCommissionDevTeam({
      taskId: 'tid-1',
      goal: 'Build a report tentacle',
      role: 'builder',
      threadTs: '1234567890.000001',
    });

    expect(sig.threadTs).toBe('1234567890.000001');
  });

  it('threadTs is optional — signal valid without it', () => {
    const sig = makeCommissionDevTeam({
      taskId: 'tid-2',
      goal: 'Build a report tentacle',
      role: 'builder',
    });

    expect(sig.threadTs).toBeUndefined();
  });

  it('round-trips through encode/decode', () => {
    const sig = makeCommissionDevTeam({
      taskId: 'tid-3',
      goal: 'Build a report tentacle',
      role: 'builder',
      threadTs: '9876543210.123456',
    });

    const line = encodeSignal(sig);
    const decoded = decodeOutboundSignal(line);

    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe('commission_dev_team');
    // TypeScript needs narrowing here
    if (decoded!.type === 'commission_dev_team') {
      expect(decoded!.threadTs).toBe('9876543210.123456');
    }
  });

  it('decode succeeds when threadTs is missing (backward compat)', () => {
    // Simulate a legacy commission signal written before this fix
    const raw = JSON.stringify({
      type: 'commission_dev_team',
      timestamp: '2026-05-27T00:00:00.000Z',
      taskId: 'tid-legacy',
      goal: 'Old task without threadTs',
      role: 'builder',
    });

    const decoded = decodeOutboundSignal(raw);
    expect(decoded).not.toBeNull();
    // threadTs field absent — should be undefined (not a decode error)
    if (decoded?.type === 'commission_dev_team') {
      expect(decoded.threadTs).toBeUndefined();
    }
  });
});
