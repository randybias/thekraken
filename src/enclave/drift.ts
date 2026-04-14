/**
 * Drift detection — periodic reconciliation between Slack channel membership
 * and enclave annotations (Phase 3).
 *
 * D6 Exception (documented): Drift detection is the ONE system-level
 * exception to the user identity hard partition. It runs on a timer with
 * no user initiating the action. It uses a narrow service token configured
 * via KRAKEN_DRIFT_SERVICE_TOKEN. This token is NOT propagated to teams
 * or user-facing operations.
 *
 * Safety constraints:
 *   - NEVER auto-adds members (Slack join != enclave membership)
 *   - NEVER removes the enclave owner
 *   - Skips frozen enclaves
 *   - Invalidates authz cache on corrections
 *   - Logs all discrepancies; never posts to Slack
 *
 * Round-robin: processes `maxChannelsPerCycle` enclaves per cycle,
 * advancing an offset so all enclaves are covered over multiple cycles.
 */

import { createChildLogger } from '../logger.js';
import { invalidateCache } from './authz.js';

const log = createChildLogger({ module: 'drift-detector' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DriftConfig {
  /** Interval between drift cycles in milliseconds. Default: 300_000 (5 min). */
  intervalMs: number;
  /** Maximum enclaves to check per cycle. Default: 5. */
  maxChannelsPerCycle: number;
  /** Service token for MCP calls (D6 exception). */
  serviceToken: string;
}

export type DriftMcpCallFn = (
  tool: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export interface DriftDeps {
  mcpCall: DriftMcpCallFn;
  /** Resolve Slack user ID to email. */
  resolveEmail: (slackId: string) => Promise<string | undefined>;
  /** List Slack channel members for a given channel ID. */
  listChannelMembers: (channelId: string) => Promise<string[]>;
}

interface EnclaveListItem {
  name: string;
  channel_id: string;
  status: string;
  owner: string;
  members: string[];
}

// ---------------------------------------------------------------------------
// DriftDetector class
// ---------------------------------------------------------------------------

export class DriftDetector {
  private timer: NodeJS.Timeout | undefined;
  private cycleOffset = 0;
  private running = false;

  constructor(
    private readonly config: DriftConfig,
    private readonly deps: DriftDeps,
  ) {}

  /** Start the drift detection loop. Warns if no service token. */
  start(): void {
    if (!this.config.serviceToken) {
      log.warn('KRAKEN_DRIFT_SERVICE_TOKEN not set — drift detection disabled');
      return;
    }
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(() => {
      void this.safeCycle();
    }, this.config.intervalMs);
    this.timer.unref?.();

    log.info(
      {
        intervalMs: this.config.intervalMs,
        maxChannelsPerCycle: this.config.maxChannelsPerCycle,
      },
      'drift detection started',
    );
  }

  /** Stop the drift detection loop. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    log.info('drift detection stopped');
  }

  /** Run a single drift detection cycle (public for testing). */
  async runCycle(): Promise<void> {
    let enclaves: EnclaveListItem[];
    try {
      const raw = await this.deps.mcpCall('enclave_list', {});
      enclaves =
        (raw as { enclaves?: EnclaveListItem[] })?.enclaves ??
        (raw as EnclaveListItem[]) ??
        [];
    } catch (err) {
      log.warn({ err }, 'drift: failed to list enclaves');
      return;
    }

    if (enclaves.length === 0) return;

    const total = enclaves.length;
    const batch = this.config.maxChannelsPerCycle;
    const start = this.cycleOffset % total;
    const slice = enclaves.slice(start, start + batch);
    // Wrap around if batch extends beyond the end
    const wrapped =
      start + batch > total
        ? [...slice, ...enclaves.slice(0, (start + batch) % total)]
        : slice;

    this.cycleOffset = (this.cycleOffset + batch) % total;

    for (const enclave of wrapped) {
      await this.checkEnclave(enclave);
    }
  }

  private async safeCycle(): Promise<void> {
    try {
      await this.runCycle();
    } catch (err) {
      log.error({ err }, 'drift: unhandled error in cycle');
    }
  }

  private async checkEnclave(enclave: EnclaveListItem): Promise<void> {
    const { name, channel_id, status, owner, members } = enclave;

    // Skip frozen enclaves
    if (status === 'frozen') {
      log.debug({ enclave: name }, 'drift: skipping frozen enclave');
      return;
    }

    if (!channel_id) {
      log.debug({ enclave: name }, 'drift: no channel_id, skipping');
      return;
    }

    // Get Slack channel members
    let slackMemberIds: string[];
    try {
      slackMemberIds = await this.deps.listChannelMembers(channel_id);
    } catch (err) {
      log.warn(
        { err, enclave: name, channel_id },
        'drift: failed to list channel members',
      );
      return;
    }

    // Resolve Slack IDs to emails (best-effort — unresolvable IDs are skipped)
    const slackEmails = new Set<string>();
    for (const slackId of slackMemberIds) {
      const email = await this.deps.resolveEmail(slackId);
      if (email) {
        slackEmails.add(email.toLowerCase());
      }
    }

    // Find stale members: in enclave annotation but not in Slack channel
    const stale: string[] = [];
    for (const memberEmail of members) {
      const normalizedMember = memberEmail.toLowerCase();
      // NEVER remove the owner
      if (normalizedMember === owner.toLowerCase()) continue;
      // If not in Slack channel, mark as stale
      if (!slackEmails.has(normalizedMember)) {
        stale.push(memberEmail);
      }
    }

    if (stale.length === 0) {
      log.debug({ enclave: name }, 'drift: no stale members');
      return;
    }

    log.info({ enclave: name, stale }, 'drift: removing stale members');

    try {
      await this.deps.mcpCall('enclave_sync', {
        name,
        remove_members: stale,
      });
      invalidateCache(name);
      log.info(
        { enclave: name, removed: stale.length },
        'drift: stale members removed',
      );
    } catch (err) {
      log.warn(
        { err, enclave: name, stale },
        'drift: failed to remove stale members',
      );
    }
  }
}
