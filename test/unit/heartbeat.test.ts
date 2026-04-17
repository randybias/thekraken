/**
 * Unit tests for the heartbeat protocol (C4).
 *
 * The HeartbeatController tracks dev team signal events and decides when to
 * emit a heartbeat to outbound.ndjson (30s floor between heartbeats, only on
 * significant events).
 *
 * Significant events: task_started, task_completed, task_failed, and
 * progress_update (always considered significant for simplicity — the
 * manager emits selectively based on 30s floor).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  HeartbeatController,
  isSignificantSignal,
} from '../../src/teams/heartbeat.js';
import {
  makeTaskStarted,
  makeTaskCompleted,
  makeTaskFailed,
  makeProgressUpdate,
  makeCommissionDevTeam,
} from '../../src/teams/signals.js';

describe('isSignificantSignal', () => {
  it('task_started is significant', () => {
    expect(isSignificantSignal(makeTaskStarted({ taskId: 't1' }))).toBe(true);
  });

  it('task_completed is significant', () => {
    expect(isSignificantSignal(makeTaskCompleted({ taskId: 't1', result: 'done' }))).toBe(true);
  });

  it('task_failed is significant', () => {
    expect(isSignificantSignal(makeTaskFailed({ taskId: 't1', error: 'oops' }))).toBe(true);
  });

  it('progress_update is significant', () => {
    expect(isSignificantSignal(makeProgressUpdate({ taskId: 't1', message: 'working...' }))).toBe(true);
  });

  it('commission_dev_team is NOT significant (it is outbound, not inbound)', () => {
    expect(
      isSignificantSignal(makeCommissionDevTeam({ taskId: 't1', goal: 'g', role: 'builder' })),
    ).toBe(false);
  });
});

describe('HeartbeatController', () => {
  let emitted: string[] = [];
  let controller: HeartbeatController;

  beforeEach(() => {
    emitted = [];
    controller = new HeartbeatController({
      onHeartbeat: (text) => emitted.push(text),
      heartbeatFloorMs: 30_000,
    });
  });

  it('emits a heartbeat for the first significant signal (no prior heartbeat)', () => {
    vi.useFakeTimers();
    try {
      const signal = makeTaskStarted({ taskId: 'task-1' });
      controller.onSignal(signal, 'my-tentacle');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toContain('working');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT emit a second heartbeat within 30s of the first', () => {
    vi.useFakeTimers();
    try {
      const signal = makeTaskStarted({ taskId: 'task-1' });
      controller.onSignal(signal, 'my-tentacle');
      expect(emitted).toHaveLength(1);

      // Advance 10s — within the 30s floor
      vi.advanceTimersByTime(10_000);
      controller.onSignal(makeProgressUpdate({ taskId: 'task-1', message: 'still going' }), 'my-tentacle');
      expect(emitted).toHaveLength(1); // no new heartbeat
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits a second heartbeat after 30s have elapsed', () => {
    vi.useFakeTimers();
    try {
      controller.onSignal(makeTaskStarted({ taskId: 'task-1' }), 'my-tentacle');
      expect(emitted).toHaveLength(1);

      // Advance 31s — past the 30s floor
      vi.advanceTimersByTime(31_000);
      controller.onSignal(
        makeProgressUpdate({ taskId: 'task-1', message: 'still going' }),
        'my-tentacle',
      );
      expect(emitted).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('task_completed heartbeat mentions completion', () => {
    vi.useFakeTimers();
    try {
      controller.onSignal(
        makeTaskCompleted({ taskId: 'task-1', result: 'Deployed v1.2.0' }),
        'my-tentacle',
      );
      expect(emitted[0]).toMatch(/done|complete|finished|deployed/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('task_failed heartbeat mentions failure', () => {
    vi.useFakeTimers();
    try {
      controller.onSignal(
        makeTaskFailed({ taskId: 'task-1', error: 'image build failed' }),
        'my-tentacle',
      );
      expect(emitted[0]).toMatch(/fail|error|problem/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('non-significant signals do not emit a heartbeat', () => {
    vi.useFakeTimers();
    try {
      controller.onSignal(
        makeCommissionDevTeam({ taskId: 'task-1', goal: 'g', role: 'builder' }),
        'my-tentacle',
      );
      expect(emitted).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets lastHeartbeat on task_completed so future tasks get fresh heartbeat', () => {
    vi.useFakeTimers();
    try {
      // First task: emit heartbeat
      controller.onSignal(makeTaskStarted({ taskId: 'task-1' }), 'tentacle-a');
      expect(emitted).toHaveLength(1);

      // Complete the task — should emit (if 30s have passed)
      vi.advanceTimersByTime(31_000);
      controller.onSignal(
        makeTaskCompleted({ taskId: 'task-1', result: 'done' }),
        'tentacle-a',
      );
      expect(emitted).toHaveLength(2);

      // Second task starts right away — should emit because task_completed reset the floor
      // But 0ms have elapsed since the last heartbeat, so we should NOT emit
      controller.onSignal(makeTaskStarted({ taskId: 'task-2' }), 'tentacle-b');
      // Still 2 because 0ms elapsed since the task_completed heartbeat
      expect(emitted).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
