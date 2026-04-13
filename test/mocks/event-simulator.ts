/**
 * SlackEventSimulator — factory functions for Slack event payloads.
 *
 * Generates structurally valid Slack event_callback envelopes for use in
 * unit and integration tests without a real Slack workspace.
 *
 * All factories produce auto-generated event_id, team_id, and ts values
 * unless overridden via opts.
 */

let _seq = 0;

function nextEventId(): string {
  return `Ev${String(++_seq).padStart(9, '0')}`;
}

function nextTs(): string {
  return `${Date.now()}.${String(_seq).padStart(6, '0')}`;
}

const DEFAULT_TEAM_ID = 'T0000TEST';

export interface SlackEvent {
  type: string;
  [key: string]: unknown;
}

export interface SlackEventEnvelope {
  type: 'event_callback';
  event: SlackEvent;
  event_id: string;
  team_id: string;
}

/** @mention event (user types "@kraken ...") */
export function createAppMention(opts: {
  channel: string;
  user: string;
  text: string;
  threadTs?: string;
  eventId?: string;
  teamId?: string;
}): SlackEventEnvelope {
  const ts = nextTs();
  return {
    type: 'event_callback',
    event_id: opts.eventId ?? nextEventId(),
    team_id: opts.teamId ?? DEFAULT_TEAM_ID,
    event: {
      type: 'app_mention',
      channel: opts.channel,
      user: opts.user,
      text: opts.text,
      ts,
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    },
  };
}

/** Regular message in a channel */
export function createMessage(opts: {
  channel: string;
  user: string;
  text: string;
  threadTs?: string;
  eventId?: string;
  teamId?: string;
}): SlackEventEnvelope {
  const ts = nextTs();
  return {
    type: 'event_callback',
    event_id: opts.eventId ?? nextEventId(),
    team_id: opts.teamId ?? DEFAULT_TEAM_ID,
    event: {
      type: 'message',
      channel: opts.channel,
      user: opts.user,
      text: opts.text,
      ts,
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    },
  };
}

/** Channel archived */
export function createChannelArchive(opts: {
  channel: string;
  eventId?: string;
  teamId?: string;
}): SlackEventEnvelope {
  return {
    type: 'event_callback',
    event_id: opts.eventId ?? nextEventId(),
    team_id: opts.teamId ?? DEFAULT_TEAM_ID,
    event: {
      type: 'channel_archive',
      channel: opts.channel,
    },
  };
}

/** Channel renamed */
export function createChannelRename(opts: {
  channel: string;
  name: string;
  eventId?: string;
  teamId?: string;
}): SlackEventEnvelope {
  return {
    type: 'event_callback',
    event_id: opts.eventId ?? nextEventId(),
    team_id: opts.teamId ?? DEFAULT_TEAM_ID,
    event: {
      type: 'channel_rename',
      channel: {
        id: opts.channel,
        name: opts.name,
        created: Math.floor(Date.now() / 1000),
      },
    },
  };
}

/** Member left a channel */
export function createMemberLeftChannel(opts: {
  channel: string;
  user: string;
  eventId?: string;
  teamId?: string;
}): SlackEventEnvelope {
  return {
    type: 'event_callback',
    event_id: opts.eventId ?? nextEventId(),
    team_id: opts.teamId ?? DEFAULT_TEAM_ID,
    event: {
      type: 'member_left_channel',
      user: opts.user,
      channel: opts.channel,
      channel_type: 'C',
    },
  };
}
