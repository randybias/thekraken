/**
 * Heartbeat protocol — C4.
 *
 * The HeartbeatController decides when to emit a heartbeat message to the
 * outbound channel. Heartbeats come from the bridge (acting on behalf of the
 * manager — the bridge sees dev team signals and can emit to outbound.ndjson
 * on the manager's behalf while the manager is running inside a pi subprocess
 * we don't control directly).
 *
 * Rules (D5):
 * - 30-second floor between heartbeats
 * - Only emit for significant events (task_started, progress_update,
 *   task_completed, task_failed)
 * - Heartbeat text is friendly, human-addressed, concise
 * - Heartbeats come from the manager's voice (Slack user reads them as
 *   manager speech, not dev team speech)
 *
 * The controller is stateful: it tracks the last heartbeat timestamp and
 * emits via an onHeartbeat callback injected at construction time.
 */

import type { SignalRecord } from './signals.js';

/** Signal types that trigger a potential heartbeat emission. */
const SIGNIFICANT_TYPES = new Set([
  'task_started',
  'progress_update',
  'task_completed',
  'task_failed',
]);

/**
 * Returns true if the signal is significant enough to trigger a heartbeat check.
 *
 * commission_dev_team and terminate_dev_team are outbound manager→bridge
 * signals, not dev team progress signals — they do not trigger heartbeats.
 */
export function isSignificantSignal(signal: SignalRecord): boolean {
  return SIGNIFICANT_TYPES.has(signal.type);
}

/** Options for constructing a HeartbeatController. */
export interface HeartbeatControllerOptions {
  /**
   * Called when a heartbeat should be emitted. The text is a short,
   * friendly, human-addressed message in the manager's voice.
   */
  onHeartbeat: (text: string) => void;
  /**
   * Minimum milliseconds between consecutive heartbeats. Default: 30_000 (30s).
   * Overrideable for tests.
   */
  heartbeatFloorMs?: number;
}

/**
 * Controls heartbeat emission for a team's active dev team tasks.
 *
 * Call onSignal() whenever a signal is received from the dev team.
 * The controller will call onHeartbeat() when a significant signal
 * occurs AND enough time has passed since the last heartbeat.
 */
export class HeartbeatController {
  private lastHeartbeatAt = 0;
  private readonly floorMs: number;
  private readonly onHeartbeat: (text: string) => void;

  constructor(opts: HeartbeatControllerOptions) {
    this.floorMs = opts.heartbeatFloorMs ?? 30_000;
    this.onHeartbeat = opts.onHeartbeat;
  }

  /**
   * Process an incoming signal from the dev team.
   *
   * If the signal is significant and at least floorMs have elapsed since the
   * last heartbeat, emits a heartbeat via onHeartbeat.
   *
   * @param signal - The signal from the dev team.
   * @param tentacleName - The tentacle name the task relates to (for context in the message).
   */
  onSignal(signal: SignalRecord, tentacleName?: string): void {
    if (!isSignificantSignal(signal)) return;

    const now = Date.now();
    const elapsed = now - this.lastHeartbeatAt;
    if (elapsed < this.floorMs) return;

    const text = this.buildHeartbeatText(signal, tentacleName);
    this.lastHeartbeatAt = now;
    this.onHeartbeat(text);
  }

  /**
   * Construct the heartbeat message text.
   *
   * Matches the voice of the manager: first person, friendly, concise.
   * No jargon, no technical details the user didn't ask for.
   */
  private buildHeartbeatText(
    signal: SignalRecord,
    tentacleName?: string,
  ): string {
    const context = tentacleName ? ` on ${tentacleName}` : '';
    switch (signal.type) {
      case 'task_started':
        return `Still working${context} — just getting started, I'll keep you posted.`;
      case 'progress_update': {
        const msg = signal.message;
        if (msg && msg.length > 0 && msg.length < 120) {
          return `Still working${context}: ${msg}`;
        }
        return `Still working${context} — making progress, hang tight.`;
      }
      case 'task_completed':
        return `Done${context}! ${signal.result ?? 'Task completed successfully.'}`;
      case 'task_failed':
        return `Ran into a problem${context}: ${signal.error ?? 'Something went wrong. Let me know if you want to try again.'}`;
      default:
        return `Working on it${context}...`;
    }
  }
}
