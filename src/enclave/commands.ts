/**
 * @kraken command parser and dispatcher.
 *
 * Recognized commands:
 *   @kraken add @user [as member]
 *   @kraken remove @user
 *   @kraken members
 *   @kraken whoami
 *   @kraken set mode <preset>
 *   @kraken show prompts [workflow]
 *   @kraken show prompt <workflow> <name>
 *   @kraken show templates [workflow]
 *   @kraken show template <workflow> <name>
 *   @kraken help
 */

import { logger } from '../logger.js';
import {
  handleAddMember,
  handleRemoveMember,
  handleListMembers,
  handleWhoami,
} from './handlers/membership.js';
import { handleSetMode } from './handlers/mode.js';
import {
  handleShowPrompts,
  handleShowPrompt,
  handleShowTemplates,
  handleShowTemplate,
} from './handlers/prompts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandContext {
  channelId: string;
  threadTs?: string;
  senderSlackId: string;
  enclaveName: string;
  mcpCall: (tool: string, params: Record<string, unknown>) => Promise<unknown>;
  sendMessage: (text: string) => Promise<void>;
  resolveEmail: (userId: string) => Promise<string | undefined>;
}

export interface ParsedCommand {
  command: string;
  args: string[];
  rawArgs: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a @kraken command from message text.
 *
 * Handles both direct mention (@kraken) and bot mention (<@BOTID>) formats.
 * Returns null for non-command text (natural conversation, etc.).
 */
export function parseCommand(
  text: string,
  botUserId?: string,
): ParsedCommand | null {
  const trimmed = text.trim();

  // Check if it starts with a bot @mention or @kraken text
  const isBotMention =
    /^<@[A-Z0-9_]+>/i.test(trimmed) || /^@kraken\b/i.test(trimmed);
  if (!isBotMention) return null;

  // Strip ONLY the leading bot mention prefix (not subsequent user @mentions)
  const cleaned = trimmed
    .replace(/^<@[A-Z0-9_]+>\s*/i, '') // strip <@BOTID> mention
    .replace(/^@kraken\s*/i, '') // strip @kraken text prefix
    .trim();

  if (!cleaned) return null;

  // Match against known command patterns
  const match = cleaned.match(
    /^(add|remove|members|whoami|set\s+mode|show\s+prompts|show\s+prompt|show\s+templates|show\s+template|help)\s*(.*)/i,
  );

  if (!match) return null;

  const rawCommand = match[1]!.toLowerCase().trim();
  const rawArgs = match[2]!.trim();
  const args = rawArgs.split(/\s+/).filter(Boolean);

  // Normalise command to hyphenated form
  const command = rawCommand.replace(/\s+/g, '-');

  return { command, args, rawArgs };
}

// ---------------------------------------------------------------------------
// Stubs — handlers for commands not yet fully implemented
// ---------------------------------------------------------------------------

async function stubHandler(
  commandName: string,
  ctx: CommandContext,
): Promise<void> {
  await ctx.sendMessage(
    `\`${commandName}\` is coming in Phase 3 Task 3/4. Stay tuned!`,
  );
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Execute a parsed @kraken command against the given context.
 *
 * Dispatches to the appropriate handler.
 */
export async function executeCommand(
  parsed: ParsedCommand,
  ctx: CommandContext,
): Promise<void> {
  logger.info(
    {
      command: parsed.command,
      enclaveName: ctx.enclaveName,
      sender: ctx.senderSlackId,
    },
    'commands: dispatching',
  );

  try {
    switch (parsed.command) {
      case 'add':
        await handleAddMember(parsed.rawArgs, ctx);
        break;

      case 'remove':
        await handleRemoveMember(parsed.rawArgs, ctx);
        break;

      case 'members':
        await handleListMembers(ctx);
        break;

      case 'whoami':
        await handleWhoami(ctx);
        break;

      case 'set-mode':
        await handleSetMode(parsed.args, ctx);
        break;

      case 'show-prompts':
        await handleShowPrompts(parsed.args, ctx);
        break;

      case 'show-prompt':
        await handleShowPrompt(parsed.args, ctx);
        break;

      case 'show-templates':
        await handleShowTemplates(parsed.args, ctx);
        break;

      case 'show-template':
        await handleShowTemplate(parsed.args, ctx);
        break;

      case 'help':
        await stubHandler('help', ctx);
        break;

      default:
        logger.debug(
          { command: parsed.command },
          'commands: unrecognized command',
        );
        await ctx.sendMessage(
          `I don't recognise that command. Try \`@kraken help\` for a list of available commands.`,
        );
    }
  } catch (err) {
    logger.error({ command: parsed.command, err }, 'commands: unhandled error');
    await ctx.sendMessage(
      'Something went wrong processing your command. Please try again.',
    );
  }
}
