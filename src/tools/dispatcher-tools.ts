/**
 * Dispatcher custom tools (T15).
 *
 * These are pi ToolDefinition objects registered on the dispatcher's
 * AgentSession. They are only used on the SMART PATH — the deterministic
 * path routes without any LLM involvement.
 *
 * Tools:
 *   - spawn_enclave_team: Delegates to TeamLifecycleManager
 *   - send_to_team: Appends to mailbox.ndjson
 *   - check_team_status: Reads team signals.ndjson + outbound.ndjson
 *   - post_to_slack: Direct Slack WebClient post (dispatcher-originated)
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { NdjsonReader } from '../teams/ndjson.js';
import { createChildLogger } from '../logger.js';
import type { KrakenConfig } from '../config.js';
import type { TeamLifecycleManager } from '../teams/lifecycle.js';
import type { SlackPostClient } from '../teams/outbound-poller.js';

const log = createChildLogger({ module: 'dispatcher-tools' });

/**
 * A pi ToolDefinition (simplified shape for Phase 1).
 *
 * Phase 1: we define our own interface matching pi's ToolDefinition shape.
 * Phase 2: import directly from @mariozechner/pi-coding-agent once the
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
  const { config, teams, slack } = deps;

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

        // Read recent signals (last 5)
        const signalsPath = join(teamDir, 'signals.ndjson');
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
