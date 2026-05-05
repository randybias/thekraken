/**
 * Dispatcher internal operations (T15).
 *
 * These are pi ToolDefinition objects registered on the dispatcher's
 * AgentSession. They are INTERNAL Kraken functions — NOT MCP tools exposed
 * by the tentacular-mcp server. They are only used on the SMART PATH; the
 * deterministic path routes without any LLM involvement.
 *
 * Internal ops:
 *   - spawn_enclave_team: Delegates to TeamLifecycleManager
 *   - send_to_team: Appends to mailbox.ndjson
 *   - check_team_status: Reads team signals-in.ndjson + outbound.ndjson
 *   - post_to_slack: Direct Slack WebClient post (dispatcher-originated)
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { NdjsonReader } from '../teams/ndjson.js';
import { SIGNALS_IN_FILE } from '../teams/signals.js';
import { createChildLogger } from '../logger.js';
import type { KrakenConfig } from '../config.js';
import type { TeamLifecycleManager } from '../teams/lifecycle.js';
import type Database from 'better-sqlite3';
import type { SlackPostClient } from '../teams/outbound-poller.js';

const log = createChildLogger({ module: 'dispatcher-internal-ops' });

/**
 * A pi ToolDefinition (simplified shape).
 *
 * Defines our own interface matching pi's ToolDefinition shape.
 * Import directly from @mariozechner/pi-coding-agent once
 * createAgentSession() wiring is complete.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (params: Record<string, any>) => Promise<string>;
}

export interface DispatcherToolDeps {
  config: KrakenConfig;
  teams: TeamLifecycleManager;
  slack: SlackPostClient;
  /** Optional DB handle — required for record_deploy_event, list_deploy_events, describe_change, record_change_summary tools. */
  db?: Database.Database;
  /** Optional git differ — required for describe_change tool. Tests inject a mock. */
  gitDiffer?: GitDiffer;
}

// ---------------------------------------------------------------------------
// record_deploy_event — standalone export for use by deployer subprocess
// ---------------------------------------------------------------------------

export interface RecordDeployEventParams {
  enclave: string;
  tentacle: string;
  gitSha: string;
  summary: string;
  deployedByEmail: string;
  triggeredByChannel: string;
  triggeredByTs: string;
}

/**
 * Record a deployer-generated plain-English summary for a deploy event.
 *
 * Computes the next monotonic version for (enclave, tentacle) automatically
 * so callers do not have to track version numbers.
 *
 * Falls back to "(deployed; no notes)" when summary is empty or whitespace-only.
 */
export async function recordDeployEvent(
  db: Database.Database,
  params: RecordDeployEventParams,
): Promise<void> {
  const summary = params.summary.trim() || '(deployed; no notes)';
  const nextVersion = (
    db
      .prepare(
        `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM deployments
         WHERE enclave = ? AND tentacle = ?`,
      )
      .get(params.enclave, params.tentacle) as { v: number }
  ).v;
  db.prepare(
    `INSERT INTO deployments (enclave, tentacle, version, git_sha, git_tag,
      deploy_type, summary, deployed_by_email, triggered_by_channel,
      triggered_by_ts, status)
     VALUES (?, ?, ?, ?, '', 'manual', ?, ?, ?, ?, 'success')`,
  ).run(
    params.enclave,
    params.tentacle,
    nextVersion,
    params.gitSha,
    summary,
    params.deployedByEmail,
    params.triggeredByChannel,
    params.triggeredByTs,
  );
}

// ---------------------------------------------------------------------------
// list_deploy_events — standalone export for manager use
// ---------------------------------------------------------------------------

export interface DeployEventPublic {
  ts: string;
  deployer_email: string;
  summary: string;
  /** Internal-only SHA the LLM reasons about. NOT for user output. */
  _internal_sha: string;
}

/**
 * List past deploy events for (enclave, tentacle), newest first.
 *
 * Returns only the public schema — no version_number, git_tag, or other
 * internal fields. The _internal_sha field is included for the manager LLM
 * to reference when calling commission_revert; it must NOT appear in user
 * output.
 */
export async function listDeployEvents(
  db: Database.Database,
  params: { enclave: string; tentacle: string },
): Promise<DeployEventPublic[]> {
  const rows = db
    .prepare(
      `SELECT git_sha, deployed_by_email, summary, created_at
       FROM deployments
       WHERE enclave = ? AND tentacle = ?
       ORDER BY datetime(created_at) DESC, id DESC`,
    )
    .all(params.enclave, params.tentacle) as Array<{
    git_sha: string;
    deployed_by_email: string;
    summary: string;
    created_at: string;
  }>;
  return rows.map((r) => ({
    ts: r.created_at,
    deployer_email: r.deployed_by_email,
    summary: r.summary,
    _internal_sha: r.git_sha,
  }));
}

