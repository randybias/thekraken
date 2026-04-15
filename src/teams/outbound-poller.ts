/**
 * OutboundPoller — polls per-enclave team outbound.ndjson files and posts
 * messages to Slack (T11).
 *
 * Design:
 * - Polls all active team outbound.ndjson files every 1 second.
 * - Posts records to the correct Slack channel/thread.
 * - Per-record dedup via content hash (OutboundTracker) to survive restarts.
 * - Handles heartbeat records per Section 8 of the design doc (D5).
 * - Emits OTel spans per outbound post.
 * - Graceful shutdown: drains outstanding records on stop().
 * - In-flight mutex prevents overlapping poll cycles (Codex fix #2).
 * - Recently-exited teams remain pollable until drained (Codex fix #3).
 *
 * Heartbeat format (D5): type='heartbeat', friendly human-addressed text.
 * The poller posts heartbeat records the same way as slack_message records.
 * Rate-limiting is the manager's responsibility (30s floor).
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { createChildLogger } from '../logger.js';
import { NdjsonReader } from './ndjson.js';
import { OutboundTracker } from '../slack/outbound.js';
import { formatAgentResponse } from '../slack/formatter.js';
import type { KnownBlock } from '@slack/types';
import type { KrakenConfig } from '../config.js';
import type { TeamLifecycleManager } from './lifecycle.js';
import { filterJargon, filterNarration } from '../extensions/jargon-filter.js';

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
    blocks?: KnownBlock[];
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
  /** In-flight mutex: prevents overlapping poll cycles (Codex fix #2). */
  private polling = false;
  /**
   * Teams that recently exited but may still have unread outbound records.
   * Kept pollable for one extra cycle to drain final messages (Codex fix #3).
   */
  private drainingTeams = new Set<string>();

  constructor(private readonly deps: OutboundPollerDeps) {}

  /**
   * Start polling.
   *
   * Returns immediately; polling happens asynchronously on a 1s interval.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => void this.safePoll(), POLL_INTERVAL_MS);
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
    // Final drain — bypass in-flight guard
    this.polling = false;
    await this.poll();
    log.info('outbound poller stopped');
  }

  /**
   * Notify the poller that a team has exited. The poller will drain its
   * outbound file one more time before removing the reader (Codex fix #3).
   */
  notifyTeamExited(enclaveName: string): void {
    this.drainingTeams.add(enclaveName);
  }

  /**
   * Safe poll wrapper: skips if a previous poll is still in-flight (Codex fix #2).
   */
  private async safePoll(): Promise<void> {
    if (this.polling) {
      log.debug('skipping poll cycle — previous still in flight');
      return;
    }
    this.polling = true;
    try {
      await this.poll();
    } finally {
      this.polling = false;
    }
  }

  private async poll(): Promise<void> {
    const activeTeams = this.deps.getActiveTeams();
    // Merge active teams with teams that need one more drain
    const allTeams = new Set([...activeTeams, ...this.drainingTeams]);

    for (const enclaveName of allTeams) {
      await this.pollTeam(enclaveName);
    }

    // Draining teams got their final poll — remove them
    this.drainingTeams.clear();

    // GC readers for teams that are no longer active or draining
    for (const [name] of this.readers) {
      if (!allTeams.has(name)) {
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
        // Per-record dedup via content hash (Codex fix #1).
        // This replaces the previous thread-level dedup which silently
        // dropped all messages after the first post in a thread.
        const rawText = record.mentionUser
          ? `<@${record.mentionUser}> ${record.text}`
          : record.text;
        // Apply jargon filter and narration filter before posting to Slack.
        const text = filterNarration(filterJargon(rawText));
        const contentHash = createHash('sha256')
          .update(text, 'utf8')
          .digest('hex');

        if (this.deps.tracker.hasOutboundByHash(contentHash)) {
          log.debug(
            { enclaveName, recordId: record.id },
            'skipping already-posted outbound record (content hash match)',
          );
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return;
        }

        // Apply Block Kit formatting for richer Slack rendering.
        // Falls back to plain text if formatting produces no blocks.
        const formatted = formatAgentResponse(text);

        // Post main message
        const result = await this.deps.slack.postMessage({
          channel: record.channelId,
          thread_ts: record.threadTs || undefined,
          text: formatted.text || text,
          blocks: formatted.blocks.length > 0 ? formatted.blocks : undefined,
        });

        // Post any overflow batches (messages exceeding 50 blocks) as
        // follow-up messages in the same thread.
        if (formatted.overflow && formatted.overflow.length > 0) {
          const threadTs = result.ts ?? record.threadTs;
          for (const batch of formatted.overflow) {
            await this.deps.slack.postMessage({
              channel: record.channelId,
              thread_ts: threadTs || undefined,
              text: formatted.text || text,
              blocks: batch,
            });
          }
        }

        // Record in SQLite for dedup (uses content hash, not thread-level)
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
          'error posting outbound record',
        );
      } finally {
        span.end();
      }
    });
  }
}
