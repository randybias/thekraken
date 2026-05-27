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
