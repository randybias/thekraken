/**
 * Tests for Phase 4 Codex fixes (D7).
 *
 * Covers:
 * - D7(b): Mention gate before command parse for bound-channel top-level messages
 * - D7(c): Trailing text rejection in mutating commands (add/remove/transfer)
 * - D7(a): Per-request user-bound mcpCall (tested via router logic)
 *
 * Note: Slack user IDs use only [A-Z0-9] — no underscores.
 * Use IDs like UALICE, UBOB, UBOT in tests (no underscores).
 */
import { describe, it, expect } from 'vitest';
import {
  routeEvent,
  parseCommand,
  type InboundEvent,
  type RouterDeps,
} from '../../src/dispatcher/router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(
  boundChannels: Record<string, string> = {},
  activeTeams: string[] = [],
): RouterDeps {
  return {
    bindings: {
      lookupEnclave: (channelId: string) => {
        const name = boundChannels[channelId];
        if (!name) return null;
        return {
          channelId,
          enclaveName: name,
          ownerSlackId: 'U_OWNER',
          channelName: name,
        };
      },
    },
    teams: { isTeamActive: (name: string) => activeTeams.includes(name) },
  };
}

function makeEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    type: 'message',
    channelId: 'C_BOUND',
    channelType: 'channel',
    userId: 'U_USER',
    text: 'hello',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// D7(b): Mention gate before command parse
// ---------------------------------------------------------------------------

describe('D7(b) — mention gate before command parse in bound channels', () => {
  const deps = makeDeps({ C_BOUND: 'my-enc' });

  it('top-level message "add @alice" without bot mention -> spawn_and_forward (not a command)', () => {
    // The message mentions Alice but not the bot. It passes the mention gate
    // (has an @mention), skips command parse (no bot mention), and forwards
    // to the team as a regular message. D7(b): no command action fires.
    const event = makeEvent({
      type: 'message',
      text: 'add <@UALICE>',
    });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('deterministic');
    if (result.path === 'deterministic') {
      // Command is NOT parsed — should forward to team, NOT enclave_sync_add
      expect(result.action.type).toBe('spawn_and_forward');
      expect(result.action.type).not.toBe('enclave_sync_add');
    }
  });

  it('top-level message "@bot add @alice" with bot mention -> enclave_sync_add', () => {
    const event = makeEvent({
      type: 'app_mention',
      text: '<@UBOT> add <@UALICE>',
    });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('deterministic');
    if (result.path === 'deterministic') {
      expect(result.action.type).toBe('enclave_sync_add');
    }
  });

  it('top-level message "remove @alice" without bot mention -> spawn_and_forward (not a command)', () => {
    // D7(b): message type with no bot mention does not trigger command parse
    const event = makeEvent({
      type: 'message',
      text: 'remove <@UALICE>',
    });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('deterministic');
    if (result.path === 'deterministic') {
      expect(result.action.type).toBe('spawn_and_forward');
      expect(result.action.type).not.toBe('enclave_sync_remove');
    }
  });

  it('thread reply "add @alice" without bot mention passes mention gate (has threadTs)', () => {
    // Thread replies go through without needing @mention (criterion 8)
    const event = makeEvent({
      type: 'message',
      text: 'add <@UALICE>',
      threadTs: '1000.001',
    });
    const result = routeEvent(event, deps);
    // Thread replies in bound channels forward to team, not ignore_no_mention
    expect(result.path).toBe('deterministic');
    if (result.path === 'deterministic') {
      // Should be forward or spawn, not ignore
      expect(result.action.type).not.toBe('ignore_no_mention');
    }
  });
});

// ---------------------------------------------------------------------------
// D7(c): Trailing text rejection in mutating commands
// ---------------------------------------------------------------------------

describe('D7(c) — trailing text rejection in mutating commands', () => {
  it('parseCommand rejects "add @alice extra-text"', () => {
    const result = parseCommand('<@BOT> add <@UALICE> extra-text');
    expect(result).toBeNull();
  });

  it('parseCommand rejects "remove @alice trailing"', () => {
    const result = parseCommand('<@BOT> remove <@UALICE> trailing');
    expect(result).toBeNull();
  });

  it('parseCommand accepts "add @alice @bob" (multiple mentions, no trailing text)', () => {
    const result = parseCommand('<@BOT> add <@UALICE> <@UBOB>');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.type).toBe('enclave_sync_add');
    }
  });

  it('parseCommand accepts filler between mentions', () => {
    const result = parseCommand('<@BOT> add <@UALICE> and <@UBOB>');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.type).toBe('enclave_sync_add');
    }
  });

  it('parseCommand rejects "add @alice and some-other-text"', () => {
    // "and" is a filler, but "some-other-text" is trailing non-mention
    const result = parseCommand('<@BOT> add <@UALICE> and some-other-text');
    expect(result).toBeNull();
  });

  it('parseCommand accepts "remove @alice @bob @charlie"', () => {
    const result = parseCommand('<@BOT> remove <@UALICE> <@UBOB> <@UCHARLIE>');
    expect(result).not.toBeNull();
    if (result && result.type === 'enclave_sync_remove') {
      expect(result.targetUserIds).toHaveLength(3);
    }
  });

  it('parseCommand rejects "transfer @alice with extra"', () => {
    // transfer only allows one mention, extra text should go to smart path
    const result = parseCommand('<@BOT> transfer <@UALICE> with extra');
    // The regex for transfer is strict: ^transfer\s+(?:to\s+)?<@...>$
    // Extra text means no match → null
    expect(result).toBeNull();
  });

  it('parseCommand accepts "archive" (no trailing text)', () => {
    const result = parseCommand('<@BOT> archive');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.type).toBe('enclave_archive');
    }
  });

  it('parseCommand rejects "archive now" (trailing text)', () => {
    const result = parseCommand('<@BOT> archive now');
    expect(result).toBeNull();
  });

  it('parseCommand rejects "delete enclave please" (trailing text)', () => {
    const result = parseCommand('<@BOT> delete enclave please');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Additional routing sanity checks
// ---------------------------------------------------------------------------

describe('routing — D7 regression checks', () => {
  const deps = makeDeps({ C_BOUND: 'my-enc' }, ['my-enc']);

  it('@mention in bound channel with free-form text goes to forward_to_active_team', () => {
    // "help me with this workflow" does not match ^help\s*$ — no command
    const event = makeEvent({
      type: 'app_mention',
      text: '<@UBOT> help me with this workflow',
    });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('deterministic');
    if (result.path === 'deterministic') {
      expect(result.action.type).toBe('forward_to_active_team');
    }
  });

  it('@mention "help" alone routes to enclave_help', () => {
    const event = makeEvent({
      type: 'app_mention',
      text: '<@UBOT> help',
    });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('deterministic');
    if (result.path === 'deterministic') {
      expect(result.action.type).toBe('enclave_help');
    }
  });

  it('DM with "add @alice" does not hit mention gate', () => {
    const event = makeEvent({
      type: 'message',
      channelId: 'D_DM',
      channelType: 'im',
      text: 'add <@UALICE>',
    });
    // Unbound DM — goes to smart path
    const result = routeEvent(event, deps);
    expect(result.path).toBe('smart');
  });
});
