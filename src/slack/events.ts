/**
 * Slack channel lifecycle event handlers (Phase 3).
 *
 * Registers Bolt event listeners for:
 *   - member_joined_channel  — log visitor, no enclave action
 *   - member_left_channel    — remove if enclave member, transfer tentacles
 *   - channel_archive        — freeze + dehydrate (wf_remove per tentacle)
 *   - channel_unarchive      — activate (no auto-rehydrate)
 *   - channel_rename         — sync new channel name
 *
 * All handlers are best-effort: failures are logged, drift detection catches up.
 * Bot self-events are filtered out.
 */

import type { App } from '@slack/bolt';
import { createChildLogger } from '../logger.js';
import { invalidateCache } from '../enclave/authz.js';
import type { EnclaveBindingEngine } from '../enclave/binding.js';

const log = createChildLogger({ module: 'channel-events' });

/** Minimal dependencies for channel event handlers. */
export interface ChannelEventDeps {
  bindings: Pick<EnclaveBindingEngine, 'lookupEnclave'>;
  mcpCall: (tool: string, params: Record<string, unknown>) => Promise<unknown>;
  botUserId: string;
  resolveEmail: (slackId: string) => Promise<string | undefined>;
}

/** Shape of enclave_info from MCP. */
interface EnclaveInfoResult {
  owner: string;
  members: string[];
  status: string;
  name: string;
  tentacles?: string[];
}

/**
 * Remove a member from an enclave if they are in the members list.
 * Never removes the owner. Invalidates authz cache.
 */
async function removeMemberIfPresent(
  deps: ChannelEventDeps,
  enclaveName: string,
  userId: string,
): Promise<void> {
  const email = await deps.resolveEmail(userId);
  if (!email) {
    log.warn(
      { enclaveName, userId },
      'channel event: could not resolve email for departed user',
    );
    return;
  }

  // Check membership before calling enclave_sync
  let info: EnclaveInfoResult | undefined;
  try {
    info = (await deps.mcpCall('enclave_info', {
      name: enclaveName,
    })) as EnclaveInfoResult;
  } catch (err) {
    log.warn(
      { err, enclaveName },
      'channel event: could not fetch enclave_info',
    );
    return;
  }

  // Never remove the owner
  if (email.toLowerCase() === info.owner.toLowerCase()) {
    log.info(
      { enclaveName, email },
      'channel event: owner left channel, no membership change',
    );
    return;
  }

  // Only remove if they are an actual member
  const isMember = info.members?.some(
    (m) => m.toLowerCase() === email.toLowerCase(),
  );
  if (!isMember) {
    log.debug(
      { enclaveName, email },
      'channel event: departed user was a visitor, no action',
    );
    return;
  }

  try {
    await deps.mcpCall('enclave_sync', {
      name: enclaveName,
      remove_members: [email],
    });
    invalidateCache(enclaveName);
    log.info(
      { enclaveName, email },
      'channel event: member removed after leaving channel',
    );
  } catch (err) {
    log.warn(
      { err, enclaveName, email },
      'channel event: failed to remove member',
    );
  }
}

/**
 * Dehydrate all tentacles in an enclave via wf_remove.
 * Best-effort: individual failures are logged but don't abort.
 */
async function dehydrateTentacles(
  deps: ChannelEventDeps,
  enclaveName: string,
): Promise<void> {
  let tentacles: string[] = [];
  try {
    const info = (await deps.mcpCall('enclave_info', {
      name: enclaveName,
    })) as EnclaveInfoResult;
    tentacles = info?.tentacles ?? [];
  } catch (err) {
    log.warn(
      { err, enclaveName },
      'channel event: could not fetch tentacle list for dehydration',
    );
    return;
  }

  for (const tentacle of tentacles) {
    try {
      await deps.mcpCall('wf_remove', {
        name: tentacle,
        namespace: enclaveName,
      });
      log.info({ enclaveName, tentacle }, 'channel event: tentacle dehydrated');
    } catch (err) {
      log.warn(
        { err, enclaveName, tentacle },
        'channel event: tentacle dehydration failed (best-effort)',
      );
    }
  }
}

/**
 * Register channel lifecycle event handlers on the Bolt app.
 */
