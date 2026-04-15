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

  it('detects singular "show prompt" as show-prompt (detail view command)', () => {
    const result = parseCommand('@kraken show prompt my-wf');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('show-prompt');
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
// executeCommand — stub handlers (commands not yet implemented)
// ---------------------------------------------------------------------------

describe('executeCommand — remaining stub handlers', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    ctx = makeCtx();
  });

  it('sends help message listing available commands', async () => {
    const parsed = parseCommand('@kraken help')!;
    await executeCommand(parsed, ctx);
    expect(ctx.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Available commands'),
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

// ---------------------------------------------------------------------------
// membership handlers
// ---------------------------------------------------------------------------

describe('membership handlers', () => {
  // Owner Slack ID: U_OWNER, email: owner@example.com
  // Alice Slack ID: U_ALICE, email: alice@example.com

  function makeOwnerCtx(
    mcpImpl?: (
      tool: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>,
  ): CommandContext {
    return makeCtx({
      senderSlackId: 'U_OWNER',
      resolveEmail: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'U_OWNER') return 'owner@example.com';
        if (id === 'U_ALICE') return 'alice@example.com';
        return undefined;
      }),
      mcpCall: mcpImpl
        ? vi.fn().mockImplementation(mcpImpl)
        : vi.fn().mockImplementation(async (tool: string) => {
            if (tool === 'enclave_info') {
              return {
                owner: 'owner@example.com',
                members: ['alice@example.com'],
                mode: 'rwxrwx---',
                status: 'active',
              };
            }
            return {};
          }),
    });
  }

  function makeMemberCtx(): CommandContext {
    return makeCtx({
      senderSlackId: 'U_ALICE',
      resolveEmail: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'U_OWNER') return 'owner@example.com';
        if (id === 'U_ALICE') return 'alice@example.com';
        return undefined;
      }),
      mcpCall: vi.fn().mockImplementation(async (tool: string) => {
        if (tool === 'enclave_info') {
          return {
            owner: 'owner@example.com',
            members: ['alice@example.com'],
            mode: 'rwxrwx---',
            status: 'active',
          };
        }
        return {};
      }),
    });
  }

  describe('add', () => {
    it('calls enclave_sync with add_members when owner adds a user', async () => {
      const ctx = makeOwnerCtx();
      const parsed = parseCommand('@kraken add <@U_ALICE>')!;
      await executeCommand(parsed, ctx);
      expect(ctx.mcpCall).toHaveBeenCalledWith('enclave_sync', {
        name: 'test-enclave',
        add_members: ['alice@example.com'],
      });
      expect(ctx.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('alice@example.com'),
      );
    });

    it('denies add for non-owner', async () => {
      const ctx = makeMemberCtx();
      const parsed = parseCommand('@kraken add <@U_OWNER>')!;
      await executeCommand(parsed, ctx);
      expect(ctx.mcpCall).not.toHaveBeenCalledWith(
        'enclave_sync',
        expect.anything(),
      );
      expect(ctx.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('Only the enclave owner'),
      );
    });
  });

  describe('remove', () => {
    it('calls enclave_sync with remove_members when owner removes a member', async () => {
      const ctx = makeOwnerCtx();
      const parsed = parseCommand('@kraken remove <@U_ALICE>')!;
      await executeCommand(parsed, ctx);
      expect(ctx.mcpCall).toHaveBeenCalledWith('enclave_sync', {
        name: 'test-enclave',
        remove_members: ['alice@example.com'],
      });
      expect(ctx.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('alice@example.com'),
      );
    });

    it('prevents removing the owner', async () => {
      const ctx = makeOwnerCtx();
      const parsed = parseCommand('@kraken remove <@U_OWNER>')!;
      await executeCommand(parsed, ctx);
      expect(ctx.mcpCall).not.toHaveBeenCalledWith(
        'enclave_sync',
        expect.anything(),
      );
      expect(ctx.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("can't be removed"),
      );
    });
  });

  describe('members', () => {
    it('lists owner and members from enclave_info', async () => {
      const ctx = makeOwnerCtx();
      const parsed = parseCommand('@kraken members')!;
      await executeCommand(parsed, ctx);
      expect(ctx.mcpCall).toHaveBeenCalledWith('enclave_info', {
        name: 'test-enclave',
      });
      const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as string;
      expect(msg).toContain('owner@example.com');
      expect(msg).toContain('alice@example.com');
    });
  });

  describe('whoami', () => {
    it('identifies sender as owner', async () => {
      const ctx = makeOwnerCtx();
      const parsed = parseCommand('@kraken whoami')!;
      await executeCommand(parsed, ctx);
      const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as string;
      expect(msg).toContain('the owner');
    });

    it('identifies sender as member', async () => {
      const ctx = makeMemberCtx();
      const parsed = parseCommand('@kraken whoami')!;
      await executeCommand(parsed, ctx);
      const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as string;
      expect(msg).toContain('a member');
    });

    it('identifies sender as visitor', async () => {
      const ctx = makeCtx({
        senderSlackId: 'U_STRANGER',
        resolveEmail: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'U_STRANGER') return 'stranger@example.com';
          return undefined;
        }),
        mcpCall: vi.fn().mockResolvedValue({
          owner: 'owner@example.com',
          members: ['alice@example.com'],
        }),
      });
      const parsed = parseCommand('@kraken whoami')!;
      await executeCommand(parsed, ctx);
      const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as string;
      expect(msg).toContain('a visitor');
    });
  });
});
