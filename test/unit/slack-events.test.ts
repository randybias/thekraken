/**
 * Unit tests for Slack channel event handlers (Phase 3, T06).
 *
 * All MCP calls and Slack API calls are mocked. Bolt app is stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerChannelEvents,
  type ChannelEventDeps,
} from '../../src/slack/events.js';

// ---------------------------------------------------------------------------
// Minimal Bolt App stub
// ---------------------------------------------------------------------------

type EventHandler = (args: Record<string, unknown>) => Promise<void>;

function makeBoltApp() {
  const handlers: Record<string, EventHandler> = {};
  return {
    event: (name: string, handler: EventHandler) => {
      handlers[name] = handler;
    },
    _trigger: (name: string, args: Record<string, unknown>) => {
      const h = handlers[name];
      if (!h) throw new Error(`No handler for ${name}`);
      return h(args);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<ChannelEventDeps> = {}): ChannelEventDeps {
  return {
    bindings: {
      lookupEnclave: (channelId: string) => {
        if (channelId === 'C_BOUND') {
          return {
            channelId: 'C_BOUND',
            enclaveName: 'my-enclave',
            ownerSlackId: 'U_OWNER',
            channelName: 'my-channel',
          };
        }
        return null;
      },
    },
    mcpCall: vi.fn().mockResolvedValue({
      owner: 'owner@example.com',
      members: ['alice@example.com'],
      tentacles: ['wf-a'],
    }),
    botUserId: 'UBOT',
    resolveEmail: vi.fn().mockImplementation(async (slackId: string) => {
      if (slackId === 'UALICE') return 'alice@example.com';
      if (slackId === 'UOWNER') return 'owner@example.com';
      return undefined;
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// member_joined_channel
// ---------------------------------------------------------------------------

describe('registerChannelEvents — member_joined_channel', () => {
  it('ignores bot self-events', async () => {
    const app = makeBoltApp();
    const deps = makeDeps();
    registerChannelEvents(app as any, deps);

    await app._trigger('member_joined_channel', {
      event: { user: 'UBOT', channel: 'C_BOUND' },
    });
    expect(deps.mcpCall).not.toHaveBeenCalled();
  });

  it('ignores unbound channels', async () => {
    const app = makeBoltApp();
    const deps = makeDeps();
    registerChannelEvents(app as any, deps);

    await app._trigger('member_joined_channel', {
      event: { user: 'UALICE', channel: 'C_UNBOUND' },
    });
    expect(deps.mcpCall).not.toHaveBeenCalled();
  });

  it('logs visitor join but takes no MCP action', async () => {
    const app = makeBoltApp();
    const deps = makeDeps();
    registerChannelEvents(app as any, deps);

    await app._trigger('member_joined_channel', {
      event: { user: 'UALICE', channel: 'C_BOUND' },
    });
    // No MCP calls — joining channel does NOT add to enclave
    expect(deps.mcpCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// member_left_channel
// ---------------------------------------------------------------------------

describe('registerChannelEvents — member_left_channel', () => {
  it('ignores bot self-events', async () => {
    const app = makeBoltApp();
    const deps = makeDeps();
    registerChannelEvents(app as any, deps);

    await app._trigger('member_left_channel', {
      event: { user: 'UBOT', channel: 'C_BOUND' },
    });
    expect(deps.mcpCall).not.toHaveBeenCalled();
  });

  it('ignores unbound channels', async () => {
    const app = makeBoltApp();
    const deps = makeDeps();
    registerChannelEvents(app as any, deps);

    await app._trigger('member_left_channel', {
      event: { user: 'UALICE', channel: 'C_UNBOUND' },
    });
    expect(deps.mcpCall).not.toHaveBeenCalled();
  });

  it('removes member from enclave when they leave a bound channel', async () => {
    const app = makeBoltApp();
    const deps = makeDeps({
      mcpCall: vi
        .fn()
        .mockResolvedValueOnce({
          owner: 'owner@example.com',
          members: ['alice@example.com'],
        })
        .mockResolvedValue({}),
    });
    registerChannelEvents(app as any, deps);

    await app._trigger('member_left_channel', {
      event: { user: 'UALICE', channel: 'C_BOUND' },
    });

    expect(deps.mcpCall).toHaveBeenCalledWith(
      'enclave_sync',
      expect.objectContaining({
        remove_members: ['alice@example.com'],
      }),
    );
  });

  it('does NOT remove owner when they leave', async () => {
    const app = makeBoltApp();
    const deps = makeDeps({
      mcpCall: vi.fn().mockResolvedValue({
        owner: 'owner@example.com',
        members: [],
      }),
    });
    registerChannelEvents(app as any, deps);

    await app._trigger('member_left_channel', {
      event: { user: 'UOWNER', channel: 'C_BOUND' },
    });
    expect(deps.mcpCall).not.toHaveBeenCalledWith(
      'enclave_sync',
      expect.anything(),
    );
  });

  it('does nothing when departed user was a visitor (not in members)', async () => {
    const app = makeBoltApp();
    const deps = makeDeps({
      mcpCall: vi.fn().mockResolvedValue({
        owner: 'owner@example.com',
        members: [], // alice is not a member
      }),
    });
    registerChannelEvents(app as any, deps);

    await app._trigger('member_left_channel', {
      event: { user: 'UALICE', channel: 'C_BOUND' },
    });
    expect(deps.mcpCall).not.toHaveBeenCalledWith(
      'enclave_sync',
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// channel_archive
// ---------------------------------------------------------------------------

describe('registerChannelEvents — channel_archive', () => {
  it('freezes enclave and dehydrates tentacles', async () => {
    const app = makeBoltApp();
    const deps = makeDeps();
    registerChannelEvents(app as any, deps);

    await app._trigger('channel_archive', { event: { channel: 'C_BOUND' } });

    expect(deps.mcpCall).toHaveBeenCalledWith(
      'enclave_sync',
      expect.objectContaining({ status: 'frozen' }),
    );
    expect(deps.mcpCall).toHaveBeenCalledWith(
      'wf_remove',
      expect.objectContaining({ name: 'wf-a' }),
    );
  });

  it('ignores unbound channels', async () => {
    const app = makeBoltApp();
    const deps = makeDeps();
    registerChannelEvents(app as any, deps);

    await app._trigger('channel_archive', { event: { channel: 'C_UNBOUND' } });
    expect(deps.mcpCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// channel_unarchive
// ---------------------------------------------------------------------------

describe('registerChannelEvents — channel_unarchive', () => {
  it('activates enclave (no auto-rehydrate)', async () => {
    const app = makeBoltApp();
    const deps = makeDeps();
    registerChannelEvents(app as any, deps);

    await app._trigger('channel_unarchive', { event: { channel: 'C_BOUND' } });

    expect(deps.mcpCall).toHaveBeenCalledWith(
      'enclave_sync',
      expect.objectContaining({ status: 'active' }),
    );
    // wf_remove or wf_apply should NOT be called (no auto-rehydrate)
    expect(deps.mcpCall).not.toHaveBeenCalledWith(
      'wf_apply',
      expect.anything(),
    );
  });

  it('ignores unbound channels', async () => {
    const app = makeBoltApp();
    const deps = makeDeps();
    registerChannelEvents(app as any, deps);

    await app._trigger('channel_unarchive', {
      event: { channel: 'C_UNBOUND' },
    });
    expect(deps.mcpCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// channel_rename
// ---------------------------------------------------------------------------

describe('registerChannelEvents — channel_rename', () => {
  it('syncs new channel name', async () => {
    const app = makeBoltApp();
    const deps = makeDeps();
    registerChannelEvents(app as any, deps);

    await app._trigger('channel_rename', {
      event: { channel: { id: 'C_BOUND', name: 'new-name' } },
    });

    expect(deps.mcpCall).toHaveBeenCalledWith(
      'enclave_sync',
      expect.objectContaining({
        new_channel_name: 'new-name',
      }),
    );
  });

  it('ignores unbound channels', async () => {
    const app = makeBoltApp();
    const deps = makeDeps();
    registerChannelEvents(app as any, deps);

    await app._trigger('channel_rename', {
      event: { channel: { id: 'C_UNBOUND', name: 'new-name' } },
    });
    expect(deps.mcpCall).not.toHaveBeenCalled();
  });
});
