/**
 * Unit tests for mode and prompts/templates command handlers.
 *
 * Tests cover:
 *   - handleSetMode (src/enclave/handlers/mode.ts)
 *   - handleShowPrompts, handleShowPrompt (src/enclave/handlers/prompts.ts)
 *   - handleShowTemplates, handleShowTemplate (src/enclave/handlers/prompts.ts)
 *   - Parser recognition of show-templates, show-template, show-prompt
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
    resolveEmail: vi.fn().mockResolvedValue('owner@example.com'),
    ...overrides,
  };
}

/** Owner context with enclave_info returning owner@example.com. */
function makeOwnerCtx(
  mcpImpl?: (tool: string, params: Record<string, unknown>) => Promise<unknown>,
): CommandContext {
  return makeCtx({
    senderSlackId: 'U_OWNER',
    resolveEmail: vi.fn().mockImplementation(async (id: string) => {
      if (id === 'U_OWNER') return 'owner@example.com';
      return undefined;
    }),
    mcpCall: mcpImpl
      ? vi.fn().mockImplementation(mcpImpl)
      : vi.fn().mockImplementation(async (tool: string) => {
          if (tool === 'enclave_info') {
            return { owner: 'owner@example.com', members: [] };
          }
          return {};
        }),
  });
}

/** Non-owner context. */
function makeNonOwnerCtx(): CommandContext {
  return makeCtx({
    senderSlackId: 'U_ALICE',
    resolveEmail: vi.fn().mockImplementation(async (id: string) => {
      if (id === 'U_ALICE') return 'alice@example.com';
      return undefined;
    }),
    mcpCall: vi.fn().mockImplementation(async (tool: string) => {
      if (tool === 'enclave_info') {
        return { owner: 'owner@example.com', members: ['alice@example.com'] };
      }
      return {};
    }),
  });
}

// ---------------------------------------------------------------------------
// Parser — show-templates and show-template recognition
// ---------------------------------------------------------------------------

describe('parseCommand — show templates commands', () => {
  it('detects "@kraken show templates" as show-templates command', () => {
    const result = parseCommand('@kraken show templates');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('show-templates');
  });

  it('detects "show templates <workflow>" with optional workflow arg', () => {
    const result = parseCommand('@kraken show templates my-workflow');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('show-templates');
    expect(result!.args).toEqual(['my-workflow']);
  });

  it('detects singular "show template" as show-template (detail view)', () => {
    const result = parseCommand('@kraken show template my-wf tmpl-name');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('show-template');
    expect(result!.args).toEqual(['my-wf', 'tmpl-name']);
  });
});

describe('parseCommand — show-prompt detail view', () => {
  it('detects "show prompt <workflow> <name>" as show-prompt command', () => {
    const result = parseCommand('@kraken show prompt my-wf main-prompt');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('show-prompt');
    expect(result!.args).toEqual(['my-wf', 'main-prompt']);
  });
});

// ---------------------------------------------------------------------------
// set mode handler
// ---------------------------------------------------------------------------

