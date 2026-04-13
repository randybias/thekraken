/**
 * OutboundPoller — polls per-enclave team outbound.ndjson files and posts
 * messages to Slack (T11).
 *
 * Design:
 * - Polls all active team outbound.ndjson files every 1 second.
 * - Posts records to the correct Slack channel/thread.
 * - Deduplicates via OutboundTracker (SQLite) to survive pod restarts.
 * - Handles heartbeat records per Section 8 of the design doc (D5).
 * - Emits OTel spans per outbound post.
 * - Graceful shutdown: drains outstanding records on stop().
 *
 * Heartbeat format (D5): type='heartbeat', friendly human-addressed text.
 * The poller posts heartbeat records the same way as slack_message records.
 * Rate-limiting is the manager's responsibility (30s floor).
 */

import { join } from 'node:path';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { createChildLogger } from '../logger.js';
import { NdjsonReader } from './ndjson.js';
import { OutboundTracker } from '../slack/outbound.js';
import type { KrakenConfig } from '../config.js';
import type { TeamLifecycleManager } from './lifecycle.js';

const log = createChildLogger({ module: 'outbound-poller' });
const tracer = trace.getTracer('thekraken.outbound-poller');

/** Poll interval for checking outbound.ndjson files. */
const POLL_INTERVAL_MS = 1000;

/**
 * An outbound record written by the manager to outbound.ndjson.
 * The dispatcher reads this and posts to Slack.
 */
export interface OutboundRecord {
  id: string;
  timestamp: string;
  type: 'slack_message' | 'heartbeat' | 'error';
  channelId: string;
  threadTs: string;
  text: string;
  mentionUser?: string;
}

/** Minimal Slack client interface used by the poller. */
export interface SlackPostClient {
  postMessage: (params: {
    channel: string;
    thread_ts?: string;
    text: string;
  }) => Promise<{ ts?: string }>;
}

/** Poller dependencies. */
export interface OutboundPollerDeps {
  config: KrakenConfig;
  teams: Pick<TeamLifecycleManager, 'isTeamActive'>;
  slack: SlackPostClient;
  tracker: OutboundTracker;
  /** Active team names to poll. Callback called once per poll cycle. */
  getActiveTeams: () => string[];
}

/**
 * Polls outbound.ndjson files from all active teams and posts records to Slack.
 *
 * One NdjsonReader per enclave is maintained across poll cycles to track
 * byte offsets (only new records are processed on each cycle).
 */
export class OutboundPoller {
  private pollTimer: NodeJS.Timeout | undefined;
  private readers = new Map<string, NdjsonReader>();
  private running = false;

  constructor(private readonly deps: OutboundPollerDeps) {}

  /**
   * Start polling.
   *
   * Returns immediately; polling happens asynchronously on a 1s interval.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
    log.info({ intervalMs: POLL_INTERVAL_MS }, 'outbound poller started');
  }

  /**
   * Stop polling.
   *
   * Cancels the interval and performs a final drain to capture any records
   * written after the last poll cycle.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    // Final drain
    await this.poll();
    log.info('outbound poller stopped');
  }

  private async poll(): Promise<void> {
    const activeTeams = this.deps.getActiveTeams();

    for (const enclaveName of activeTeams) {
      await this.pollTeam(enclaveName);
    }

    // GC readers for teams that are no longer active
    for (const [name] of this.readers) {
      if (!activeTeams.includes(name)) {
        this.readers.delete(name);
      }
    }
  }

  private async pollTeam(enclaveName: string): Promise<void> {
    const outboundPath = join(
      this.deps.config.teamsDir,
      enclaveName,
      'outbound.ndjson',
    );

    // Get or create a reader for this team (persists offset across cycles)
    let reader = this.readers.get(enclaveName);
    if (!reader) {
      reader = new NdjsonReader(outboundPath);
      this.readers.set(enclaveName, reader);
    }

    const records = reader.readNew() as OutboundRecord[];
    for (const record of records) {
      await this.processRecord(enclaveName, record);
    }
  }

  private async processRecord(
    enclaveName: string,
    record: OutboundRecord,
  ): Promise<void> {
    await tracer.startActiveSpan('outbound.post', async (span) => {
      span.setAttribute('enclave.name', enclaveName);
      span.setAttribute('outbound.type', record.type);
      span.setAttribute('slack.channel_id', record.channelId);

      try {
        // Dedup check: skip if already posted (pod restart protection)
        if (
          this.deps.tracker.hasOutboundInThread(
            record.channelId,
            record.threadTs,
          )
        ) {
          // Record exists — but we may have more messages in this thread.
          // Use message ID for stronger dedup in Phase 2. For now, check
          // if the specific record text was already posted by hash.
          // Phase 1: simple dedup — skip if thread already has an outbound.
          // TODO Phase 2: per-message ID dedup.
          log.debug(
            { enclaveName, recordId: record.id },
            'skipping already-posted outbound record',
          );
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return;
        }

        // Format the message (heartbeats get mentionUser prefix if set)
        const text = record.mentionUser
          ? `<@${record.mentionUser}> ${record.text}`
          : record.text;

        // Post to Slack
        const result = await this.deps.slack.postMessage({
          channel: record.channelId,
          thread_ts: record.threadTs || undefined,
          text,
        });

        // Record in SQLite for dedup
        this.deps.tracker.store(
          record.channelId,
          record.threadTs,
          result.ts ?? '',
          text,
        );

        log.info(
          {
            enclaveName,
            recordId: record.id,
            type: record.type,
            channelId: record.channelId,
          },
          'outbound record posted to Slack',
        );

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        log.error(
          { err, enclaveName, recordId: record.id },
          'failed to post outbound record',
        );
      } finally {
        span.end();
      }
    });
  }
}
