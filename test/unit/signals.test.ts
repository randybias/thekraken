/**
 * Unit tests for src/teams/signals.ts — C2 dev team commissioning protocol.
 *
 * Tests the SignalRecord discriminated union encoding/decoding and the
 * type-safe signal construction helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeSignal,
  decodeSignal,
  makeCommissionDevTeam,
  makeTerminateDevTeam,
  makeTaskStarted,
  makeProgressUpdate,
  makeTaskCompleted,
  makeTaskFailed,
  type SignalRecord,
  type CommissionDevTeamSignal,
  type TerminateDevTeamSignal,
  type TaskStartedSignal,
  type ProgressUpdateSignal,
  type TaskCompletedSignal,
  type TaskFailedSignal,
} from '../../src/teams/signals.js';

describe('signal encoding/decoding (round-trip)', () => {
  it('encodes and decodes commission_dev_team signal', () => {
    const sig = makeCommissionDevTeam({
      taskId: 'task-1',
      goal: 'Build a sentiment analysis tentacle',
      role: 'builder',
      tentacleName: 'sentiment-analyser',
    });

    const encoded = encodeSignal(sig);
    expect(typeof encoded).toBe('string');
    expect(encoded).not.toContain('\n'); // single line

    const decoded = decodeSignal(encoded);
    expect(decoded).toBeDefined();
    expect(decoded!.type).toBe('commission_dev_team');
    const commission = decoded as CommissionDevTeamSignal;
    expect(commission.taskId).toBe('task-1');
    expect(commission.goal).toBe('Build a sentiment analysis tentacle');
    expect(commission.role).toBe('builder');
    expect(commission.tentacleName).toBe('sentiment-analyser');
  });

  it('encodes and decodes commission_dev_team without optional tentacleName', () => {
    const sig = makeCommissionDevTeam({
      taskId: 'task-2',
      goal: 'Deploy latest changes',
      role: 'deployer',
    });

    const decoded = decodeSignal(encodeSignal(sig));
    expect(decoded!.type).toBe('commission_dev_team');
    const commission = decoded as CommissionDevTeamSignal;
    expect(commission.tentacleName).toBeUndefined();
    expect(commission.role).toBe('deployer');
  });

  it('encodes and decodes terminate_dev_team signal', () => {
    const sig = makeTerminateDevTeam({ taskId: 'task-3' });
    const decoded = decodeSignal(encodeSignal(sig));
    expect(decoded!.type).toBe('terminate_dev_team');
    const term = decoded as TerminateDevTeamSignal;
    expect(term.taskId).toBe('task-3');
  });

  it('encodes and decodes task_started signal', () => {
    const sig = makeTaskStarted({ taskId: 'task-4' });
    const decoded = decodeSignal(encodeSignal(sig));
    expect(decoded!.type).toBe('task_started');
    const started = decoded as TaskStartedSignal;
    expect(started.taskId).toBe('task-4');
  });

  it('encodes and decodes progress_update signal', () => {
    const sig = makeProgressUpdate({
      taskId: 'task-5',
      message: 'Running tntc scaffold search...',
      artifacts: ['src/workflow.yaml'],
    });
    const decoded = decodeSignal(encodeSignal(sig));
    expect(decoded!.type).toBe('progress_update');
    const progress = decoded as ProgressUpdateSignal;
    expect(progress.message).toBe('Running tntc scaffold search...');
    expect(progress.artifacts).toEqual(['src/workflow.yaml']);
  });

  it('encodes and decodes progress_update without optional artifacts', () => {
    const sig = makeProgressUpdate({
      taskId: 'task-5b',
      message: 'Still working...',
    });
    const decoded = decodeSignal(encodeSignal(sig));
    const progress = decoded as ProgressUpdateSignal;
    expect(progress.artifacts).toBeUndefined();
  });

  it('encodes and decodes task_completed signal', () => {
    const sig = makeTaskCompleted({
      taskId: 'task-6',
      result: 'Tentacle deployed successfully at v1.2.0',
    });
    const decoded = decodeSignal(encodeSignal(sig));
    expect(decoded!.type).toBe('task_completed');
    const completed = decoded as TaskCompletedSignal;
    expect(completed.taskId).toBe('task-6');
    expect(completed.result).toBe('Tentacle deployed successfully at v1.2.0');
  });

  it('encodes and decodes task_failed signal', () => {
    const sig = makeTaskFailed({
      taskId: 'task-7',
      error: 'tntc deploy failed: image build error',
    });
    const decoded = decodeSignal(encodeSignal(sig));
    expect(decoded!.type).toBe('task_failed');
    const failed = decoded as TaskFailedSignal;
    expect(failed.taskId).toBe('task-7');
    expect(failed.error).toBe('tntc deploy failed: image build error');
  });

  it('decodeSignal returns null for invalid JSON', () => {
    expect(decodeSignal('not-json')).toBeNull();
  });

  it('decodeSignal returns null for JSON without a type', () => {
    expect(decodeSignal(JSON.stringify({ taskId: 'x' }))).toBeNull();
  });

  it('decodeSignal returns null for JSON with unknown type', () => {
    expect(
      decodeSignal(JSON.stringify({ type: 'unknown_type', taskId: 'x' })),
    ).toBeNull();
  });

  it('all signals carry a timestamp', () => {
    const sig = makeTaskStarted({ taskId: 'ts-test' });
    const decoded = decodeSignal(encodeSignal(sig)) as SignalRecord;
    expect(decoded.timestamp).toBeDefined();
    // Should parse as valid ISO date
    expect(new Date(decoded.timestamp).getFullYear()).toBeGreaterThan(2024);
  });
});

describe('role field validation', () => {
  it('commission_dev_team accepts builder role', () => {
    const sig = makeCommissionDevTeam({
      taskId: 't',
      goal: 'g',
      role: 'builder',
    });
    expect(sig.role).toBe('builder');
  });

  it('commission_dev_team accepts deployer role', () => {
    const sig = makeCommissionDevTeam({
      taskId: 't',
      goal: 'g',
      role: 'deployer',
    });
    expect(sig.role).toBe('deployer');
  });
});