describe('set mode handler', () => {
  it('calls enclave_sync with rwxrwx--- for "team" preset', async () => {
    const ctx = makeOwnerCtx();
    const parsed = parseCommand('@kraken set mode team')!;
    await executeCommand(parsed, ctx);

    expect(ctx.mcpCall).toHaveBeenCalledWith('enclave_sync', {
      name: 'test-enclave',
      new_mode: 'rwxrwx---',
    });
    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain('team');
  });

  it('calls enclave_sync with rwx------ for "private" preset', async () => {
    const ctx = makeOwnerCtx();
    const parsed = parseCommand('@kraken set mode private')!;
    await executeCommand(parsed, ctx);

    expect(ctx.mcpCall).toHaveBeenCalledWith('enclave_sync', {
      name: 'test-enclave',
      new_mode: 'rwx------',
    });
  });

  it('calls enclave_sync with rwxrwxr-- for "open-read" preset', async () => {
    const ctx = makeOwnerCtx();
    const parsed = parseCommand('@kraken set mode open-read')!;
    await executeCommand(parsed, ctx);

    expect(ctx.mcpCall).toHaveBeenCalledWith('enclave_sync', {
      name: 'test-enclave',
      new_mode: 'rwxrwxr--',
    });
  });

  it('calls enclave_sync with rwxrwxr-x for "open-run" preset', async () => {
    const ctx = makeOwnerCtx();
    const parsed = parseCommand('@kraken set mode open-run')!;
    await executeCommand(parsed, ctx);

    expect(ctx.mcpCall).toHaveBeenCalledWith('enclave_sync', {
      name: 'test-enclave',
      new_mode: 'rwxrwxr-x',
    });
  });

  it('calls enclave_sync with rwxrwxrwx for "shared" preset', async () => {
    const ctx = makeOwnerCtx();
    const parsed = parseCommand('@kraken set mode shared')!;
    await executeCommand(parsed, ctx);

    expect(ctx.mcpCall).toHaveBeenCalledWith('enclave_sync', {
      name: 'test-enclave',
      new_mode: 'rwxrwxrwx',
    });
    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(msg).toContain('shared');
  });

  it('passes through a raw rwx string', async () => {
    const ctx = makeOwnerCtx();
    // Use executeCommand directly with a fake parsed to avoid parser limits
    const parsed = {
      command: 'set-mode',
      args: ['rwxr--r--'],
      rawArgs: 'rwxr--r--',
    };
    await executeCommand(parsed, ctx);

    expect(ctx.mcpCall).toHaveBeenCalledWith('enclave_sync', {
      name: 'test-enclave',
      new_mode: 'rwxr--r--',
    });
  });

  it('denies set mode for non-owner', async () => {
    const ctx = makeNonOwnerCtx();
    const parsed = { command: 'set-mode', args: ['team'], rawArgs: 'team' };
    await executeCommand(parsed, ctx);

    expect(ctx.mcpCall).not.toHaveBeenCalledWith(
      'enclave_sync',
      expect.anything(),
    );
    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain('owner');
  });

  it('reports error message for unknown preset', async () => {
    const ctx = makeOwnerCtx();
    const parsed = {
      command: 'set-mode',
      args: ['supermode'],
      rawArgs: 'supermode',
    };
    await executeCommand(parsed, ctx);

    expect(ctx.mcpCall).not.toHaveBeenCalledWith(
      'enclave_sync',
      expect.anything(),
    );
    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain("don't recognize");
  });

  it('sends usage hint when no mode argument given', async () => {
    const ctx = makeOwnerCtx();
    const parsed = { command: 'set-mode', args: [], rawArgs: '' };
    await executeCommand(parsed, ctx);

    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain('Please specify');
  });
});

// ---------------------------------------------------------------------------
// show prompts handler
// ---------------------------------------------------------------------------

describe('show prompts handler', () => {
  it('calls wf_list then wf_describe for each workflow', async () => {
    const ctx = makeCtx({
      mcpCall: vi.fn().mockImplementation(async (tool: string) => {
        if (tool === 'wf_list') {
          return { workflows: [{ name: 'wf-a' }, { name: 'wf-b' }] };
        }
        if (tool === 'wf_describe') {
          return {
            prompts: [{ name: 'main', node: 'llm-node', model: 'claude' }],
          };
        }
        return {};
      }),
    });

    const parsed = { command: 'show-prompts', args: [], rawArgs: '' };
    await executeCommand(parsed, ctx);

    expect(ctx.mcpCall).toHaveBeenCalledWith('wf_list', {
      enclave: 'test-enclave',
    });
    expect(ctx.mcpCall).toHaveBeenCalledWith('wf_describe', {
      enclave: 'test-enclave',
      name: 'wf-a',
    });
    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain('wf-a');
  });

  it('returns message when no workflows found', async () => {
    const ctx = makeCtx({
      mcpCall: vi.fn().mockResolvedValue({ workflows: [] }),
    });

    const parsed = { command: 'show-prompts', args: [], rawArgs: '' };
    await executeCommand(parsed, ctx);

    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain('No workflows');
  });

  it('calls wf_describe for a specific workflow when arg provided', async () => {
    const ctx = makeCtx({
      mcpCall: vi.fn().mockImplementation(async (tool: string) => {
        if (tool === 'wf_describe') {
          return {
            prompts: [
              { name: 'analyzer', node: 'llm1' },
              { name: 'formatter', node: 'llm2' },
            ],
          };
        }
        return {};
      }),
    });

    const parsed = {
      command: 'show-prompts',
      args: ['my-workflow'],
      rawArgs: 'my-workflow',
    };
    await executeCommand(parsed, ctx);

    expect(ctx.mcpCall).toHaveBeenCalledWith('wf_describe', {
      enclave: 'test-enclave',
      name: 'my-workflow',
    });
    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain('analyzer');
    expect(msg).toContain('formatter');
  });
});

// ---------------------------------------------------------------------------
// show prompt (detail) handler
// ---------------------------------------------------------------------------

