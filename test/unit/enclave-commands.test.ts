/**
 * Unit tests for @kraken command handlers (Phase 3, T02-T04).
 *
 * All MCP calls are mocked. No real network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleAdd,
  handleRemove,
  handleTransfer,
  executeTransfer,
  handleArchive,
  handleDelete,
  executeDelete,
  handleMembers,
  handleWhoami,
  handleHelp,
  type CommandContext,
  type McpCallFn,
} from '../../src/enclave/commands.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    enclaveName: 'test-enclave',
    channelId: 'C_TEST',
    userId: 'U_OWNER',
    userEmail: 'owner@example.com',
    userToken: 'tok-test',
    userRole: 'owner',
    mcpCall: vi.fn().mockResolvedValue({}),
    resolveEmail: vi.fn().mockResolvedValue('target@example.com'),
    postEphemeral: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleAdd
// ---------------------------------------------------------------------------

describe('handleAdd', () => {
  it('denies non-owners', async () => {
    const ctx = makeCtx({ userRole: 'member' });
    const result = await handleAdd(ctx, ['UTARGET']);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/owner/i);
  });

  it('calls enclave_sync with add_members emails', async () => {
    const ctx = makeCtx();
    (ctx.resolveEmail as ReturnType<typeof vi.fn>).mockResolvedValue(
      'alice@example.com',
    );
    const result = await handleAdd(ctx, ['UALICE']);
    expect(result.ok).toBe(true);
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'enclave_sync',
      expect.objectContaining({
        add_members: ['alice@example.com'],
      }),
    );
  });

  it('adds multiple users', async () => {
    const ctx = makeCtx();
    (ctx.resolveEmail as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('alice@example.com')
      .mockResolvedValueOnce('bob@example.com');
    const result = await handleAdd(ctx, ['UALICE', 'UBOB']);
    expect(result.ok).toBe(true);
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'enclave_sync',
      expect.objectContaining({
        add_members: ['alice@example.com', 'bob@example.com'],
      }),
    );
  });

  it('returns error when email not resolvable', async () => {
    const ctx = makeCtx();
    (ctx.resolveEmail as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const result = await handleAdd(ctx, ['UALICE']);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not resolve/i);
  });

  it('returns error when MCP call fails', async () => {
    const ctx = makeCtx();
    (ctx.mcpCall as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('mcp error'),
    );
    const result = await handleAdd(ctx, ['UALICE']);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/failed to add/i);
  });
});

// ---------------------------------------------------------------------------
// handleRemove
// ---------------------------------------------------------------------------

describe('handleRemove', () => {
  it('denies non-owners', async () => {
    const ctx = makeCtx({ userRole: 'visitor' });
    const result = await handleRemove(ctx, ['UTARGET']);
    expect(result.ok).toBe(false);
  });

  it('calls enclave_sync with remove_members', async () => {
    const ctx = makeCtx();
    (ctx.resolveEmail as ReturnType<typeof vi.fn>).mockResolvedValue(
      'alice@example.com',
    );
    const result = await handleRemove(ctx, ['UALICE']);
    expect(result.ok).toBe(true);
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'enclave_sync',
      expect.objectContaining({
        remove_members: ['alice@example.com'],
      }),
    );
  });

  it('formats transfer report when MCP returns transfers', async () => {
    const ctx = makeCtx();
    (ctx.resolveEmail as ReturnType<typeof vi.fn>).mockResolvedValue(
      'alice@example.com',
    );
    (ctx.mcpCall as ReturnType<typeof vi.fn>).mockResolvedValue({
      transfers: [
        {
          tentacle_name: 'my-wf',
          from_owner: 'alice@example.com',
          to_owner: 'owner@example.com',
          success: true,
        },
      ],
    });
    const result = await handleRemove(ctx, ['UALICE']);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/transferred/i);
  });

  it('reports failed transfers', async () => {
    const ctx = makeCtx();
    (ctx.resolveEmail as ReturnType<typeof vi.fn>).mockResolvedValue(
      'alice@example.com',
    );
    (ctx.mcpCall as ReturnType<typeof vi.fn>).mockResolvedValue({
      transfers: [
        {
          tentacle_name: 'bad-wf',
          from_owner: 'alice@example.com',
          to_owner: 'owner@example.com',
          success: false,
          error: 'not found',
        },
      ],
    });
    const result = await handleRemove(ctx, ['UALICE']);
    expect(result.message).toMatch(/failed/i);
  });
});

// ---------------------------------------------------------------------------
// handleTransfer / executeTransfer
// ---------------------------------------------------------------------------

describe('handleTransfer', () => {
  it('denies non-owners', async () => {
    const ctx = makeCtx({ userRole: 'member' });
    const result = await handleTransfer(ctx, 'UTARGET');
    expect(result.ok).toBe(false);
  });

  it('returns confirmation prompt when owner', async () => {
    const ctx = makeCtx();
    const result = await handleTransfer(ctx, 'UTARGET');
    expect(result.ok).toBe(true);
    expect(result.confirm).toBe(true);
    expect(result.confirmKey).toBe('yes');
    expect(result.message).toMatch(/transfer/i);
  });

  it('returns error when email not resolvable', async () => {
    const ctx = makeCtx();
    (ctx.resolveEmail as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const result = await handleTransfer(ctx, 'UTARGET');
    expect(result.ok).toBe(false);
  });
});

describe('executeTransfer', () => {
  it('calls enclave_sync with transfer_owner', async () => {
    const ctx = makeCtx();
    const result = await executeTransfer(ctx, 'alice@example.com');
    expect(result.ok).toBe(true);
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'enclave_sync',
      expect.objectContaining({
        transfer_owner: 'alice@example.com',
      }),
    );
  });

  it('returns error when MCP fails', async () => {
    const ctx = makeCtx();
    (ctx.mcpCall as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('transfer failed'),
    );
    const result = await executeTransfer(ctx, 'alice@example.com');
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleArchive
// ---------------------------------------------------------------------------

describe('handleArchive', () => {
  it('denies non-owners', async () => {
    const ctx = makeCtx({ userRole: 'member' });
    const result = await handleArchive(ctx);
    expect(result.ok).toBe(false);
  });

  it('freezes enclave and calls wf_remove per tentacle', async () => {
    const ctx = makeCtx();
    (ctx.mcpCall as ReturnType<typeof vi.fn>).mockImplementation(
      async (tool: string) => {
        if (tool === 'enclave_sync') return {};
        if (tool === 'enclave_info') return { tentacles: ['wf-a', 'wf-b'] };
        if (tool === 'wf_remove') return {};
        return {};
      },
    );

    const result = await handleArchive(ctx);
    expect(result.ok).toBe(true);
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'enclave_sync',
      expect.objectContaining({ status: 'frozen' }),
    );
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'wf_remove',
      expect.objectContaining({ name: 'wf-a' }),
    );
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'wf_remove',
      expect.objectContaining({ name: 'wf-b' }),
    );
  });

  it('returns ok even when no tentacles', async () => {
    const ctx = makeCtx();
    (ctx.mcpCall as ReturnType<typeof vi.fn>).mockImplementation(
      async (tool: string) => {
        if (tool === 'enclave_info') return { tentacles: [] };
        return {};
      },
    );
    const result = await handleArchive(ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/no running tentacles/i);
  });

  it('returns error when freeze fails', async () => {
    const ctx = makeCtx();
    (ctx.mcpCall as ReturnType<typeof vi.fn>).mockImplementation(
      async (tool: string) => {
        if (tool === 'enclave_sync') throw new Error('mcp error');
        return {};
      },
    );
    const result = await handleArchive(ctx);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleDelete / executeDelete
// ---------------------------------------------------------------------------

describe('handleDelete', () => {
  it('denies non-owners', async () => {
    const ctx = makeCtx({ userRole: 'visitor' });
    const result = await handleDelete(ctx);
    expect(result.ok).toBe(false);
  });

  it('returns confirmation prompt for owners', async () => {
    const ctx = makeCtx();
    const result = await handleDelete(ctx);
    expect(result.ok).toBe(true);
    expect(result.confirm).toBe(true);
    expect(result.confirmKey).toBe('DELETE');
    expect(result.message).toMatch(/permanently delete/i);
  });
});

describe('executeDelete', () => {
  it('calls enclave_deprovision', async () => {
    const ctx = makeCtx();
    const result = await executeDelete(ctx);
    expect(result.ok).toBe(true);
    expect(ctx.mcpCall).toHaveBeenCalledWith('enclave_deprovision', {
      name: 'test-enclave',
    });
  });

  it('returns error when MCP fails', async () => {
    const ctx = makeCtx();
    (ctx.mcpCall as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('deprovision failed'),
    );
    const result = await executeDelete(ctx);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleMembers
// ---------------------------------------------------------------------------

describe('handleMembers', () => {
  it('returns members list for owner', async () => {
    const ctx = makeCtx();
    (ctx.mcpCall as ReturnType<typeof vi.fn>).mockResolvedValue({
      owner: 'owner@example.com',
      members: ['alice@example.com', 'bob@example.com'],
      status: 'active',
    });
    const result = await handleMembers(ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/owner@example.com/);
    expect(result.message).toMatch(/alice@example.com/);
  });

  it('returns members list for member role', async () => {
    const ctx = makeCtx({ userRole: 'member' });
    (ctx.mcpCall as ReturnType<typeof vi.fn>).mockResolvedValue({
      owner: 'owner@example.com',
      members: [],
      status: 'active',
    });
    const result = await handleMembers(ctx);
    expect(result.ok).toBe(true);
  });

  it('denies visitors', async () => {
    const ctx = makeCtx({ userRole: 'visitor' });
    const result = await handleMembers(ctx);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleWhoami
// ---------------------------------------------------------------------------

describe('handleWhoami', () => {
  it('shows owner role', async () => {
    const ctx = makeCtx({ userRole: 'owner', userEmail: 'boss@example.com' });
    const result = await handleWhoami(ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/boss@example.com/);
    expect(result.message).toMatch(/owner/);
  });

  it('shows member role', async () => {
    const ctx = makeCtx({
      userRole: 'member',
      userEmail: 'member@example.com',
    });
    const result = await handleWhoami(ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/member/);
  });

  it('shows visitor role', async () => {
    const ctx = makeCtx({
      userRole: 'visitor',
      userEmail: 'visitor@example.com',
    });
    const result = await handleWhoami(ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/visitor/);
  });
});

// ---------------------------------------------------------------------------
// handleHelp
// ---------------------------------------------------------------------------

describe('handleHelp', () => {
  it('returns static help text', () => {
    const result = handleHelp();
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/@kraken commands/i);
    expect(result.message).toMatch(/add/);
    expect(result.message).toMatch(/remove/);
    expect(result.message).toMatch(/transfer/);
    expect(result.message).toMatch(/archive/);
    expect(result.message).toMatch(/delete/);
    expect(result.message).toMatch(/members/);
    expect(result.message).toMatch(/whoami/);
    expect(result.message).toMatch(/help/);
  });
});
