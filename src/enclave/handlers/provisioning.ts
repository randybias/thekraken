/**
 * Deterministic provisioning handler.
 *
 * @kraken provision [as <name>] [description <desc>]
 *
 * Replaces the LLM-driven provisioning flow in smart-path. Defaults the
 * enclave name to the channel name and the description to the channel topic
 * (or a generic fallback). Validates the name against the enclave-name regex.
 * Calls enclave_provision via MCP and inserts the local binding on success.
 *
 * Spec: docs/superpowers/specs/2026-05-27-deterministic-provisioning-design.md
 */

import { createChildLogger } from '../../logger.js';

const log = createChildLogger({ module: 'provision-handler' });

const ENCLAVE_NAME_RE = /^[a-z0-9-]{1,63}$/;

/**
 * Context required by handleProvision. Passed by the bot.ts unbound-channel
 * branch which has access to the Slack client (for channel info), bindings
 * engine, MCP call function, and kraken-threads db.
 */
export interface ProvisionContext {
  channelId: string;
  channelName: string;
  channelTopic: string;
  senderSlackId: string;
  userEmail: string;
  userSub: string;
  threadTs: string;
  mcpCall: (tool: string, params: Record<string, unknown>) => Promise<unknown>;
  insertBinding: (
    channelId: string,
    enclaveName: string,
    ownerSlackId: string,
  ) => void;
  recordKrakenThread: (channelId: string, threadTs: string) => void;
  lookupEnclave: (channelId: string) => { enclaveName: string } | null;
  sendMessage: (text: string) => Promise<void>;
}

interface ParsedArgs {
  name?: string;
  description?: string;
}

/**
 * Parse the rawArgs from parseCommand for the provision command.
 * Grammar (already validated by parseCommand):
 *   <empty> | `as <name>` | `description <text>` | `as <name> description <text>`
 */
function parseProvisionArgs(rawArgs: string): ParsedArgs {
  const out: ParsedArgs = {};
  const asMatch = rawArgs.match(/^as\s+(\S+)(?:\s+description\s+(.+))?$/i);
  if (asMatch) {
    out.name = asMatch[1];
    if (asMatch[2]) out.description = asMatch[2];
    return out;
  }
  const descMatch = rawArgs.match(/^description\s+(.+)$/i);
  if (descMatch) {
    out.description = descMatch[1];
  }
  return out;
}

export async function handleProvision(
  rawArgs: string,
  ctx: ProvisionContext,
): Promise<void> {
  // Step 1: parse optional overrides
  const overrides = parseProvisionArgs(rawArgs);

  // Step 2: compute defaults
  const name = overrides.name ?? ctx.channelName;
  const description =
    overrides.description ??
    (ctx.channelTopic.trim().length > 0
      ? ctx.channelTopic.trim()
      : `Workflow channel for #${ctx.channelName}`);

  // Step 3: validate name
  if (!ENCLAVE_NAME_RE.test(name)) {
    log.warn(
      { name, channelName: ctx.channelName, channelId: ctx.channelId },
      'provision: invalid enclave name',
    );
    await ctx.sendMessage(
      `\`${name}\` isn't a valid enclave name (must be lowercase letters, digits, hyphens; 1-63 chars). Use \`@kraken provision as my-enclave\` to specify one.`,
    );
    return;
  }

  // Step 4: reject if already bound
  const existing = ctx.lookupEnclave(ctx.channelId);
  if (existing) {
    await ctx.sendMessage(
      `This channel is already enclave \`${existing.enclaveName}\`. Use \`@kraken status\` to see what's there.`,
    );
    return;
  }

  // Step 5: call enclave_provision via MCP.
  // NOTE: the tentacular-mcp `enclave_provision` tool does not (yet) accept
  // a `description` field — its EnclaveProvisionParams struct rejects
  // unknown properties. We still parse `description <text>` from the
  // command for forward compatibility, but it's not yet sent to MCP.
  // Followup: add `description` to the MCP tool schema, then wire it here.
  log.info(
    {
      name,
      description,
      channelId: ctx.channelId,
      channelName: ctx.channelName,
      userEmail: ctx.userEmail,
    },
    'provision: calling enclave_provision',
  );
  try {
    await ctx.mcpCall('enclave_provision', {
      name,
      owner_email: ctx.userEmail,
      owner_sub: ctx.userSub,
      platform: 'slack',
      channel_id: ctx.channelId,
      channel_name: ctx.channelName,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { err, name, channelId: ctx.channelId },
      'provision: enclave_provision failed',
    );
    await ctx.sendMessage(`Provisioning failed: ${msg}`);
    return;
  }

  // Step 6: insert local binding + record kraken thread
  ctx.insertBinding(ctx.channelId, name, ctx.senderSlackId);
  ctx.recordKrakenThread(ctx.channelId, ctx.threadTs);

  // Step 7: reply
  await ctx.sendMessage(
    `Done. Enclave \`${name}\` is live. Anyone in this channel can now @kraken to interact.`,
  );
}
