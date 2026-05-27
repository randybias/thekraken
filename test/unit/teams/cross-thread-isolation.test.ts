/**
 * F16: Cross-thread isolation — two concurrent tasks must not cross-post.
 *
 * Validates the d049df9 (N2) routing fix at the HeartbeatController level.
 * Two concurrent commission_dev_team tasks with different threadTs values
 * interleave progress + task_completed signals; every record must post to
 * its originating thread and zero cross-contamination must occur in the
 * Slack postMessage ledger.
 *
 * Origin: production transcript 2026-05-27 where an unrelated dev team's
 * 'Done! PARTIAL: OpenAI gpt-4o integration complete...' message landed in
 * the membership-add thread because progress signals didn't carry their
 * originating threadTs.
 *
 * The existing thread-routing.test.ts covers single-signal pass-through per
 * signal type and a two-signal spot-check. These tests add:
 *   - Interleaved signal sequences (A, B, A, B, A → 5 records, verified all)
 *   - Task-B-after-A ordering (B commission after A has already emitted)
 *   - HeartbeatController-level backward compat (onSignal with no threadTs
 *     in a two-task mixed scenario)
 *   - Full mock-Slack ledger walk asserting zero cross-contamination
 */

import { describe, it, expect } from 'vitest';
import { HeartbeatController } from '../../../src/teams/heartbeat.js';
import {
  makeTaskStarted,
  makeProgressUpdate,
  makeTaskCompleted,
} from '../../../src/teams/signals.js';

// ---------------------------------------------------------------------------
// Mock-Slack ledger
// ---------------------------------------------------------------------------

/**
 * A record of a single postMessage call in the mock Slack client.
 * Mirrors (channel, threadTs, text) — the three fields the outbound-poller
 * passes when posting a heartbeat to Slack.
 */
interface PostRecord {
  channel: string;
  threadTs: string;
  text: string;
  /** Which task's HeartbeatController emitted this record (test metadata). */
  taskLabel: string;
}

/** Constructs a mock postMessage function that records every call. */
function makeMockSlack(
  channel: string,
  taskLabel: string,
  ledger: PostRecord[],
): (text: string, threadTs: string) => void {
  return (text, threadTs) => {
    ledger.push({ channel, threadTs, text, taskLabel });
  };
}

// ---------------------------------------------------------------------------
// Test 1: Two concurrent tasks, independent threadTs, interleaved signals
// ---------------------------------------------------------------------------

