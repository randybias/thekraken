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
 *   @kraken help
 */

import { logger } from '../logger.js';

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
    /^(add|remove|members|whoami|set\s+mode|show\s+prompts?|help)\s*(.*)/i,
  );

  if (!match) return null;

  const rawCommand = match[1]!.toLowerCase().trim();
  const rawArgs = match[2]!.trim();
  const args = rawArgs.split(/\s+/).filter(Boolean);

  // Normalise command to hyphenated form
  let command = rawCommand.replace(/\s+/g, '-');

  // Singular/plural normalisation: "show prompt" → "show-prompts"
  // The reference router treats "show-prompt" (singular) as a detail view.
  // For Phase 3 we expose the single "show-prompts" command.
  if (command === 'show-prompt') command = 'show-prompts';

  return { command, args, rawArgs };
}

// ---------------------------------------------------------------------------
// Stubs — handlers to be replaced in Phase 3 Tasks 3/4
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
 * Dispatches to the appropriate handler. Handlers are stubs until Phase 3
 * Tasks 3 and 4 replace them.
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
        await stubHandler('add', ctx);
        break;

      case 'remove':
        await stubHandler('remove', ctx);
        break;

      case 'members':
        await stubHandler('members', ctx);
        break;

      case 'whoami':
        await stubHandler('whoami', ctx);
        break;

      case 'set-mode':
        await stubHandler('set mode', ctx);
        break;

      case 'show-prompts':
        await stubHandler('show prompts', ctx);
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