// ---------------------------------------------------------------------------
// describe_change + record_change_summary — standalone exports for manager use
// ---------------------------------------------------------------------------

/**
 * Adapter for calling `git diff <shaA> <shaB>` against the tentacles repo.
 *
 * Tests inject a mock implementation. Production wires the real git differ.
 */
export interface GitDiffer {
  diff(shaA: string, shaB: string): Promise<string>;
}

export interface DescribeChangeResult {
  cached: boolean;
  summary?: string;
  diff?: string;
}

/**
 * Return a plain-English summary of the diff between two SHAs.
 *
 * On cache hit (sha_a, sha_b row in change_summaries): returns
 * `{cached: true, summary}`.
 *
 * On cache miss: calls the git differ and returns `{cached: false, diff}`.
 * The manager LLM should compose a summary and follow up with
 * `recordChangeSummary` to cache it.
 */
export async function describeChange(
  db: Database.Database,
  differ: GitDiffer,
  params: { shaA: string; shaB: string },
): Promise<DescribeChangeResult> {
  const cached = db
    .prepare(
      `SELECT summary FROM change_summaries WHERE sha_a = ? AND sha_b = ?`,
    )
    .get(params.shaA, params.shaB) as { summary: string } | undefined;

  if (cached) {
    return { cached: true, summary: cached.summary };
  }

  const diff = await differ.diff(params.shaA, params.shaB);
  return { cached: false, diff };
}

export interface RecordChangeSummaryParams {
  shaA: string;
  shaB: string;
  summary: string;
}

/**
 * Persist a manager-composed plain-English summary for a (shaA, shaB) pair.
 *
 * Uses INSERT OR REPLACE so the call is idempotent — running twice with the
 * same key replaces the previous summary.
 */
export async function recordChangeSummary(
  db: Database.Database,
  params: RecordChangeSummaryParams,
): Promise<void> {
  db.prepare(
    `INSERT OR REPLACE INTO change_summaries (sha_a, sha_b, summary)
     VALUES (?, ?, ?)`,
  ).run(params.shaA, params.shaB, params.summary);
}

// ---------------------------------------------------------------------------
// commission_revert — standalone export for manager use
// ---------------------------------------------------------------------------

export interface CommissionRevertParams {
  enclave: string;
  tentacle: string;
  targetSha: string;
  additionalIntent?: string;
  userSlackId: string;
}

export interface CommissionRevertResult {
  status: 'commissioned';
  jobId: string;
}

export interface RevertBrief {
  intent: string;
  enclave: string;
  tentacle: string;
  targetSha: string;
  userSlackId: string;
}

/** Minimal interface the revert path needs from teams. Tests inject a mock. */
export interface RevertTeams {
  spawn(brief: RevertBrief): Promise<{ jobId: string }>;
}

/**
 * Commission the dev team to restore a tentacle to a prior SHA and
 * optionally apply an additional change on top of the revert.
 *
 * Constructs a structured brief and calls teams.spawn() asynchronously.
 * Returns immediately with {status: 'commissioned', jobId}.
 */
export async function commissionRevert(
  teams: RevertTeams,
  params: CommissionRevertParams,
): Promise<CommissionRevertResult> {
  const additionalLine = params.additionalIntent
    ? `\nThen apply this additional change: ${params.additionalIntent}.`
    : '';

  const intent =
    `Restore ${params.tentacle} in ${params.enclave} to the version at ${params.targetSha}.` +
    additionalLine +
    `\nAfter all changes are committed, deploy as a single new version.` +
    `\nCompose the per-deploy summary describing the combined effect from the user's POV (not the mechanics).`;

  const brief: RevertBrief = {
    intent,
    enclave: params.enclave,
    tentacle: params.tentacle,
    targetSha: params.targetSha,
    userSlackId: params.userSlackId,
  };

  const { jobId } = await teams.spawn(brief);
  return { status: 'commissioned', jobId };
}

/**
 * Build the dispatcher's custom tool set.
 *
 * Returns an array of ToolDefinition objects to pass to createAgentSession().
 * All tools are safe for the smart-path LLM to call.
 */
