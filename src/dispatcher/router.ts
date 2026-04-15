/**
 * Dispatcher event router (T09).
 *
 * Implements the two clearly-separated code paths required by D4:
 *   - DETERMINISTIC: table-driven, zero LLM calls. Admits events that match
 *     known patterns (enclave @mentions, commands, channel events).
 *   - SMART: LLM path for ambiguous events (DMs, novel phrasing, status checks).
 *
 * The boundary between the two paths is encoded as the exhaustive list of
 * deterministic admission criteria below. Every event type that is NOT
 * matched by a deterministic criterion falls through to the smart path.
 *
 * The routing matrix test (T25) in test/unit/dispatcher-router.test.ts is
 * the authoritative contract for D4.
 */

import type { EnclaveBindingEngine } from '../enclave/binding.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The result of routing a Slack event. */
export type RouteDecision =
  | { path: 'deterministic'; action: DeterministicAction }
  | { path: 'smart'; reason: SmartReason; context: SmartContext };

/** Actions taken on the deterministic path — NO LLM involved. */
export type DeterministicAction =
  | { type: 'spawn_and_forward'; enclaveName: string }
  | { type: 'forward_to_active_team'; enclaveName: string }
  | { type: 'enclave_sync_add'; targetUserId: string }
  | { type: 'enclave_sync_remove'; targetUserId: string }
  | { type: 'enclave_sync_transfer'; targetUserId: string }
  | { type: 'drift_sync'; channelId: string }
  | { type: 'ignore_unbound' }
  | { type: 'ignore_bot' }
  | { type: 'ignore_visitor' };

/** Reason the smart path was chosen. */
export type SmartReason =
  | 'dm_query'
  | 'ambiguous_input'
  | 'status_check'
  | 'help_request'
  | 'novel_phrasing';

/** Context passed to the smart-path LLM invocation. */
export interface SmartContext {
  eventType: string;
  channelId: string;
  threadTs: string;
  userId: string;
  text: string;
  enclaveName: string | null;
  mode: 'enclave' | 'dm';
}

/** Normalized representation of an inbound Slack event. */
export interface InboundEvent {
  /** Slack event type: 'app_mention', 'message', 'member_left_channel', etc. */
  type: string;
  /** Channel ID. */
  channelId: string;
  /** Channel type: 'channel', 'im', 'mpim', etc. */
  channelType?: string;
  /** Thread timestamp (undefined for top-level messages). */
  threadTs?: string;
  /** Slack user ID of the sender. */
  userId: string;
  /** Message text (may contain @mentions). */
  text: string;
  /** Present if the message was sent by a bot. */
  botId?: string;
}

/** Minimal dependency interface for the router. */
export interface RouterDeps {
  bindings: Pick<EnclaveBindingEngine, 'lookupEnclave'>;
  teams: {
    isTeamActive: (enclaveName: string) => boolean;
  };
}

// ---------------------------------------------------------------------------
// Command parser
// ---------------------------------------------------------------------------

/**
 * Parse a @kraken command from message text.
 *
 * Matches patterns like:
 *   @kraken add @user
 *   @kraken remove @user
 *   @kraken transfer @user
 *   @kraken archive
 *   @kraken whoami
 *   @kraken members
 *   @kraken help
 *
 * Returns null for unrecognised text. Commands are deterministic — never LLM.
 */