describe('show prompt handler', () => {
  it('finds and displays a named prompt with system and user template', async () => {
    const ctx = makeCtx({
      mcpCall: vi.fn().mockImplementation(async (tool: string) => {
        if (tool === 'wf_describe') {
          return {
            prompts: [
              {
                name: 'main-prompt',
                node: 'llm-node',
                model: 'claude-3-5',
                system_prompt: 'You are a helpful assistant.',
                user_prompt_template: 'Process: {{input}}',
              },
            ],
          };
        }
        return {};
      }),
    });

    const parsed = {
      command: 'show-prompt',
      args: ['my-wf', 'main-prompt'],
      rawArgs: 'my-wf main-prompt',
    };
    await executeCommand(parsed, ctx);

    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain('main-prompt');
    expect(msg).toContain('You are a helpful assistant.');
    expect(msg).toContain('Process: {{input}}');
  });

  it('sends usage hint when fewer than 2 args given', async () => {
    const ctx = makeCtx();
    const parsed = {
      command: 'show-prompt',
      args: ['only-one'],
      rawArgs: 'only-one',
    };
    await executeCommand(parsed, ctx);

    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain('Usage:');
  });

  it('reports not-found when prompt name does not match', async () => {
    const ctx = makeCtx({
      mcpCall: vi.fn().mockImplementation(async (tool: string) => {
        if (tool === 'wf_describe') {
          return {
            prompts: [{ name: 'other-prompt', node: 'n1' }],
          };
        }
        return {};
      }),
    });

    const parsed = {
      command: 'show-prompt',
      args: ['my-wf', 'missing-prompt'],
      rawArgs: 'my-wf missing-prompt',
    };
    await executeCommand(parsed, ctx);

    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain('missing-prompt');
    expect(msg).toContain('other-prompt'); // shows available
  });
});

// ---------------------------------------------------------------------------
// show templates handler
// ---------------------------------------------------------------------------

describe('show templates handler', () => {
  it('calls wf_list then wf_describe for each workflow', async () => {
    const ctx = makeCtx({
      mcpCall: vi.fn().mockImplementation(async (tool: string) => {
        if (tool === 'wf_list') {
          return { workflows: [{ name: 'wf-x' }] };
        }
        if (tool === 'wf_describe') {
          return {
            templates: [
              { name: 'report', node: 'formatter', format: 'markdown' },
            ],
          };
        }
        return {};
      }),
    });

    const parsed = { command: 'show-templates', args: [], rawArgs: '' };
    await executeCommand(parsed, ctx);

    expect(ctx.mcpCall).toHaveBeenCalledWith('wf_list', {
      enclave: 'test-enclave',
    });
    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain('wf-x');
    expect(msg).toContain('1 template');
  });

  it('displays templates for a specific workflow', async () => {
    const ctx = makeCtx({
      mcpCall: vi.fn().mockImplementation(async (tool: string) => {
        if (tool === 'wf_describe') {
          return {
            templates: [{ name: 'summary', node: 'out-node', format: 'json' }],
          };
        }
        return {};
      }),
    });

    const parsed = {
      command: 'show-templates',
      args: ['my-wf'],
      rawArgs: 'my-wf',
    };
    await executeCommand(parsed, ctx);

    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain('summary');
    expect(msg).toContain('json');
  });
});

// ---------------------------------------------------------------------------
// show template (detail) handler
// ---------------------------------------------------------------------------

describe('show template handler', () => {
  it('displays a named template with format and text', async () => {
    const ctx = makeCtx({
      mcpCall: vi.fn().mockImplementation(async (tool: string) => {
        if (tool === 'wf_describe') {
          return {
            templates: [
              {
                name: 'report-tmpl',
                node: 'out-node',
                format: 'markdown',
                template: '# {{title}}\n{{body}}',
              },
            ],
          };
        }
        return {};
      }),
    });

    const parsed = {
      command: 'show-template',
      args: ['my-wf', 'report-tmpl'],
      rawArgs: 'my-wf report-tmpl',
    };
    await executeCommand(parsed, ctx);

    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain('report-tmpl');
    expect(msg).toContain('markdown');
    expect(msg).toContain('# {{title}}');
  });

  it('sends usage hint when fewer than 2 args given', async () => {
    const ctx = makeCtx();
    const parsed = {
      command: 'show-template',
      args: ['only-one'],
      rawArgs: 'only-one',
    };
    await executeCommand(parsed, ctx);

    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain('Usage:');
  });

  it('truncates template text at 3000 chars', async () => {
    const longTemplate = 'x'.repeat(4000);
    const ctx = makeCtx({
      mcpCall: vi.fn().mockImplementation(async (tool: string) => {
        if (tool === 'wf_describe') {
          return {
            templates: [
              {
                name: 'big-tmpl',
                node: 'n1',
                template: longTemplate,
              },
            ],
          };
        }
        return {};
      }),
    });

    const parsed = {
      command: 'show-template',
      args: ['wf', 'big-tmpl'],
      rawArgs: 'wf big-tmpl',
    };
    await executeCommand(parsed, ctx);

    const msg = (ctx.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain('...(truncated)');
    // Should not contain the full 4000 chars
    expect(msg.length).toBeLessThan(4000);
  });
});
