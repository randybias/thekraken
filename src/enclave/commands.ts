/**
 * @kraken command handlers (Phase 3).
 *
 * Each handler performs a deterministic operation against the MCP server
 * using the commanding user's OIDC token (D6). All handlers post ephemeral
 * responses that are only visible to the commanding user.
 *
 * Owner-only commands: add, remove, transfer, archive, delete.
 * Member commands: members, whoami.
 * Public: help.
 */

import type { Role } from './authz.js';
import { invalidateCache } from './authz.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Typed MCP call function — carries the user's OIDC token implicitly. */
export type McpCallFn = (
  tool: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/** Context passed to every command handler. */
export interface CommandContext {
  enclaveName: string;
  channelId: string;
  userId: string;
  userEmail: string;
  userToken: string;
  userRole: Role;
  mcpCall: McpCallFn;
  resolveEmail: (slackId: string) => Promise<string | undefined>;
  postEphemeral: (text: string) => Promise<void>;
}

/** Result returned by a command handler. */
export interface CommandResult {
  ok: boolean;
  message: string;
  /** If true, bot should prompt for confirmation before executing. */
  confirm?: boolean;
  /** The string the user must reply with to confirm (e.g. "yes" or "DELETE"). */
  confirmKey?: string;
  /** Human-readable transfer report (populated by remove). */
  transfers?: string;
}

/** Shape of a successful enclave_sync response from MCP. */
export interface EnclaveSyncResult {
  updated?: string[];
  transfers?: Array<{
    tentacle_name: string;
    from_owner: string;
    to_owner: string;
    success: boolean;
    error?: string;
  }>;
}

/** Shape of enclave_info from MCP. */
interface EnclaveInfoResult {
  owner: string;
  members: string[];
  status: string;
  name: string;
  mode: string;
  tentacles?: string[];
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Return a denial result for non-owners. */
function ownerOnly(): CommandResult {
  return {
    ok: false,
    message: 'Only the enclave owner can run this command.',
  };
}

// ---------------------------------------------------------------------------
// Transfer report formatter
// ---------------------------------------------------------------------------

/**
 * Format a human-readable ownership transfer report.
 *
 * Ported from the reference implementation pattern.
 */
function formatOwnershipTransferReport(
  transfers: EnclaveSyncResult['transfers'],
): string {
  if (!transfers || transfers.length === 0) return '';

  const succeeded = transfers.filter((t) => t.success);
  const failed = transfers.filter((t) => !t.success);

  const lines: string[] = [];
  if (succeeded.length > 0) {
    lines.push(
      `Transferred ${succeeded.length} tentacle(s) to the enclave owner.`,
    );
  }
  if (failed.length > 0) {
    lines.push(`${failed.length} transfer(s) failed:`);
    for (const t of failed) {
      lines.push(`  - ${t.tentacle_name}: ${t.error ?? 'unknown error'}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Membership handlers
// ---------------------------------------------------------------------------

/**
 * Add one or more members to the enclave.
 * Owner-only. Resolves Slack IDs to emails before calling enclave_sync.
 */
export async function handleAdd(
  ctx: CommandContext,
  targetUserIds: string[],
): Promise<CommandResult> {
  if (ctx.userRole !== 'owner') return ownerOnly();

  const emails: string[] = [];
  const unresolved: string[] = [];

  for (const slackId of targetUserIds) {
    const email = await ctx.resolveEmail(slackId);
    if (email) {
      emails.push(email);
    } else {
      unresolved.push(slackId);
    }
  }

  if (emails.length === 0) {
    return {
      ok: false,
      message:
        'Could not resolve any of the mentioned users to an email address. Make sure they have a Slack profile with an email.',
    };
  }

  try {
    await ctx.mcpCall('enclave_sync', {
      name: ctx.enclaveName,
      add_members: emails,
    });

    invalidateCache(ctx.enclaveName);

    const addedList = emails.join(', ');
    const msg =
      unresolved.length > 0
        ? `Added ${addedList} to the enclave. Could not resolve: ${unresolved.join(', ')}.`
        : `Added ${addedList} to the enclave.`;

    return { ok: true, message: msg };
  } catch (err) {
    return {
      ok: false,
      message: `Failed to add members: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Remove one or more members from the enclave.
 * Owner-only. Returns a transfer report if tentacles were re-assigned.
 */
export async function handleRemove(
  ctx: CommandContext,
  targetUserIds: string[],
): Promise<CommandResult> {
  if (ctx.userRole !== 'owner') return ownerOnly();

  const emails: string[] = [];
  const unresolved: string[] = [];

  for (const slackId of targetUserIds) {
    const email = await ctx.resolveEmail(slackId);
    if (email) {
      emails.push(email);
    } else {
      unresolved.push(slackId);
    }
  }

  if (emails.length === 0) {
    return {
      ok: false,
      message:
        'Could not resolve any of the mentioned users to an email address.',
    };
  }

  try {
    const raw = (await ctx.mcpCall('enclave_sync', {
      name: ctx.enclaveName,
      remove_members: emails,
    })) as EnclaveSyncResult | undefined;

    invalidateCache(ctx.enclaveName);

    const report = formatOwnershipTransferReport(raw?.transfers);
    const removedList = emails.join(', ');
    const base = `Removed ${removedList} from the enclave.`;
    const msg = report ? `${base}\n${report}` : base;

    return { ok: true, message: msg, transfers: report || undefined };
  } catch (err) {
    return {
      ok: false,
      message: `Failed to remove members: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Initiate an enclave ownership transfer.
 * Owner-only. Returns a confirmation prompt — caller must handle the
 * double-confirmation flow and call executeTransfer() on "yes".
 */
export async function handleTransfer(
  ctx: CommandContext,
  targetUserId: string,
): Promise<CommandResult> {
  if (ctx.userRole !== 'owner') return ownerOnly();

  const targetEmail = await ctx.resolveEmail(targetUserId);
  if (!targetEmail) {
    return {
      ok: false,
      message: 'Could not resolve that user to an email address.',
    };
  }

  return {
    ok: true,
    message: `Transfer ownership of *${ctx.enclaveName}* to *${targetEmail}*? Reply *yes* to confirm. This cannot be undone.`,
    confirm: true,
    confirmKey: 'yes',
  };
}

/**
 * Execute the confirmed ownership transfer.
 * Called after the user replies "yes" to the transfer confirmation.
 */
export async function executeTransfer(
  ctx: CommandContext,
  targetEmail: string,
): Promise<CommandResult> {
  try {
    await ctx.mcpCall('enclave_sync', {
      name: ctx.enclaveName,
      transfer_owner: targetEmail,
    });

    invalidateCache(ctx.enclaveName);

    return {
      ok: true,
      message: `Ownership of *${ctx.enclaveName}* has been transferred to *${targetEmail}*. You are now a member.`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Transfer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Lifecycle handlers
// ---------------------------------------------------------------------------

/**
 * Archive (freeze) the enclave and dehydrate all tentacles via wf_remove.
 * Owner-only.
 */
export async function handleArchive(
  ctx: CommandContext,
): Promise<CommandResult> {
  if (ctx.userRole !== 'owner') return ownerOnly();

  // Step 1: Freeze enclave
  try {
    await ctx.mcpCall('enclave_sync', {
      name: ctx.enclaveName,
      status: 'frozen',
    });
  } catch (err) {
    return {
      ok: false,
      message: `Failed to freeze enclave: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 2: Dehydrate tentacles via wf_remove
  let tentacles: string[] = [];
  try {
    const info = (await ctx.mcpCall('enclave_info', {
      name: ctx.enclaveName,
    })) as EnclaveInfoResult | undefined;
    tentacles = info?.tentacles ?? [];
  } catch {
    // Non-fatal: we still froze the enclave
  }

  let removed = 0;
  let removeErrors = 0;
  for (const tentacle of tentacles) {
    try {
      await ctx.mcpCall('wf_remove', {
        name: tentacle,
        namespace: ctx.enclaveName,
      });
      removed++;
    } catch {
      removeErrors++;
    }
  }

  invalidateCache(ctx.enclaveName);

  const parts: string[] = [`Enclave *${ctx.enclaveName}* has been frozen.`];
  if (tentacles.length > 0) {
    parts.push(
      `Removed ${removed} of ${tentacles.length} tentacle(s) from the cluster.`,
    );
    if (removeErrors > 0) {
      parts.push(
        `${removeErrors} removal(s) failed — tentacle source is preserved in git.`,
      );
    }
  } else {
    parts.push('No running tentacles to remove.');
  }
  parts.push(
    'To reactivate, use `@kraken unarchive` (tentacles must be redeployed manually).',
  );

  return { ok: true, message: parts.join('\n') };
}

/**
 * Initiate enclave deletion with double-confirmation.
 * Owner-only. Returns confirmation prompt — caller handles "DELETE" reply.
 */
export async function handleDelete(
  ctx: CommandContext,
): Promise<CommandResult> {
  if (ctx.userRole !== 'owner') return ownerOnly();

  return {
    ok: true,
    message: `You are about to *permanently delete* the enclave *${ctx.enclaveName}*. This cannot be undone.\n\nReply *DELETE* (all caps) to confirm.`,
    confirm: true,
    confirmKey: 'DELETE',
  };
}

/**
 * Execute confirmed enclave deletion.
 * Called after the user replies "DELETE" to the deletion confirmation.
 */
export async function executeDelete(
  ctx: CommandContext,
): Promise<CommandResult> {
  try {
    await ctx.mcpCall('enclave_deprovision', { name: ctx.enclaveName });
    invalidateCache(ctx.enclaveName);
    return {
      ok: true,
      message: `Enclave *${ctx.enclaveName}* has been permanently deleted.`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Deletion failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Info handlers
// ---------------------------------------------------------------------------

/**
 * List the owner and members of the enclave.
 * Available to owners and members.
 */
export async function handleMembers(
  ctx: CommandContext,
): Promise<CommandResult> {
  if (ctx.userRole === 'visitor') {
    return {
      ok: false,
      message: "You're not a member of this enclave.",
    };
  }

  try {
    const info = (await ctx.mcpCall('enclave_info', {
      name: ctx.enclaveName,
    })) as EnclaveInfoResult | undefined;

    if (!info) {
      return { ok: false, message: 'Could not retrieve enclave information.' };
    }

    const lines: string[] = [`*${ctx.enclaveName}* members:`];
    lines.push(`  Owner: ${info.owner}`);
    if (info.members && info.members.length > 0) {
      lines.push(`  Members: ${info.members.join(', ')}`);
    } else {
      lines.push('  Members: (none)');
    }

    return { ok: true, message: lines.join('\n') };
  } catch (err) {
    return {
      ok: false,
      message: `Could not retrieve members: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Show the commanding user's email and role in this enclave.
 * Available to all authenticated users.
 */
export async function handleWhoami(
  ctx: CommandContext,
): Promise<CommandResult> {
  const roleLabel =
    ctx.userRole === 'owner'
      ? 'owner'
      : ctx.userRole === 'member'
        ? 'member'
        : 'visitor';

  return {
    ok: true,
    message: `You are *${ctx.userEmail}* — ${roleLabel} of *${ctx.enclaveName}*.`,
  };
}

/**
 * Return the static help text listing all available @kraken commands.
 * Available to everyone (no auth required).
 */
export function handleHelp(): CommandResult {
  const helpText = `*@kraken commands:*

*Membership*
  \`@kraken add @user [@user2 ...]\` — Add one or more people to this enclave
  \`@kraken remove @user [@user2 ...]\` — Remove one or more people from this enclave
  \`@kraken transfer to @user\` — Transfer enclave ownership to someone else

*Enclave lifecycle*
  \`@kraken archive\` — Freeze this enclave and shut down all running services
  \`@kraken delete enclave\` — Permanently delete this enclave (requires confirmation)

*Information*
  \`@kraken members\` — Show who's in this enclave
  \`@kraken whoami\` — Show your email and role in this enclave
  \`@kraken help\` — Show this help

_Membership and lifecycle commands require you to be the enclave owner._`;

  return { ok: true, message: helpText };
}