export function parseCommand(text: string): DeterministicAction | null {
  // Normalise: strip leading whitespace and bot @mention prefix
  const stripped = text
    .replace(/^<@[A-Z0-9]+>\s*/i, '') // strip leading @-mention of bot
    .trim();

  // Match: add/remove/transfer @user
  const userVerb = stripped.match(/^(add|remove|transfer)\s+<@([A-Z0-9]+)>/i);
  if (userVerb) {
    const verb = userVerb[1]!.toLowerCase();
    const targetUserId = userVerb[2]!;
    if (verb === 'add') return { type: 'enclave_sync_add', targetUserId };
    if (verb === 'remove') return { type: 'enclave_sync_remove', targetUserId };
    if (verb === 'transfer')
      return { type: 'enclave_sync_transfer', targetUserId };
  }

  // Match: no-argument commands (help, whoami, members, archive)
  const noArg = stripped.match(/^(help|whoami|members|archive)\b/i);
  if (noArg) {
    // help/whoami/members go to smart path for contextual response
    // archive is deterministic (drift_sync is the closest proxy)
    // Returning null lets these fall through to the smart path.
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Deterministic smart-reason classifier
// ---------------------------------------------------------------------------

/**
 * Classify the reason for taking the smart path from an event.
 *
 * Used to give the LLM a hint about what the user is likely asking.
 */
function classifySmartReason(event: InboundEvent): SmartReason {
  if (event.channelType === 'im') return 'dm_query';

  const lower = (event.text ?? '').toLowerCase();
  if (/what('s| is) (happening|going on|the status|up)/.test(lower))
    return 'status_check';
  if (/^help\b|^\/help/.test(lower)) return 'help_request';
  return 'ambiguous_input';
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

/**
 * Route a Slack event to either the deterministic or smart code path.
 *
 * DETERMINISTIC admission criteria (exhaustive — this IS the D4 contract):
 *   1. Bot/self message -> ignore_bot
 *   2. Message in unbound channel (non-DM) -> ignore_unbound
 *   3. "@kraken add @user" -> enclave_sync_add
 *   4. "@kraken remove @user" -> enclave_sync_remove
 *   5. "@kraken transfer @user" -> enclave_sync_transfer
 *   6. member_left_channel event in bound channel -> drift_sync
 *   7. @mention or thread reply in bound channel with active team -> forward_to_active_team
 *   8. @mention or thread reply in bound channel without active team -> spawn_and_forward
 *
 * SMART path (everything not matched above):
 *   A. DM from authenticated user
 *   B. Ambiguous @mention (no command, no binding)
 *   C. Status check ("what's happening?")
 *   D. Help request
 *   E. Novel phrasing not matching deterministic patterns
 */
export function routeEvent(
  event: InboundEvent,
  deps: RouterDeps,
): RouteDecision {
  // Criterion 1: Bot/self message -> ignore
  if (event.botId) {
    return { path: 'deterministic', action: { type: 'ignore_bot' } };
  }

  // Criterion 6: member_left_channel event
  if (event.type === 'member_left_channel') {
    const binding = deps.bindings.lookupEnclave(event.channelId);
    if (binding) {
      return {
        path: 'deterministic',
        action: { type: 'drift_sync', channelId: event.channelId },
      };
    }
    return { path: 'deterministic', action: { type: 'ignore_unbound' } };
  }

  // Criterion 2: Unbound channel (not a DM)
  const binding = deps.bindings.lookupEnclave(event.channelId);
  const enclaveName = binding?.enclaveName ?? null;
  if (!binding && event.channelType !== 'im') {
    return { path: 'deterministic', action: { type: 'ignore_unbound' } };
  }

  // Criteria 3-5: Command parsing (deterministic commands)
  const command = parseCommand(event.text);
  if (command) {
    return { path: 'deterministic', action: command };
  }

  // Criteria 7-8: Enclave-bound @mention or thread reply
  if (binding) {
    const teamActive = deps.teams.isTeamActive(binding.enclaveName);
    if (teamActive) {
      return {
        path: 'deterministic',
        action: {
          type: 'forward_to_active_team',
          enclaveName: binding.enclaveName,
        },
      };
    }
    return {
      path: 'deterministic',
      action: { type: 'spawn_and_forward', enclaveName: binding.enclaveName },
    };
  }

  // Smart path A-E: DMs, ambiguous input, status checks, help, novel phrasing
  return {
    path: 'smart',
    reason: classifySmartReason(event),
    context: {
      eventType: event.type,
      channelId: event.channelId,
      threadTs: event.threadTs ?? '',
      userId: event.userId,
      text: event.text,
      enclaveName,
      mode: event.channelType === 'im' ? 'dm' : 'enclave',
    },
  };
}
