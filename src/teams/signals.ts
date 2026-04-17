/**
 * Dev team commissioning protocol — C2.
 *
 * Defines the SignalRecord discriminated union for NDJSON-based communication
 * between the bridge, the enclave manager, and dev team subprocesses.
 *
 * Signal directions:
 *   Manager → Bridge (written by manager, read by bridge):
 *     - commission_dev_team  — ask the bridge to spawn a dev team
 *     - terminate_dev_team   — ask the bridge to stop a running dev team
 *
 *   Dev Team → Manager (written by dev team, relayed by bridge to manager):
 *     - task_started         — dev team has picked up the task
 *     - progress_update      — incremental progress from the dev team
 *     - task_completed       — task finished successfully
 *     - task_failed          — task failed with error
 *
 * All signals are serialized as single-line JSON (NDJSON) via encodeSignal /
 * decodeSignal. Use the typed make* constructors to build records.
 */

/** Valid signal types (discriminant). */
export type SignalType =
  | 'commission_dev_team'
  | 'terminate_dev_team'
  | 'task_started'
  | 'progress_update'
  | 'task_completed'
  | 'task_failed';

const VALID_SIGNAL_TYPES = new Set<string>([
  'commission_dev_team',
  'terminate_dev_team',
  'task_started',
  'progress_update',
  'task_completed',
  'task_failed',
]);

/** Base fields present in every signal record. */
interface SignalBase {
  type: SignalType;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

/** Manager → Bridge: spawn a dev team for the given task. */
export interface CommissionDevTeamSignal extends SignalBase {
  type: 'commission_dev_team';
  taskId: string;
  /** Human-readable description of what the dev team should accomplish. */
  goal: string;
  /** Which role the dev team subprocess will take. */
  role: 'builder' | 'deployer';
  /** Optional: the tentacle name the task relates to (for workspace scoping). */
  tentacleName?: string;
}

/** Manager → Bridge: stop a running dev team. */
export interface TerminateDevTeamSignal extends SignalBase {
  type: 'terminate_dev_team';
  taskId: string;
}

/** Dev Team → Manager: the dev team has started the task. */
export interface TaskStartedSignal extends SignalBase {
  type: 'task_started';
  taskId: string;
}

/** Dev Team → Manager: incremental progress report. */
export interface ProgressUpdateSignal extends SignalBase {
  type: 'progress_update';
  taskId: string;
  message: string;
  /** Optional: file paths or artifact identifiers produced so far. */
  artifacts?: string[];
}

/** Dev Team → Manager: task finished successfully. */
export interface TaskCompletedSignal extends SignalBase {
  type: 'task_completed';
  taskId: string;
  result: string;
}

/** Dev Team → Manager: task failed. */
export interface TaskFailedSignal extends SignalBase {
  type: 'task_failed';
  taskId: string;
  error: string;
}

/** Discriminated union of all signal records. */
export type SignalRecord =
  | CommissionDevTeamSignal
  | TerminateDevTeamSignal
  | TaskStartedSignal
  | ProgressUpdateSignal
  | TaskCompletedSignal
  | TaskFailedSignal;

// ---------------------------------------------------------------------------
// Typed constructors
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

/** Build a commission_dev_team signal. */
export function makeCommissionDevTeam(
  params: Omit<CommissionDevTeamSignal, 'type' | 'timestamp'>,
): CommissionDevTeamSignal {
  return { type: 'commission_dev_team', timestamp: now(), ...params };
}

/** Build a terminate_dev_team signal. */
export function makeTerminateDevTeam(
  params: Omit<TerminateDevTeamSignal, 'type' | 'timestamp'>,
): TerminateDevTeamSignal {
  return { type: 'terminate_dev_team', timestamp: now(), ...params };
}

/** Build a task_started signal. */
export function makeTaskStarted(
  params: Omit<TaskStartedSignal, 'type' | 'timestamp'>,
): TaskStartedSignal {
  return { type: 'task_started', timestamp: now(), ...params };
}

/** Build a progress_update signal. */
export function makeProgressUpdate(
  params: Omit<ProgressUpdateSignal, 'type' | 'timestamp'>,
): ProgressUpdateSignal {
  return { type: 'progress_update', timestamp: now(), ...params };
}

/** Build a task_completed signal. */
export function makeTaskCompleted(
  params: Omit<TaskCompletedSignal, 'type' | 'timestamp'>,
): TaskCompletedSignal {
  return { type: 'task_completed', timestamp: now(), ...params };
}

/** Build a task_failed signal. */
export function makeTaskFailed(
  params: Omit<TaskFailedSignal, 'type' | 'timestamp'>,
): TaskFailedSignal {
  return { type: 'task_failed', timestamp: now(), ...params };
}

// ---------------------------------------------------------------------------
// Encoding / decoding
// ---------------------------------------------------------------------------

/**
 * Encode a signal record as a single-line JSON string (no trailing newline).
 * Callers that append to NDJSON files should add '\n' themselves.
 */
export function encodeSignal(signal: SignalRecord): string {
  return JSON.stringify(signal);
}

/**
 * Decode a single NDJSON line into a typed SignalRecord.
 *
 * Returns null if the line is not valid JSON, has no `type` field, or the
 * `type` is not a known signal type. Invalid records are silently dropped
 * (the caller should log if needed).
 */
export function decodeSignal(line: string): SignalRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['type'] !== 'string') return null;
  if (!VALID_SIGNAL_TYPES.has(obj['type'])) return null;
  return raw as SignalRecord;
}
