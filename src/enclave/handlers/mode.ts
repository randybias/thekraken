/**
 * @kraken set mode command — updates the enclave access level.
 *
 * Accepts preset names or rwx strings. Depends on enclave_sync supporting
 * new_mode parameter (B1 posix-cleanup). Until that lands, this command
 * is parsed and wired but may fail if MCP doesn't support new_mode yet.
 */

import { logger } from '../../logger.js';
import type { CommandContext } from '../commands.js';

// Mode presets mapping preset name → 9-char rwx string
const MODE_PRESETS: Record<string, string> = {
  private: 'rwx------',
  team: 'rwxrwx---',
  'open-read': 'rwxrwxr--',
  'open-run': 'rwxrwxr-x',
  shared: 'rwxrwxrwx',
};

const MODE_DESCRIPTIONS: Record<string, string> = {
  private: 'private — only the owner has access',
  team: 'team — members can read, write, and run tasks',
  'open-read': 'open-read — visitors can view, members have full access',
  'open-run':
    'open-run — visitors can view and run tasks, members have full access',
  shared: 'shared — everyone can read, write, and run tasks',
};

function isValidRwxString(s: string): boolean {
  return /^[r-][w-][x-][r-][w-][x-][r-][w-][x-]$/.test(s);
}

/**
 * Get enclave owner via MCP call.
 */
async function getEnclaveOwner(ctx: CommandContext): Promise<string | null> {
  try {
    const result = (await ctx.mcpCall('enclave_info', {
      name: ctx.enclaveName,
    })) as { owner?: string };
    return result?.owner ?? null;
  } catch {
    return null;
  }
}

/**
 * @kraken set mode <preset|rwx-string>
 *
 * NOTE: This command depends on enclave_sync supporting the new_mode parameter
 * (B1 posix-cleanup change in tentacular-mcp). Until that lands, calls may fail.
 */
export async function handleSetMode(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  // Check ownership — resolve Slack ID to email first
  const senderEmail = await ctx.resolveEmail(ctx.senderSlackId);
  const owner = await getEnclaveOwner(ctx);

  if (!owner) {
    await ctx.sendMessage("I couldn't find information about this enclave.");
    return;
  }

  if (!senderEmail || senderEmail.toLowerCase() !== owner.toLowerCase()) {
    await ctx.sendMessage('Only the enclave owner can change access settings.');
    return;
  }

  if (args.length === 0) {
    const presetList = Object.keys(MODE_PRESETS)
      .filter((k) => k !== 'shared') // deduplicate alias
      .join(', ');
    await ctx.sendMessage(
      `Please specify an access level. Options: ${presetList}\n` +
        `Example: \`@kraken set mode team\``,
    );
    return;
  }

  const presetOrMode = args.join('-').toLowerCase();
  let modeStr: string;
  let description: string;

  if (MODE_PRESETS[presetOrMode]) {
    modeStr = MODE_PRESETS[presetOrMode];
    description = MODE_DESCRIPTIONS[presetOrMode] ?? presetOrMode;
  } else if (isValidRwxString(presetOrMode)) {
    modeStr = presetOrMode;
    description = presetOrMode;
  } else {
    const presetList = Object.keys(MODE_PRESETS)
      .filter((k) => k !== 'shared')
      .join(', ');
    await ctx.sendMessage(
      `I don't recognize that access level. Valid options: ${presetList}\n` +
        `You can also provide a raw permission string like \`rwxrwx---\`.`,
    );
    return;
  }

  try {
    // NOTE: new_mode parameter requires B1 posix-cleanup in tentacular-mcp
    await ctx.mcpCall('enclave_sync', {
      name: ctx.enclaveName,
      new_mode: modeStr,
    });

    logger.info(
      { enclaveName: ctx.enclaveName, mode: modeStr },
      'command: mode set',
    );
    await ctx.sendMessage(`Enclave access updated to ${description}.`);
  } catch (err) {
    logger.error(
      { enclaveName: ctx.enclaveName, mode: modeStr, err },
      'command: set mode failed',
    );

    // Check if this is because new_mode isn't supported yet
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('new_mode') || errMsg.includes('unknown parameter')) {
      await ctx.sendMessage(
        "Mode changes aren't available yet — this feature requires a server update. Please contact the platform team.",
      );
    } else {
      await ctx.sendMessage(
        'Something went wrong updating the access level. Please try again.',
      );
    }
  }
}