export function buildDispatcherTools(
  deps: DispatcherToolDeps,
): ToolDefinition[] {
  const { config, teams, slack, db, gitDiffer } = deps;

  return [
    // -------------------------------------------------------------------------
    // spawn_enclave_team
    // -------------------------------------------------------------------------
    {
      name: 'spawn_enclave_team',
      description:
        'Spawn or wake a per-enclave team manager for the given enclave. ' +
        'Returns the team status. Call this before send_to_team if the team ' +
        'might not be running.',
      parameters: {
        type: 'object',
        properties: {
          enclaveName: { type: 'string', description: 'Enclave name' },
          userSlackId: {
            type: 'string',
            description: 'Slack user ID of the initiator',
          },
          userToken: {
            type: 'string',
            description: 'User OIDC access token (D6)',
          },
        },
        required: ['enclaveName', 'userSlackId', 'userToken'],
      },
      execute: async (params) => {
        const { enclaveName, userSlackId, userToken } = params as {
          enclaveName: string;
          userSlackId: string;
          userToken: string;
        };

        log.info({ enclaveName, userSlackId }, 'tool: spawn_enclave_team');

        const wasActive = teams.isTeamActive(enclaveName);
        await teams.spawnTeam(enclaveName, userSlackId, userToken);
        const isActive = teams.isTeamActive(enclaveName);

        return JSON.stringify({
          enclaveName,
          wasActive,
          isActive,
          action: wasActive ? 'refreshed' : 'spawned',
        });
      },
    },

    // -------------------------------------------------------------------------
    // send_to_team
    // -------------------------------------------------------------------------
    {
      name: 'send_to_team',
      description:
        'Send a message to an enclave team manager via its mailbox.ndjson. ' +
        'The message will be processed by the manager when it next reads the mailbox.',
      parameters: {
        type: 'object',
        properties: {
          enclaveName: { type: 'string', description: 'Target enclave name' },
          threadTs: {
            type: 'string',
            description: 'Slack thread timestamp for routing context',
          },
          channelId: {
            type: 'string',
            description: 'Slack channel ID for routing context',
          },
          message: {
            type: 'string',
            description: 'Message text to forward to the team',
          },
          userSlackId: {
            type: 'string',
            description: 'Slack user ID of the sender',
          },
          userToken: {
            type: 'string',
            description: 'User OIDC access token (D6)',
          },
        },
        required: [
          'enclaveName',
          'threadTs',
          'channelId',
          'message',
          'userSlackId',
          'userToken',
        ],
      },
      execute: async (params) => {
        const {
          enclaveName,
          threadTs,
          channelId,
          message,
          userSlackId,
          userToken,
        } = params as {
          enclaveName: string;
          threadTs: string;
          channelId: string;
          message: string;
          userSlackId: string;
          userToken: string;
        };

        log.info({ enclaveName, userSlackId }, 'tool: send_to_team');

        await teams.sendToTeam(enclaveName, {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          from: 'dispatcher',
          type: 'user_message',
          threadTs,
          channelId,
          userSlackId,
          // D6: token embedded in mailbox, never in outbound/signals
          userToken,
          message,
        });

        return JSON.stringify({
          enclaveName,
          sent: true,
          messageId: randomUUID(),
        });
      },
    },

    // -------------------------------------------------------------------------
    // check_team_status
    // -------------------------------------------------------------------------
    {
      name: 'check_team_status',
      description:
        'Check the status of an enclave team: is it running, what was the ' +
        'last activity, recent signals and outbound messages.',
      parameters: {
        type: 'object',
        properties: {
          enclaveName: { type: 'string', description: 'Enclave name to check' },
        },
        required: ['enclaveName'],
      },
      execute: async (params) => {
        const { enclaveName } = params as { enclaveName: string };

        log.debug({ enclaveName }, 'tool: check_team_status');

        const isActive = teams.isTeamActive(enclaveName);
        const teamDir = join(config.teamsDir, enclaveName);

        let lastModified: string | null = null;
        if (existsSync(teamDir)) {
          try {
            lastModified = statSync(teamDir).mtime.toISOString();
          } catch (err: unknown) {
            // stat may fail for race conditions; log and continue
            log.debug({ err, teamDir }, 'stat failed for team dir');
          }
        }

        // Read recent inbound signals (dev-team progress; last 5)
        const signalsPath = join(teamDir, SIGNALS_IN_FILE);
        const recentSignals = readLastN(signalsPath, 5);

        // Read recent outbound (last 5)
        const outboundPath = join(teamDir, 'outbound.ndjson');
        const recentOutbound = readLastN(outboundPath, 5);

        return JSON.stringify({
          enclaveName,
          isActive,
          teamDirExists: existsSync(teamDir),
          lastModified,
          recentSignals,
          recentOutbound,
        });
      },
    },

    // -------------------------------------------------------------------------
    // post_to_slack
    // -------------------------------------------------------------------------
    {
      name: 'post_to_slack',
      description:
        'Post a message directly to a Slack channel or thread. ' +
        'Use for dispatcher-originated messages like ephemeral auth prompts, ' +
        'cross-enclave status summaries, and help responses.',
      parameters: {
        type: 'object',
        properties: {
          channelId: { type: 'string', description: 'Target Slack channel ID' },
          threadTs: {
            type: 'string',
            description: 'Thread timestamp (optional — omit for new thread)',
          },
          text: { type: 'string', description: 'Message text' },
        },
        required: ['channelId', 'text'],
      },
      execute: async (params) => {
        const { channelId, threadTs, text } = params as {
          channelId: string;
          threadTs?: string;
          text: string;
        };

        log.info({ channelId, threadTs }, 'tool: post_to_slack');

        const result = await slack.postMessage({
          channel: channelId,
          thread_ts: threadTs || undefined,
          text,
        });

        return JSON.stringify({
          posted: true,
          channelId,
          messageTs: result.ts,
        });
      },
    },

    // -------------------------------------------------------------------------
    // record_deploy_event
    // -------------------------------------------------------------------------
    {
      name: 'record_deploy_event',
      description:
        'Record a plain-English summary for a completed deploy event in Kraken DB. ' +
        'Call this BEFORE wf_apply, after composing the per-deploy summary. ' +
        'The summary must be a single sentence written for a non-engineer reader.',
      parameters: {
        type: 'object',
        properties: {
          enclave: { type: 'string', description: 'Enclave name' },
          tentacle: { type: 'string', description: 'Tentacle name' },
          gitSha: {
            type: 'string',
            description: 'Git SHA of the deployed commit',
          },
          summary: {
            type: 'string',
            description:
              'Plain-English summary of what this deploy changes (~120 chars max). ' +
              'Leave empty to record "(deployed; no notes)".',
          },
          deployedByEmail: {
            type: 'string',
            description: 'Email of the deploying user',
          },
          triggeredByChannel: {
            type: 'string',
            description: 'Slack channel ID that triggered the deploy',
          },
          triggeredByTs: {
            type: 'string',
            description: 'Slack message timestamp that triggered the deploy',
          },
        },
        required: [
          'enclave',
          'tentacle',
          'gitSha',
          'summary',
          'deployedByEmail',
          'triggeredByChannel',
          'triggeredByTs',
        ],
      },
      execute: async (params) => {
        if (!db) {
          log.warn('record_deploy_event called but no db available in deps');
          return JSON.stringify({ ok: false, error: 'db not available' });
        }
        await recordDeployEvent(db, params as RecordDeployEventParams);
        log.info(
          { enclave: params['enclave'], tentacle: params['tentacle'] },
          'tool: record_deploy_event',
        );
        return JSON.stringify({ ok: true });
      },
    },

    // -------------------------------------------------------------------------
    // list_deploy_events
    // -------------------------------------------------------------------------
    {
      name: 'list_deploy_events',
      description:
        'List past deploy events for a tentacle in an enclave, newest first. ' +
        'Returns {ts, deployer_email, summary, _internal_sha}. ' +
        'Use _internal_sha when calling commission_revert. ' +
        'Never surface _internal_sha or SHA values in user-facing output.',
      parameters: {
        type: 'object',
        properties: {
          enclave: { type: 'string', description: 'Enclave name' },
          tentacle: { type: 'string', description: 'Tentacle name' },
        },
        required: ['enclave', 'tentacle'],
      },
      execute: async (params) => {
        if (!db) {
          log.warn('list_deploy_events called but no db available in deps');
          return JSON.stringify({ ok: false, error: 'db not available' });
        }
        const events = await listDeployEvents(
          db,
          params as { enclave: string; tentacle: string },
        );
        log.debug(
          {
            enclave: params['enclave'],
            tentacle: params['tentacle'],
            count: events.length,
          },
          'tool: list_deploy_events',
        );
        return JSON.stringify({ events });
      },
    },

    // -------------------------------------------------------------------------
    // describe_change
    // -------------------------------------------------------------------------
    {
      name: 'describe_change',
      description:
        'Return a plain-English summary of the diff between two deploy SHAs. ' +
        'On cache hit: returns {cached: true, summary}. ' +
        'On cache miss: returns {cached: false, diff} — compose a summary and call record_change_summary to cache it.',
      parameters: {
        type: 'object',
        properties: {
          shaA: {
            type: 'string',
            description: 'Older SHA (from list_deploy_events._internal_sha)',
          },
          shaB: {
            type: 'string',
            description: 'Newer SHA (from list_deploy_events._internal_sha)',
          },
        },
        required: ['shaA', 'shaB'],
      },
      execute: async (params) => {
        if (!db) {
          log.warn('describe_change called but no db available in deps');
          return JSON.stringify({ ok: false, error: 'db not available' });
        }
        const differ: GitDiffer = gitDiffer ?? {
          diff: async () => '(git differ not configured)',
        };
        const result = await describeChange(
          db,
          differ,
          params as { shaA: string; shaB: string },
        );
        log.debug(
          { shaA: params['shaA'], shaB: params['shaB'], cached: result.cached },
          'tool: describe_change',
        );
        return JSON.stringify(result);
      },
    },

    // -------------------------------------------------------------------------
    // record_change_summary
    // -------------------------------------------------------------------------
    {
      name: 'record_change_summary',
      description:
        'Cache a manager-composed plain-English summary of the diff between two deploy SHAs. ' +
        'Call this after receiving a cache miss from describe_change, once you have composed the summary. ' +
        'The summary must not contain SHAs, version numbers, or git terminology.',
      parameters: {
        type: 'object',
        properties: {
          shaA: { type: 'string', description: 'Older SHA' },
          shaB: { type: 'string', description: 'Newer SHA' },
          summary: {
            type: 'string',
            description:
              'Plain-English summary of what changed between the two versions',
          },
        },
        required: ['shaA', 'shaB', 'summary'],
      },
      execute: async (params) => {
        if (!db) {
          log.warn('record_change_summary called but no db available in deps');
          return JSON.stringify({ ok: false, error: 'db not available' });
        }
        await recordChangeSummary(db, params as RecordChangeSummaryParams);
        log.info(
          { shaA: params['shaA'], shaB: params['shaB'] },
          'tool: record_change_summary',
        );
        return JSON.stringify({ ok: true });
      },
    },

    // -------------------------------------------------------------------------
    // commission_revert
    // -------------------------------------------------------------------------
    {
      name: 'commission_revert',
      description:
        'Commission the dev team to restore a tentacle to a prior version (by internal SHA) ' +
        'and optionally apply an additional change on top. ' +
        'Always confirm with the user before calling this tool. ' +
        'Returns {status: "commissioned", jobId} immediately — the team handles the work async.',
      parameters: {
        type: 'object',
        properties: {
          enclave: { type: 'string', description: 'Enclave name' },
          tentacle: { type: 'string', description: 'Tentacle name' },
          targetSha: {
            type: 'string',
            description: 'Target SHA from list_deploy_events._internal_sha',
          },
          additionalIntent: {
            type: 'string',
            description:
              'Optional: additional change to apply on top of the revert (plain English)',
          },
          userSlackId: {
            type: 'string',
            description: 'Slack user ID of the requesting user',
          },
        },
        required: ['enclave', 'tentacle', 'targetSha', 'userSlackId'],
      },
      execute: async (params) => {
        const revertTeams: RevertTeams = {
          spawn: async (brief) => {
            // Wire into the teams lifecycle — use spawnTeam as the delegation path.
            // The brief is sent as a mailbox message to the enclave team.
            const p = params as {
              enclave: string;
              tentacle: string;
              targetSha: string;
              userSlackId: string;
              additionalIntent?: string;
            };
            await teams.spawnTeam(p.enclave, p.userSlackId, '');
            await teams.sendToTeam(p.enclave, {
              id: randomUUID(),
              timestamp: new Date().toISOString(),
              from: 'dispatcher',
              type: 'user_message',
              threadTs: '',
              channelId: '',
              userSlackId: p.userSlackId,
              userToken: '',
              message: brief.intent,
            });
            return { jobId: `revert-${p.tentacle}-${Date.now()}` };
          },
        };
        const p = params as CommissionRevertParams;
        const result = await commissionRevert(revertTeams, p);
        log.info(
          { enclave: p.enclave, tentacle: p.tentacle, targetSha: p.targetSha },
          'tool: commission_revert',
        );
        return JSON.stringify(result);
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the last N records from an NDJSON file. Returns [] if file missing. */
function readLastN(path: string, n: number): object[] {
  if (!existsSync(path)) return [];
  const reader = new NdjsonReader(path);
  // Read from beginning to get all records, then slice last N
  reader.reset();
  const all = reader.readNew();
  return all.slice(-n);
}
