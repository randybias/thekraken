import { describe, it, expect, vi } from 'vitest';
import { handleProvision } from '../../../../src/enclave/handlers/provisioning.js';
import type { ProvisionContext } from '../../../../src/enclave/handlers/provisioning.js';

function mkCtx(overrides: Partial<ProvisionContext> = {}): ProvisionContext & {
  _sent: string[];
} {
  const sent: string[] = [];
  const base: ProvisionContext = {
    channelId: 'C123',
    channelName: 'voyager-agentic-flows',
    channelTopic: '',
    senderSlackId: 'U_ALICE',
    userEmail: 'alice@example.com',
    userSub: 'KEYCLOAK-SUB-1',
    threadTs: 'T1',
    mcpCall: vi.fn(async () => ({ name: 'voyager-agentic-flows' })),
    insertBinding: vi.fn(),
    recordKrakenThread: vi.fn(),
    lookupEnclave: vi.fn(() => null),
    sendMessage: vi.fn(async (text: string) => {
      sent.push(text);
    }),
  };
  return Object.assign({}, base, overrides, {
    _sent: sent,
  }) as ProvisionContext & {
    _sent: string[];
  };
}

describe('handleProvision: defaults', () => {
  it('uses channel name as enclave name when no args', async () => {
    const ctx = mkCtx();
    await handleProvision('', ctx);
    expect(ctx.mcpCall).toHaveBeenCalledWith('enclave_provision', {
      name: 'voyager-agentic-flows',
      description: 'Workflow channel for #voyager-agentic-flows',
      owner_email: 'alice@example.com',
      owner_sub: 'KEYCLOAK-SUB-1',
      platform: 'slack',
      channel_id: 'C123',
      channel_name: 'voyager-agentic-flows',
    });
    expect(ctx.insertBinding).toHaveBeenCalledWith(
      'C123',
      'voyager-agentic-flows',
      'U_ALICE',
    );
    expect(ctx.recordKrakenThread).toHaveBeenCalledWith('C123', 'T1');
    expect(ctx._sent[0]).toMatch(
      /Done\. Enclave `voyager-agentic-flows` is live/,
    );
  });

  it('uses channel topic as description when present', async () => {
    const ctx = mkCtx({ channelTopic: 'Voyager group workflows' });
    await handleProvision('', ctx);
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'enclave_provision',
      expect.objectContaining({ description: 'Voyager group workflows' }),
    );
  });

  it('trims whitespace from channel topic before using', async () => {
    const ctx = mkCtx({ channelTopic: '   Padded topic   ' });
    await handleProvision('', ctx);
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'enclave_provision',
      expect.objectContaining({ description: 'Padded topic' }),
    );
  });
});

describe('handleProvision: overrides', () => {
  it('uses `as <name>` to override the enclave name', async () => {
    const ctx = mkCtx();
    await handleProvision('as my-custom-name', ctx);
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'enclave_provision',
      expect.objectContaining({ name: 'my-custom-name' }),
    );
    expect(ctx.insertBinding).toHaveBeenCalledWith(
      'C123',
      'my-custom-name',
      'U_ALICE',
    );
  });

  it('uses `description <text>` to override the description', async () => {
    const ctx = mkCtx();
    await handleProvision('description Custom description here', ctx);
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'enclave_provision',
      expect.objectContaining({
        description: 'Custom description here',
        name: 'voyager-agentic-flows',
      }),
    );
  });

  it('uses both overrides when provided together', async () => {
    const ctx = mkCtx();
    await handleProvision('as foo description Bar baz quux', ctx);
    expect(ctx.mcpCall).toHaveBeenCalledWith(
      'enclave_provision',
      expect.objectContaining({
        name: 'foo',
        description: 'Bar baz quux',
      }),
    );
  });
});

describe('handleProvision: validation', () => {
  it('rejects channel-name default that fails enclave-name regex', async () => {
    const ctx = mkCtx({ channelName: 'BadName_WithStuff' });
    await handleProvision('', ctx);
    expect(ctx.mcpCall).not.toHaveBeenCalled();
    expect(ctx.insertBinding).not.toHaveBeenCalled();
    expect(ctx.recordKrakenThread).not.toHaveBeenCalled();
    expect(ctx._sent[0]).toMatch(
      /`BadName_WithStuff` isn't a valid enclave name/,
    );
  });

  it('rejects explicit name that fails regex', async () => {
    const ctx = mkCtx();
    await handleProvision('as Has_Underscores', ctx);
    expect(ctx.mcpCall).not.toHaveBeenCalled();
    expect(ctx._sent[0]).toMatch(/isn't a valid enclave name/);
  });
});

describe('handleProvision: already bound', () => {
  it('refuses when channel is already an enclave', async () => {
    const ctx = mkCtx({
      lookupEnclave: vi.fn(() => ({ enclaveName: 'existing' })),
    });
    await handleProvision('', ctx);
    expect(ctx.mcpCall).not.toHaveBeenCalled();
    expect(ctx.insertBinding).not.toHaveBeenCalled();
    expect(ctx.recordKrakenThread).not.toHaveBeenCalled();
    expect(ctx._sent[0]).toMatch(/already enclave `existing`/);
  });
});

describe('handleProvision: MCP error', () => {
  it('echoes MCP failure message verbatim, no side effects', async () => {
    const ctx = mkCtx({
      mcpCall: vi.fn(async () => {
        throw new Error('forbidden: owner_sub empty');
      }),
    });
    await handleProvision('', ctx);
    expect(ctx.insertBinding).not.toHaveBeenCalled();
    expect(ctx.recordKrakenThread).not.toHaveBeenCalled();
    expect(ctx._sent[0]).toBe('Provisioning failed: forbidden: owner_sub empty');
  });
});
