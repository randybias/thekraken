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
import { isValidEnclaveName } from '../enclave/binding.js';

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
  | { type: 'enclave_sync_add'; targetUserIds: string[] }
  | { type: 'enclave_sync_remove'; targetUserIds: string[] }
  | { type: 'enclave_sync_transfer'; targetUserId: string }
  | { type: 'enclave_archive' }
  | { type: 'enclave_delete' }
  | { type: 'enclave_members' }
  | { type: 'enclave_whoami' }
  | { type: 'enclave_help' }
  | { type: 'drift_sync'; channelId: string }
  | { type: 'channel_event'; eventType: ChannelEventType }
  | { type: 'ignore_unbound' }
  | { type: 'ignore_bot' }
  | { type: 'ignore_visitor' }
  | { type: 'ignore_no_mention' };

/** Slack channel lifecycle event types handled deterministically. */
export type ChannelEventType =
  | 'member_joined_channel'
  | 'member_left_channel'
  | 'channel_archive'
  | 'channel_unarchive'
  | 'channel_rename';

/** Reason the smart path was chosen. */
export type SmartReason =
  | 'dm_query'
  | 'ambiguous_input'
  | 'status_check'
  | 'help_request';

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

/** Filler words between @mentions in multi-mention commands. */
const FILLER_RE = /^(and|also|please|then|,)\s*/i;

/**
 * Extract one or more Slack @mentions from text after a verb.
 *
 * Skips filler words (and, also, please, then, commas) between mentions.
 * Returns null if no mentions found, or if the first non-filler token is
 * not an @mention (this distinguishes "add @alice" from "add a new node").
 */
function extractMentions(afterVerb: string): string[] | null {
  let rest = afterVerb.trim();
  const mentions: string[] = [];
  while (rest.length > 0) {
    const filler = rest.match(FILLER_RE);
    if (filler) {
      rest = rest.slice(filler[0].length).trim();
      continue;
    }
    const mention = rest.match(/^<@([A-Z0-9]+)>/i);
    if (mention) {
      mentions.push(mention[1]!);
      rest = rest.slice(mention[0].length).trim();
      continue;
    }
    // Non-filler, non-mention: stop. If we have some mentions already,
    // trailing text is OK (e.g. "add @alice please"). If we have none,
    // the first token is not a @mention, so this is not a command.
    if (mentions.length === 0) return null;
    break;
  }
  return mentions.length > 0 ? mentions : null;
}

/**
 * Parse a @kraken command from message text.
 *
 * Matches the full command grammar:
 *   @kraken add @user [@user2 ...]
 *   @kraken remove @user [@user2 ...]
 *   @kraken transfer [@to] @user
 *   @kraken archive
 *   @kraken delete enclave
 *   @kraken members
 *   @kraken whoami
 *   @kraken help
 *
 * Returns null for unrecognised text. Commands are deterministic — never LLM.
 *
 * Disambiguation rule: for add/remove, the first non-filler token after the
 * verb MUST be an @mention. "add @alice" = command; "add a new node" = null
 * (falls through to smart path).
 */
export function parseCommand(text: string): DeterministicAction | null {
  // Strip leading bot @mention prefix and normalise whitespace
  const stripped = text.replace(/^<@[A-Z0-9]+>\s*/i, '').trim();

  // --- add / remove @user(s) ---
  const memberMatch = stripped.match(/^(add|remove)\s+(.*)/is);
  if (memberMatch) {
    const verb = memberMatch[1]!.toLowerCase();
    const mentions = extractMentions(memberMatch[2]!);
    if (mentions) {
      return verb === 'add'
        ? { type: 'enclave_sync_add', targetUserIds: mentions }
        : { type: 'enclave_sync_remove', targetUserIds: mentions };
    }
    return null; // first token not @mention → smart path
  }

  // --- transfer [to] @user ---
  const transfer = stripped.match(/^transfer\s+(?:to\s+)?<@([A-Z0-9]+)>/i);
  if (transfer)
    return { type: 'enclave_sync_transfer', targetUserId: transfer[1]! };
  if (/^transfer\b/i.test(stripped)) return null; // transfer without @mention → smart

  // --- exact-phrase commands ---
  if (/^archive\s*$/i.test(stripped)) return { type: 'enclave_archive' };
  if (/^delete\s+enclave\s*$/i.test(stripped))
    return { type: 'enclave_delete' };
  if (/^members\s*$/i.test(stripped)) return { type: 'enclave_members' };
  if (/^whoami\s*$/i.test(stripped)) return { type: 'enclave_whoami' };
  if (/^help\s*$/i.test(stripped)) return { type: 'enclave_help' };

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
 *   1.  Bot/self message -> ignore_bot
 *   2.  Message in unbound channel (non-DM) -> ignore_unbound
 *   3.  "@kraken add @user(s)" -> enclave_sync_add
 *   4.  "@kraken remove @user(s)" -> enclave_sync_remove
 *   5.  "@kraken transfer @user" -> enclave_sync_transfer
 *   5a. "@kraken archive" -> enclave_archive
 *   5b. "@kraken delete enclave" -> enclave_delete
 *   5c. "@kraken members" -> enclave_members
 *   5d. "@kraken whoami" -> enclave_whoami
 *   5e. "@kraken help" -> enclave_help
 *   6.  member_left_channel event in bound channel -> drift_sync
 *   6a. channel_archive / channel_unarchive / channel_rename / member_joined
 *       events in bound channel -> channel_event
 *   7.  @mention in bound channel (no command) -> forward_to_active_team or
 *       spawn_and_forward
 *   8.  Thread reply in bound channel -> forward_to_active_team or
 *       spawn_and_forward
 *   9.  Non-@mention, non-thread message in bound channel -> ignore_no_mention
 *
 * SMART path (everything not matched above):
 *   A. DM from authenticated user
 *   B. Ambiguous @mention (no command, no binding)
 *   C. Status check ("what's happening?")
 *   D. Help request
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

  // Criterion 6a: channel lifecycle events -> channel_event
  const CHANNEL_EVENTS: ChannelEventType[] = [
    'member_joined_channel',
    'channel_archive',
    'channel_unarchive',
    'channel_rename',
  ];
  if (CHANNEL_EVENTS.includes(event.type as ChannelEventType)) {
    const binding = deps.bindings.lookupEnclave(event.channelId);
    if (binding) {
      return {
        path: 'deterministic',
        action: {
          type: 'channel_event',
          eventType: event.type as ChannelEventType,
        },
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

  // Criteria 3-5e: Command parsing (deterministic commands)
  const command = parseCommand(event.text);
  if (command) {
    return { path: 'deterministic', action: command };
  }

  // Criterion 9 (FN-2): In a bound channel, non-@mention non-thread messages
  // are silently ignored. The enclave is not a general-purpose chat channel.
  if (
    binding &&
    event.type === 'message' &&
    event.channelType !== 'im' &&
    !event.threadTs
  ) {
    const hasMention = /<@[A-Z0-9]+>/i.test(event.text);
    if (!hasMention) {
      return { path: 'deterministic', action: { type: 'ignore_no_mention' } };
    }
  }

  // Criteria 7-8: Enclave-bound @mention or thread reply
  if (binding) {
    // Reject bindings with invalid enclave names (path traversal, etc.)
    // This guards against data corruption or malicious binding entries.
    if (!isValidEnclaveName(binding.enclaveName)) {
      return { path: 'deterministic', action: { type: 'ignore_unbound' } };
    }
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

  // Smart path A-D: DMs, ambiguous input, status checks, help
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