export function registerChannelEvents(app: App, deps: ChannelEventDeps): void {
  // ---------------------------------------------------------------------------
  // member_joined_channel — log visitor, no enclave membership change
  // ---------------------------------------------------------------------------
  app.event('member_joined_channel', async ({ event }) => {
    const userId = (event as { user?: string }).user ?? '';
    const channelId = event.channel;

    // Filter bot self-events
    if (userId === deps.botUserId) {
      log.debug({ channelId }, 'channel event: bot joined channel, ignoring');
      return;
    }

    const binding = deps.bindings.lookupEnclave(channelId);
    if (!binding) return;

    log.info(
      { enclaveName: binding.enclaveName, userId, channelId },
      'channel event: user joined channel (visitor, no enclave membership change)',
    );
  });

  // ---------------------------------------------------------------------------
  // member_left_channel — remove from enclave if member, transfer tentacles
  // ---------------------------------------------------------------------------
  app.event('member_left_channel', async ({ event }) => {
    const userId = (event as { user?: string }).user ?? '';
    const channelId = event.channel;

    // Filter bot self-events
    if (userId === deps.botUserId) {
      log.debug({ channelId }, 'channel event: bot left channel, ignoring');
      return;
    }

    const binding = deps.bindings.lookupEnclave(channelId);
    if (!binding) return;

    log.info(
      { enclaveName: binding.enclaveName, userId, channelId },
      'channel event: user left channel, checking enclave membership',
    );

    await removeMemberIfPresent(deps, binding.enclaveName, userId);
  });

  // ---------------------------------------------------------------------------
  // channel_archive — freeze enclave + dehydrate tentacles
  // ---------------------------------------------------------------------------
  app.event('channel_archive', async ({ event }) => {
    const channelId = (event as { channel?: string }).channel ?? '';

    const binding = deps.bindings.lookupEnclave(channelId);
    if (!binding) return;

    const enclaveName = binding.enclaveName;
    log.info(
      { enclaveName, channelId },
      'channel event: channel archived, freezing enclave',
    );

    try {
      await deps.mcpCall('enclave_sync', {
        name: enclaveName,
        status: 'frozen',
      });
      invalidateCache(enclaveName);
      log.info({ enclaveName }, 'channel event: enclave frozen');
    } catch (err) {
      log.warn(
        { err, enclaveName },
        'channel event: failed to freeze enclave (best-effort)',
      );
    }

    await dehydrateTentacles(deps, enclaveName);
  });

  // ---------------------------------------------------------------------------
  // channel_unarchive — activate enclave (no auto-rehydrate)
  // ---------------------------------------------------------------------------
  app.event('channel_unarchive', async ({ event }) => {
    const channelId = (event as { channel?: string }).channel ?? '';

    const binding = deps.bindings.lookupEnclave(channelId);
    if (!binding) return;

    const enclaveName = binding.enclaveName;
    log.info(
      { enclaveName, channelId },
      'channel event: channel unarchived, activating enclave',
    );

    try {
      await deps.mcpCall('enclave_sync', {
        name: enclaveName,
        status: 'active',
      });
      invalidateCache(enclaveName);
      log.info(
        { enclaveName },
        'channel event: enclave activated (tentacles must be redeployed manually)',
      );
    } catch (err) {
      log.warn(
        { err, enclaveName },
        'channel event: failed to activate enclave (best-effort)',
      );
    }
  });

  // ---------------------------------------------------------------------------
  // channel_rename — sync new channel name
  // ---------------------------------------------------------------------------
  app.event('channel_rename', async ({ event }) => {
    const channelId = (
      event as { channel?: { id?: string; name?: string } | string }
    ).channel;
    const id =
      typeof channelId === 'object' ? (channelId?.id ?? '') : (channelId ?? '');
    const newName =
      typeof channelId === 'object' ? (channelId?.name ?? '') : '';

    const binding = deps.bindings.lookupEnclave(id);
    if (!binding) return;

    const enclaveName = binding.enclaveName;
    log.info({ enclaveName, id, newName }, 'channel event: channel renamed');

    if (!newName) {
      log.warn(
        { enclaveName, id },
        'channel event: rename event missing new name',
      );
      return;
    }

    try {
      await deps.mcpCall('enclave_sync', {
        name: enclaveName,
        new_channel_name: newName,
      });
      log.info({ enclaveName, newName }, 'channel event: channel name synced');
    } catch (err) {
      log.warn(
        { err, enclaveName, newName },
        'channel event: failed to sync channel name (best-effort)',
      );
    }
  });
}
