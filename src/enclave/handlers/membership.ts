/**
 * Membership management command handlers: add, remove, members, whoami.
 *
 * All responses are plain language — no POSIX, mode bits, Kubernetes,
 * or namespace jargon.
 */

import { logger } from '../../logger.js';
import type { CommandContext } from '../commands.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EnclaveInfo {
  owner?: string;
  members?: string[];
  mode?: string;
  status?: string;
}

interface EnclaveSyncResult {
  updated?: string[];
  transfers?: Array<{
    tentacle_name: string;
    from_owner: string;
    to_owner: string;
    success: boolean;
    error?: string;
  }>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract Slack user IDs from mention syntax <@U12345>.
 */
function extractSlackUserIds(text: string): string[] {
  return [...text.matchAll(/<@([A-Z0-9_]+)>/gi)].map((m) => m[1]!);
}

/**
 * Fetch enclave info via MCP. Returns null on failure.
 */
async function fetchEnclaveInfo(
  ctx: CommandContext,
): Promise<EnclaveInfo | null> {
  try {
    return (await ctx.mcpCall('enclave_info', {
      name: ctx.enclaveName,
    })) as EnclaveInfo;
  } catch {
    return null;
  }
}

/**
 * Resolve the first mentioned Slack user in the text to their email.
 * Returns { slackId, email } or null if not resolvable.
 */
async function resolveMentionedUser(
  text: string,
  ctx: CommandContext,
): Promise<{ slackId: string; email: string } | null> {
  const userIds = extractSlackUserIds(text);
  if (userIds.length === 0) {
    await ctx.sendMessage('Please mention a user with @username.');
    return null;
  }

  const slackId = userIds[0]!;
  const email = await ctx.resolveEmail(slackId);
  if (!email) {
    await ctx.sendMessage(
      "I couldn't find that user's email. Make sure they have an email set in their Slack profile.",
    );
    return null;
  }

  return { slackId, email };
}

/**
 * Resolve the sender's email from their Slack ID.
 * Returns null and sends an error message if not resolvable.
 */
async function resolveSenderEmail(
  ctx: CommandContext,
): Promise<string | null> {
  const email = await ctx.resolveEmail(ctx.senderSlackId);
  if (!email) {
    await ctx.sendMessage(
      "I couldn't look up your email. Make sure your Slack profile has an email set.",
    );
    return null;
  }
  return email;
}

/**
 * Check that the sender is the enclave owner.
 * Sends an error message and returns false if not.
 */
async function requireOwner(ctx: CommandContext): Promise<boolean> {
  const info = await fetchEnclaveInfo(ctx);
  if (!info?.owner) {
    await ctx.sendMessage("I couldn't find information about this enclave.");
    return false;
  }

  const senderEmail = await resolveSenderEmail(ctx);
  if (!senderEmail) return false;

  if (senderEmail.toLowerCase() !== info.owner.toLowerCase()) {
    await ctx.sendMessage('Only the enclave owner can add or remove members.');
    return false;
  }

  return true;
}

/**
 * Build a removal confirmation message, including any ownership transfer
 * summary when the removed member owned tentacles.
 */
function buildRemovalMessage(
  displayName: string,
  result: EnclaveSyncResult,
): string {
  const base = `${displayName} has been removed from this enclave.`;
  const transfers = result.transfers ?? [];
  if (transfers.length === 0) return base;

  const succeeded = transfers.filter((t) => t.success).length;
  const failed = transfers.filter((t) => !t.success).length;
  const parts: string[] = [];

  if (succeeded > 0) {
    parts.push(
      `${succeeded} tentacle${succeeded === 1 ? '' : 's'} ${succeeded === 1 ? 'was' : 'were'} transferred to the enclave owner.`,
    );
  }
  if (failed > 0) {
    parts.push(
      `${failed} transfer${failed === 1 ? '' : 's'} failed — the enclave owner should check these manually.`,
    );
  }

  return parts.length > 0 ? `${base} ${parts.join(' ')}` : base;
}

// ---------------------------------------------------------------------------
// Exported handlers
// ---------------------------------------------------------------------------

/**
 * @kraken add @user [as member]
 */
export async function handleAddMember(
  rawArgs: string,
  ctx: CommandContext,
): Promise<void> {
  const isOwner = await requireOwner(ctx);
  if (!isOwner) return;

  const user = await resolveMentionedUser(rawArgs, ctx);
  if (!user) return;

  try {
    await ctx.mcpCall('enclave_sync', {
      name: ctx.enclaveName,
      add_members: [user.email],
    });

    // Cache invalidation is a no-op until Phase 2 authz is wired in.

    logger.info(
      { enclaveName: ctx.enclaveName, added: user.email },
      'command: member added',
    );
    await ctx.sendMessage(
      `${user.email} has been added as a member of this enclave.`,
    );
  } catch (err) {
    logger.error(
      { enclaveName: ctx.enclaveName, user: user.email, err },
      'command: add member failed',
    );
    await ctx.sendMessage(
      'Something went wrong adding that member. Please try again.',
    );
  }
}

/**
 * @kraken remove @user
 */
export async function handleRemoveMember(
  rawArgs: string,
  ctx: CommandContext,
): Promise<void> {
  const isOwner = await requireOwner(ctx);
  if (!isOwner) return;

  const user = await resolveMentionedUser(rawArgs, ctx);
  if (!user) return;

  // Prevent removing the owner
  const info = await fetchEnclaveInfo(ctx);
  if (info?.owner && user.email.toLowerCase() === info.owner.toLowerCase()) {
    await ctx.sendMessage(
      "The enclave owner can't be removed. Transfer ownership first.",
    );
    return;
  }

  try {
    const result = (await ctx.mcpCall('enclave_sync', {
      name: ctx.enclaveName,
      remove_members: [user.email],
    })) as EnclaveSyncResult;

    // Cache invalidation is a no-op until Phase 2 authz is wired in.

    logger.info(
      { enclaveName: ctx.enclaveName, removed: user.email },
      'command: member removed',
    );
    await ctx.sendMessage(buildRemovalMessage(user.email, result));
  } catch (err) {
    logger.error(
      { enclaveName: ctx.enclaveName, user: user.email, err },
      'command: remove member failed',
    );
    await ctx.sendMessage(
      'Something went wrong removing that member. Please try again.',
    );
  }
}

/**
 * @kraken members
 */
export async function handleListMembers(ctx: CommandContext): Promise<void> {
  try {
    const result = (await ctx.mcpCall('enclave_info', {
      name: ctx.enclaveName,
    })) as EnclaveInfo;

    if (!result?.owner) {
      await ctx.sendMessage("I couldn't find information about this enclave.");
      return;
    }

    const lines: string[] = [`*Enclave: #${ctx.enclaveName}*`];
    lines.push(`Owner: ${result.owner}`);

    const members = result.members ?? [];
    if (members.length > 0) {
      lines.push(`Members: ${members.join(', ')}`);
    } else {
      lines.push('Members: (none)');
    }

    // Describe access level in plain language (no mode-bit jargon)
    const mode = result.mode ?? 'rwxrwx---';
    const memberReadBit = mode[3] !== '-';
    const memberWriteBit = mode[4] !== '-';
    const memberExecBit = mode[5] !== '-';

    const capabilities: string[] = [];
    if (memberReadBit) capabilities.push('view information');
    if (memberWriteBit) capabilities.push('make changes');
    if (memberExecBit) capabilities.push('run tasks');

    if (capabilities.length > 0) {
      lines.push(`Access level: members can ${capabilities.join(', ')}`);
    } else {
      lines.push('Access level: members have no access');
    }

    if (result.status === 'frozen') {
      lines.push(
        'Status: This enclave is frozen (no new tasks can be started)',
      );
    }

    await ctx.sendMessage(lines.join('\n'));
  } catch (err) {
    logger.error(
      { enclaveName: ctx.enclaveName, err },
      'command: list members failed',
    );
    await ctx.sendMessage(
      'Something went wrong fetching the member list. Please try again.',
    );
  }
}

/**
 * @kraken whoami
 */
export async function handleWhoami(ctx: CommandContext): Promise<void> {
  try {
    const result = (await ctx.mcpCall('enclave_info', {
      name: ctx.enclaveName,
    })) as EnclaveInfo;

    if (!result?.owner) {
      await ctx.sendMessage(
        `You're in channel *#${ctx.enclaveName}*. I can't find enclave information for this channel — it may not be set up as an enclave yet.`,
      );
      return;
    }

    const senderEmail = await ctx.resolveEmail(ctx.senderSlackId);
    if (!senderEmail) {
      await ctx.sendMessage(
        "I couldn't look up your email. Make sure your Slack profile has an email set.",
      );
      return;
    }

    let role: string;
    if (senderEmail.toLowerCase() === result.owner.toLowerCase()) {
      role = 'the owner';
    } else if ((result.members ?? []).includes(senderEmail)) {
      role = 'a member';
    } else {
      role = 'a visitor';
    }

    logger.debug(
      { enclaveName: ctx.enclaveName, email: senderEmail, role },
      'command: whoami',
    );
    await ctx.sendMessage(
      `You're ${role} of this enclave (${senderEmail}).`,
    );
  } catch (err) {
    logger.error(
      { enclaveName: ctx.enclaveName, err },
      'command: whoami failed',
    );
    await ctx.sendMessage(
      'Something went wrong looking up your role. Please try again.',
    );
  }
}