describe('F16 — cross-thread isolation: interleaved concurrent tasks', () => {
  it('routes all records from task A to T_A and all from task B to T_B', () => {
    const ledger: PostRecord[] = [];

    // Each task gets its own HeartbeatController (one per DevTeamHandle).
    // This mirrors the real architecture: bridge spawns one controller per
    // commission_dev_team, not one shared controller for all tasks.
    const ctrlA = new HeartbeatController({
      onHeartbeat: makeMockSlack('C_ENCLAVE', 'task-A', ledger),
      heartbeatFloorMs: 0,
    });
    const ctrlB = new HeartbeatController({
      onHeartbeat: makeMockSlack('C_ENCLAVE', 'task-B', ledger),
      heartbeatFloorMs: 0,
    });

    const T_A = '1716800000.000001';
    const T_B = '1716800000.000002';

    // Interleaved sequence matching the production failure pattern:
    //   A starts → B starts → A makes progress → B completes → A completes
    ctrlA.onSignal(makeTaskStarted({ taskId: 'task-A' }), 'nvidia-report', T_A);
    ctrlB.onSignal(makeTaskStarted({ taskId: 'task-B' }), 'add-member', T_B);
    ctrlA.onSignal(
      makeProgressUpdate({ taskId: 'task-A', message: 'Scaffolded the tentacle' }),
      'nvidia-report',
      T_A,
    );
    ctrlB.onSignal(
      makeTaskCompleted({ taskId: 'task-B', result: 'Done! PARTIAL: OpenAI gpt-4o integration complete.' }),
      'add-member',
      T_B,
    );
    ctrlA.onSignal(
      makeTaskCompleted({ taskId: 'task-A', result: 'NVIDIA report tentacle deployed.' }),
      'nvidia-report',
      T_A,
    );

    // 5 signals total, all significant, floor=0 → 5 records
    expect(ledger).toHaveLength(5);

    // --- Per-task assertions ---
    const fromA = ledger.filter((r) => r.taskLabel === 'task-A');
    const fromB = ledger.filter((r) => r.taskLabel === 'task-B');

    expect(fromA).toHaveLength(3);
    expect(fromB).toHaveLength(2);

    // Every record from task A must target T_A
    for (const record of fromA) {
      expect(record.threadTs).toBe(T_A);
    }
    // Every record from task B must target T_B
    for (const record of fromB) {
      expect(record.threadTs).toBe(T_B);
    }

    // --- Cross-contamination check: no A record at T_B, no B record at T_A ---
    const atT_A = ledger.filter((r) => r.threadTs === T_A);
    const atT_B = ledger.filter((r) => r.threadTs === T_B);

    expect(atT_A.every((r) => r.taskLabel === 'task-A')).toBe(true);
    expect(atT_B.every((r) => r.taskLabel === 'task-B')).toBe(true);

    // The production failure: task-B's 'Done! PARTIAL:' message must NOT appear at T_A
    const crossBleeded = atT_A.some((r) => r.text.includes('PARTIAL'));
    expect(crossBleeded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Task B commissioned AFTER task A has already emitted
// ---------------------------------------------------------------------------

describe('F16 — cross-thread isolation: late-commissioned task B', () => {
  it('routes B.progress to T_B even though A has already been posting', () => {
    const ledger: PostRecord[] = [];

    const ctrlA = new HeartbeatController({
      onHeartbeat: makeMockSlack('C_ENCLAVE', 'task-A', ledger),
      heartbeatFloorMs: 0,
    });
    const ctrlB = new HeartbeatController({
      onHeartbeat: makeMockSlack('C_ENCLAVE', 'task-B', ledger),
      heartbeatFloorMs: 0,
    });

    const T_A = '1716900000.000001';
    const T_B = '1716900000.000099'; // B comes later in wall-clock time

    // A emits two records before B is even commissioned
    ctrlA.onSignal(makeTaskStarted({ taskId: 'task-A' }), 'report', T_A);
    ctrlA.onSignal(
      makeProgressUpdate({ taskId: 'task-A', message: 'fetching data' }),
      'report',
      T_A,
    );

    // B is now commissioned and emits its first record
    ctrlB.onSignal(
      makeProgressUpdate({ taskId: 'task-B', message: 'scaffolding workspace' }),
      'new-feature',
      T_B,
    );

    // 3 records total
    expect(ledger).toHaveLength(3);

    // B's record must land at T_B, not at T_A
    const bRecord = ledger.find((r) => r.taskLabel === 'task-B');
    expect(bRecord).toBeDefined();
    expect(bRecord!.threadTs).toBe(T_B);
    expect(bRecord!.threadTs).not.toBe(T_A);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Backward compat — commission without threadTs in mixed scenario
// ---------------------------------------------------------------------------

describe('F16 — cross-thread isolation: backward compat (missing threadTs)', () => {
  it('legacy task without threadTs falls back to empty string and does not crash', () => {
    const ledger: PostRecord[] = [];

    const ctrlLegacy = new HeartbeatController({
      onHeartbeat: makeMockSlack('C_ENCLAVE', 'task-legacy', ledger),
      heartbeatFloorMs: 0,
    });
    const ctrlNormal = new HeartbeatController({
      onHeartbeat: makeMockSlack('C_ENCLAVE', 'task-normal', ledger),
      heartbeatFloorMs: 0,
    });

    const T_NORMAL = '1717000000.000001';

    // Legacy task: no threadTs argument (mirrors old bridge code before N2 fix)
    ctrlLegacy.onSignal(
      makeProgressUpdate({ taskId: 'task-legacy', message: 'working' }),
    );

    // Normal task: carries threadTs
    ctrlNormal.onSignal(
      makeTaskCompleted({ taskId: 'task-normal', result: 'Done.' }),
      undefined,
      T_NORMAL,
    );

    expect(ledger).toHaveLength(2);

    const legacyRecord = ledger.find((r) => r.taskLabel === 'task-legacy');
    const normalRecord = ledger.find((r) => r.taskLabel === 'task-normal');

    expect(legacyRecord).toBeDefined();
    // Falls back to empty string — does NOT crash, does NOT borrow T_NORMAL
    expect(legacyRecord!.threadTs).toBe('');
    expect(legacyRecord!.threadTs).not.toBe(T_NORMAL);

    expect(normalRecord).toBeDefined();
    // Normal task's threadTs is unaffected by legacy task's absence
    expect(normalRecord!.threadTs).toBe(T_NORMAL);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Full mock-Slack ledger verification — high-volume interleaving
// ---------------------------------------------------------------------------

describe('F16 — cross-thread isolation: ledger walk across many records', () => {
  it('zero cross-contamination across 12 interleaved signals from 3 concurrent tasks', () => {
    const ledger: PostRecord[] = [];

    const T_X = '1718000000.000001';
    const T_Y = '1718000000.000002';
    const T_Z = '1718000000.000003';

    const ctrlX = new HeartbeatController({
      onHeartbeat: makeMockSlack('C_ENC', 'task-X', ledger),
      heartbeatFloorMs: 0,
    });
    const ctrlY = new HeartbeatController({
      onHeartbeat: makeMockSlack('C_ENC', 'task-Y', ledger),
      heartbeatFloorMs: 0,
    });
    const ctrlZ = new HeartbeatController({
      onHeartbeat: makeMockSlack('C_ENC', 'task-Z', ledger),
      heartbeatFloorMs: 0,
    });

    // 12-signal interleaved sequence across 3 tasks
    ctrlX.onSignal(makeTaskStarted({ taskId: 'X' }), 'tentacle-x', T_X);
    ctrlY.onSignal(makeTaskStarted({ taskId: 'Y' }), 'tentacle-y', T_Y);
    ctrlX.onSignal(makeProgressUpdate({ taskId: 'X', message: 'X step 1' }), 'tentacle-x', T_X);
    ctrlZ.onSignal(makeTaskStarted({ taskId: 'Z' }), 'tentacle-z', T_Z);
    ctrlY.onSignal(makeProgressUpdate({ taskId: 'Y', message: 'Y step 1' }), 'tentacle-y', T_Y);
    ctrlX.onSignal(makeProgressUpdate({ taskId: 'X', message: 'X step 2' }), 'tentacle-x', T_X);
    ctrlZ.onSignal(makeProgressUpdate({ taskId: 'Z', message: 'Z step 1' }), 'tentacle-z', T_Z);
    ctrlY.onSignal(makeProgressUpdate({ taskId: 'Y', message: 'Y step 2' }), 'tentacle-y', T_Y);
    ctrlZ.onSignal(makeTaskCompleted({ taskId: 'Z', result: 'Z done.' }), 'tentacle-z', T_Z);
    ctrlX.onSignal(makeProgressUpdate({ taskId: 'X', message: 'X step 3' }), 'tentacle-x', T_X);
    ctrlY.onSignal(makeTaskCompleted({ taskId: 'Y', result: 'Y done.' }), 'tentacle-y', T_Y);
    ctrlX.onSignal(makeTaskCompleted({ taskId: 'X', result: 'X done.' }), 'tentacle-x', T_X);

    expect(ledger).toHaveLength(12);

    // Walk every entry in the ledger and assert threadTs matches the emitting task
    const taskToThread: Record<string, string> = {
      'task-X': T_X,
      'task-Y': T_Y,
      'task-Z': T_Z,
    };

    for (const record of ledger) {
      const expectedThreadTs = taskToThread[record.taskLabel];
      expect(expectedThreadTs).toBeDefined(); // guard: every record has a known task label
      expect(record.threadTs).toBe(expectedThreadTs);
    }

    // Explicit cross-contamination assertions per thread
    const atT_X = ledger.filter((r) => r.threadTs === T_X);
    const atT_Y = ledger.filter((r) => r.threadTs === T_Y);
    const atT_Z = ledger.filter((r) => r.threadTs === T_Z);

    // Each thread should have exactly the records from its task
    expect(atT_X).toHaveLength(5); // started + 3 progress + completed
    expect(atT_Y).toHaveLength(4); // started + 2 progress + completed
    expect(atT_Z).toHaveLength(3); // started + 1 progress + completed

    // No record from another task bleeds into each thread
    expect(atT_X.every((r) => r.taskLabel === 'task-X')).toBe(true);
    expect(atT_Y.every((r) => r.taskLabel === 'task-Y')).toBe(true);
    expect(atT_Z.every((r) => r.taskLabel === 'task-Z')).toBe(true);

    // Text correlation: each record's text must contain task-relevant content
    // (not just land at the right thread but carry the right message)
    for (const record of atT_Z.filter((r) => r.text.includes('Done'))) {
      expect(record.text).toContain('Z done.');
    }
    for (const record of atT_Y.filter((r) => r.text.includes('Done'))) {
      expect(record.text).toContain('Y done.');
    }
    for (const record of atT_X.filter((r) => r.text.includes('Done'))) {
      expect(record.text).toContain('X done.');
    }
  });
});
