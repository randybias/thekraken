/**
 * Channel event handlers for Slack lifecycle events.
 *
 * Processes member_joined, member_left, channel_archive, and channel_rename
 * events and routes them to MCP enclave_sync calls.
 *
 * These are best-effort: if MCP calls fail, they are logged. Drift
 * detection catches anything missed.
 */

import { logger } from '../logger.js';

export type ChannelEventType =
  | 'member_joined'
  | 'member_left'
  | 'channel_archive'
  | 'channel_rename';

export interface ChannelEventDeps {
  resolveEmail: (userId: string) => Promise<string | undefined>;
  mcpCall: (tool: string, params: Record<string, unknown>) => Promise<unknown>;
  getEnclaveInfo: (name: string) => Promise<{ owner: string; members: string[] } | undefined>;
  invalidateCache: (name: string) => void;
  botUserId: string;
}

/**
 * Handle a Slack channel lifecycle event.
 * Resolves user emails, checks enclave membership, and calls enclave_sync.
 */
export async function handleChannelEvent(
  eventType: ChannelEventType,
  enclaveName: string,
  params: {
    userId?: string;
    newName?: string;
  },
  deps: ChannelEventDeps,
): Promise<void> {
  switch (eventType) {
    case 'member_joined':
      handleMemberJoined(enclaveName, params.userId, deps.botUserId);
      break;

    case 'member_left':
      await handleMemberLeft(enclaveName, params.userId, deps);
      break;

    case 'channel_archive':
      await handleChannelArchive(enclaveName, deps);
      break;

    case 'channel_rename':
      await handleChannelRename(enclaveName, params.newName, deps);
      break;

    default:
      logger.debug({ eventType }, 'channel-events: unknown event type');
  }
}

function handleMemberJoined(
  enclaveName: string,
  userId: string | undefined,
  botUserId: string,
): void {
  // Bot join events are handled in slack.ts (onBotJoinedChannel) and never
  // forwarded here, but guard defensively in case wiring changes.
  if (userId === botUserId) return;

  // Join = visitor, no annotation change
  logger.debug(
    { enclaveName, userId },
    'channel-events: member joined (visitor, no action)',
  );
}

async function handleMemberLeft(
  enclaveName: string,
  userId: string | undefined,
  deps: ChannelEventDeps,
): Promise<void> {
  if (userId === deps.botUserId) {
    logger.debug({ enclaveName }, 'channel-events: bot left channel, ignoring');
    return;
  }

  if (!userId) {
    logger.warn({ enclaveName }, 'channel-events: member_left missing userId');
    return;
  }

  const email = await deps.resolveEmail(userId);
  if (!email) {
    logger.warn(
      { enclaveName, userId },
      'channel-events: could not resolve email for leaving user',
    );
    return;
  }

  // Check if the user is actually a member (not just a visitor)
  const info = await deps.getEnclaveInfo(enclaveName);
  if (!info) {
    logger.debug(
      { enclaveName },
      'channel-events: enclave not found, skipping member_left',
    );
    return;
  }

  if (!info.members.some((m) => m.toLowerCase() === email.toLowerCase())) {
    logger.debug(
      { enclaveName, email },
      'channel-events: leaving user is a visitor, no action',
    );
    return;
  }

  try {
    await deps.mcpCall('enclave_sync', {
      name: enclaveName,
      remove_members: [email],
    });

    deps.invalidateCache(enclaveName);

    logger.info(
      { enclaveName, email },
      'channel-events: member removed on leave',
    );
  } catch (err) {
    logger.error(
      { enclaveName, email, err },
      'channel-events: failed to remove member on leave',
    );
  }
}

async function handleChannelArchive(
  enclaveName: string,
  deps: ChannelEventDeps,
): Promise<void> {
  try {
    await deps.mcpCall('enclave_sync', {
      name: enclaveName,
      new_status: 'frozen',
    });

    deps.invalidateCache(enclaveName);
    logger.info(
      { enclaveName },
      'channel-events: enclave frozen on archive',
    );
  } catch (err) {
    logger.error(
      { enclaveName, err },
      'channel-events: failed to freeze enclave on archive',
    );
  }
}

async function handleChannelRename(
  enclaveName: string,
  newName: string | undefined,
  deps: ChannelEventDeps,
): Promise<void> {
  if (!newName) {
    logger.warn(
      { enclaveName },
      'channel-events: channel_rename missing newName',
    );
    return;
  }

  try {
    await deps.mcpCall('enclave_sync', {
      name: enclaveName,
      new_channel_name: newName,
    });

    logger.info(
      { enclaveName, newName },
      'channel-events: enclave channel name updated on rename',
    );
  } catch (err) {
    logger.error(
      { enclaveName, newName, err },
      'channel-events: failed to update channel name on rename',
    );
  }
}
