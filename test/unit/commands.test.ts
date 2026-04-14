/**
 * Unit tests for the @kraken command parser (src/enclave/commands.ts).
 *
 * Tests cover parseCommand() only — handlers are stubs until Phase 3 Tasks 3/4.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseCommand,
  executeCommand,
  type CommandContext,
} from '../../src/enclave/commands.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    channelId: 'C123',
    threadTs: undefined,
    senderSlackId: 'U_OWNER',
    enclaveName: 'test-enclave',
    mcpCall: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    resolveEmail: vi.fn().mockResolvedValue('alice@example.com'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseCommand — command detection
// ---------------------------------------------------------------------------

describe('parseCommand — add command', () => {
  it('detects "@kraken add @user" as add command', () => {
    const result = parseCommand('@kraken add <@UALICE>');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('add');
  });

  it('detects "<@BOTID> add @user" as add command', () => {
    const result = parseCommand('<@UBOT123> add <@UALICE>');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('add');
  });

  it('includes target user in rawArgs for add', () => {
    const result = parseCommand('@kraken add <@UALICE>');
    expect(result!.rawArgs).toBe('<@UALICE>');
  });
});

describe('parseCommand — remove command', () => {
  it('detects "@kraken remove @user" as remove command', () => {
    const result = parseCommand('@kraken remove <@UALICE>');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('remove');
  });

  it('detects "<@BOTID> remove @user" as remove command', () => {
    const result = parseCommand('<@UBOT123> remove <@UALICE>');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('remove');
  });
});

describe('parseCommand — members command', () => {
  it('detects "@kraken members" as members command', () => {
    const result = parseCommand('@kraken members');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('members');
  });

  it('detects "<@BOTID> members" as members command', () => {
    const result = parseCommand('<@UBOT456> members');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('members');
  });
});

describe('parseCommand — whoami command', () => {
  it('detects "@kraken whoami" as whoami command', () => {
    const result = parseCommand('@kraken whoami');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('whoami');
  });

  it('detects "<@BOTID> whoami" as whoami command', () => {
    const result = parseCommand('<@UBOT456> whoami');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('whoami');
  });
});

describe('parseCommand — set mode command', () => {
  it('detects "@kraken set mode team" as set-mode command', () => {
    const result = parseCommand('@kraken set mode team');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('set-mode');
    expect(result!.args).toEqual(['team']);
  });

  it('detects "<@BOTID> set mode private" as set-mode command', () => {
    const result = parseCommand('<@UBOT123> set mode private');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('set-mode');
    expect(result!.args).toEqual(['private']);
  });
});

describe('parseCommand — show prompts command', () => {
  it('detects "@kraken show prompts" as show-prompts command', () => {
    const result = parseCommand('@kraken show prompts');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('show-prompts');
  });

  it('detects "show prompts" with optional workflow arg', () => {
    const result = parseCommand('@kraken show prompts my-workflow');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('show-prompts');
    expect(result!.args).toEqual(['my-workflow']);
  });

  it('detects singular "show prompt" and normalises to show-prompts', () => {
    const result = parseCommand('@kraken show prompt my-wf');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('show-prompts');
  });
});

describe('parseCommand — help command', () => {
  it('detects "@kraken help" as help command', () => {
    const result = parseCommand('@kraken help');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('help');
  });

  it('detects "<@BOTID> help" as help command', () => {
    const result = parseCommand('<@UBOT123> help');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('help');
  });
});

// ---------------------------------------------------------------------------
// parseCommand — non-command text returns null
// ---------------------------------------------------------------------------

describe('parseCommand — non-command text', () => {
  it('returns null for plain text conversation', () => {
    expect(parseCommand("hey kraken what's up")).toBeNull();
  });

  it('returns null for text without @kraken prefix', () => {
    expect(parseCommand('deploy my workflow')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseCommand('')).toBeNull();
  });

  it('returns null for unrecognised command after @mention', () => {
    // "frobnicate" is not a known command
    expect(parseCommand('@kraken frobnicate')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseCommand — case-insensitive matching
// ---------------------------------------------------------------------------

describe('parseCommand — case-insensitive', () => {
  it('handles "@Kraken ADD @user" (mixed case)', () => {
    const result = parseCommand('@Kraken ADD <@UALICE>');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('add');
  });

  it('handles "<@BOTID> WHOAMI"', () => {
    const result = parseCommand('<@UBOT> WHOAMI');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('whoami');
  });

  it('handles "@KRAKEN MEMBERS"', () => {
    const result = parseCommand('@KRAKEN MEMBERS');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('members');
  });
});

// ---------------------------------------------------------------------------
// parseCommand — <@BOT_ID> Slack mention format
// ---------------------------------------------------------------------------

describe('parseCommand — Slack mention format', () => {
  it('handles <@U123ABC> prefix (typical Slack format)', () => {
    const result = parseCommand('<@U123ABC> whoami');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('whoami');
  });

  it('does NOT treat user @-mentions in args as the bot prefix', () => {
    // The first mention is the bot, the second is a user arg
    const result = parseCommand('<@UBOT> add <@UABC>');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('add');
    // The user mention should be preserved in rawArgs
    expect(result!.rawArgs).toContain('<@UABC>');
  });
});

// ---------------------------------------------------------------------------
// executeCommand — stubs send placeholder messages
// ---------------------------------------------------------------------------

describe('executeCommand — stub handlers', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    ctx = makeCtx();
  });

  it('sends a stub message for add command', async () => {
    const parsed = parseCommand('@kraken add <@UALICE>')!;
    await executeCommand(parsed, ctx);
    expect(ctx.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Phase 3'),
    );
  });

  it('sends a stub message for members command', async () => {
    const parsed = parseCommand('@kraken members')!;
    await executeCommand(parsed, ctx);
    expect(ctx.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Phase 3'),
    );
  });

  it('sends a stub message for whoami command', async () => {
    const parsed = parseCommand('@kraken whoami')!;
    await executeCommand(parsed, ctx);
    expect(ctx.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Phase 3'),
    );
  });

  it('sends a stub message for help command', async () => {
    const parsed = parseCommand('@kraken help')!;
    await executeCommand(parsed, ctx);
    expect(ctx.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Phase 3'),
    );
  });

  it('sends an unrecognised-command message for unknown commands', async () => {
    const fakeCommand = {
      command: 'unknown-xyz',
      args: [],
      rawArgs: '',
    };
    await executeCommand(fakeCommand, ctx);
    expect(ctx.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("don't recognise"),
    );
  });
});
