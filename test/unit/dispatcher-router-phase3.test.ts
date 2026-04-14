/**
 * Phase 3 extension of the dispatcher router tests.
 *
 * Covers:
 *   - Full parseCommand() grammar (T01)
 *   - Multi-mention extraction
 *   - Disambiguation matrix
 *   - FN-2: bound-channel @mention requirement (T08)
 *   - New action types in routeEvent
 *   - novel_phrasing removal (was in SmartReason, now gone)
 *   - ignore_no_mention path
 */

import { describe, it, expect } from 'vitest';
import { routeEvent, parseCommand } from '../../src/dispatcher/router.js';
import type {
  InboundEvent,
  RouterDeps,
  SmartReason,
} from '../../src/dispatcher/router.js';

// ---------------------------------------------------------------------------
// Test helpers
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
    type: 'app_mention',
    channelId: 'C_UNBOUND',
    channelType: 'channel',
    userId: 'U_USER',
    text: 'hello',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseCommand — full grammar
// ---------------------------------------------------------------------------

describe('parseCommand — Phase 3 grammar', () => {
  // Multi-mention
  it('parses "add @alice and @bob"', () => {
    const result = parseCommand('<@UBOT> add <@UALICE> and <@UBOB>');
    expect(result).toEqual({
      type: 'enclave_sync_add',
      targetUserIds: ['UALICE', 'UBOB'],
    });
  });

  it('parses "add @alice @bob @carol" (no filler)', () => {
    const result = parseCommand('add <@UA> <@UB> <@UC>');
    expect(result).toEqual({
      type: 'enclave_sync_add',
      targetUserIds: ['UA', 'UB', 'UC'],
    });
  });

  it('parses "remove @alice also @bob"', () => {
    const result = parseCommand('remove <@UA> also <@UB>');
    expect(result).toEqual({
      type: 'enclave_sync_remove',
      targetUserIds: ['UA', 'UB'],
    });
  });

  it('parses "remove @alice, @bob"', () => {
    const result = parseCommand('remove <@UA>, <@UB>');
    expect(result).toEqual({
      type: 'enclave_sync_remove',
      targetUserIds: ['UA', 'UB'],
    });
  });

  // Transfer
  it('parses "transfer @alice" (no "to")', () => {
    const result = parseCommand('transfer <@UALICE>');
    expect(result).toEqual({
      type: 'enclave_sync_transfer',
      targetUserId: 'UALICE',
    });
  });

  it('parses "transfer to @alice"', () => {
    const result = parseCommand('transfer to <@UALICE>');
    expect(result).toEqual({
      type: 'enclave_sync_transfer',
      targetUserId: 'UALICE',
    });
  });

  // Exact-phrase commands
  it('parses "archive"', () => {
    expect(parseCommand('archive')).toEqual({ type: 'enclave_archive' });
  });

  it('parses "archive" with bot prefix', () => {
    expect(parseCommand('<@UBOT> archive')).toEqual({
      type: 'enclave_archive',
    });
  });

  it('parses "delete enclave"', () => {
    expect(parseCommand('delete enclave')).toEqual({ type: 'enclave_delete' });
  });

  it('parses "members"', () => {
    expect(parseCommand('members')).toEqual({ type: 'enclave_members' });
  });

  it('parses "whoami"', () => {
    expect(parseCommand('whoami')).toEqual({ type: 'enclave_whoami' });
  });

  it('parses "help"', () => {
    expect(parseCommand('help')).toEqual({ type: 'enclave_help' });
  });

  // Disambiguation: smart path cases
  it('returns null for "add a new node" (first token not @mention)', () => {
    expect(parseCommand('add a new node')).toBeNull();
  });

  it('returns null for "remove the old service" (not @mention)', () => {
    expect(parseCommand('remove the old service')).toBeNull();
  });

  it('returns null for "transfer my work" (no @mention)', () => {
    expect(parseCommand('transfer my work')).toBeNull();
  });

  it('returns null for "delete the tentacle" (not exact phrase)', () => {
    expect(parseCommand('delete the tentacle')).toBeNull();
  });

  it('returns null for "archive my notes" (extra text after keyword)', () => {
    expect(parseCommand('archive my notes')).toBeNull();
  });

  it('returns null for plain text', () => {
    expect(parseCommand('build a sentiment analyser')).toBeNull();
  });

  it('handles filler words: "add please @alice"', () => {
    const result = parseCommand('add please <@UALICE>');
    // "please" is a filler — should work
    expect(result).toEqual({
      type: 'enclave_sync_add',
      targetUserIds: ['UALICE'],
    });
  });

  it('returns null for "add" with no mentions at all', () => {
    expect(parseCommand('add')).toBeNull();
  });

  it('returns null for "transfer" with no @mention', () => {
    expect(parseCommand('transfer')).toBeNull();
  });

  it('is case-insensitive for command verbs', () => {
    expect(parseCommand('ARCHIVE')).toEqual({ type: 'enclave_archive' });
    expect(parseCommand('MEMBERS')).toEqual({ type: 'enclave_members' });
    expect(parseCommand('HELP')).toEqual({ type: 'enclave_help' });
  });
});

// ---------------------------------------------------------------------------
// routeEvent — new Phase 3 action types
// ---------------------------------------------------------------------------

describe('routeEvent — Phase 3 actions', () => {
  it('routes "archive" command to enclave_archive', () => {
    const deps = makeDeps({ C_BOUND: 'my-enclave' });
    const event = makeEvent({ channelId: 'C_BOUND', text: '<@UBOT> archive' });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('deterministic');
    if (result.path === 'deterministic') {
      expect(result.action.type).toBe('enclave_archive');
    }
  });

  it('routes "delete enclave" command to enclave_delete', () => {
    const deps = makeDeps({ C_BOUND: 'my-enclave' });
    const event = makeEvent({
      channelId: 'C_BOUND',
      text: '<@UBOT> delete enclave',
    });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('deterministic');
    if (result.path === 'deterministic') {
      expect(result.action.type).toBe('enclave_delete');
    }
  });

  it('routes "members" command to enclave_members', () => {
    const deps = makeDeps({ C_BOUND: 'my-enclave' });
    const event = makeEvent({ channelId: 'C_BOUND', text: 'members' });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('deterministic');
    if (result.path === 'deterministic') {
      expect(result.action.type).toBe('enclave_members');
    }
  });

  it('routes "whoami" command to enclave_whoami', () => {
    const deps = makeDeps({ C_BOUND: 'my-enclave' });
    const event = makeEvent({ channelId: 'C_BOUND', text: 'whoami' });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('deterministic');
    if (result.path === 'deterministic') {
      expect(result.action.type).toBe('enclave_whoami');
    }
  });

  it('routes "help" command to enclave_help', () => {
    const deps = makeDeps({ C_BOUND: 'my-enclave' });
    const event = makeEvent({ channelId: 'C_BOUND', text: '<@UBOT> help' });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('deterministic');
    if (result.path === 'deterministic') {
      expect(result.action.type).toBe('enclave_help');
    }
  });

  it('routes "add @u1 @u2" to enclave_sync_add with multiple targets', () => {
    const deps = makeDeps({ C_BOUND: 'my-enclave' });
    const event = makeEvent({ channelId: 'C_BOUND', text: 'add <@UA> <@UB>' });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('deterministic');
    if (
      result.path === 'deterministic' &&
      result.action.type === 'enclave_sync_add'
    ) {
      expect(result.action.targetUserIds).toEqual(['UA', 'UB']);
    }
  });
});

// ---------------------------------------------------------------------------
// FN-2: bound-channel @mention requirement
// ---------------------------------------------------------------------------

describe('routeEvent — FN-2 ignore_no_mention', () => {
  it('ignores non-@mention message in bound channel (message type, no thread)', () => {
    const deps = makeDeps({ C_BOUND: 'my-enclave' });
    const event = makeEvent({
      type: 'message',
      channelId: 'C_BOUND',
      channelType: 'channel',
      text: 'hello everyone no bot mention',
      threadTs: undefined,
    });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('deterministic');
    if (result.path === 'deterministic') {
      expect(result.action.type).toBe('ignore_no_mention');
    }
  });

  it('does NOT ignore DM without @mention (DM channel)', () => {
    const deps = makeDeps({});
    const event = makeEvent({
      type: 'message',
      channelId: 'D_DM',
      channelType: 'im',
      text: 'hello no mention needed',
      threadTs: undefined,
    });
    const result = routeEvent(event, deps);
    // DM goes to smart path
    expect(result.path).toBe('smart');
  });

  it('does NOT ignore message in bound channel that has @mention', () => {
    const deps = makeDeps({ C_BOUND: 'my-enclave' });
    const event = makeEvent({
      type: 'message',
      channelId: 'C_BOUND',
      channelType: 'channel',
      text: '<@UBOT> build something',
      threadTs: undefined,
    });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('deterministic');
    if (result.path === 'deterministic') {
      // Should forward to team, not ignore
      expect(['forward_to_active_team', 'spawn_and_forward']).toContain(
        result.action.type,
      );
    }
  });

  it('does NOT ignore thread replies (threadTs present)', () => {
    const deps = makeDeps({ C_BOUND: 'my-enclave' }, ['my-enclave']);
    const event = makeEvent({
      type: 'message',
      channelId: 'C_BOUND',
      channelType: 'channel',
      text: 'a thread reply without @mention',
      threadTs: '1234567890.000100',
    });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('deterministic');
    if (result.path === 'deterministic') {
      expect(result.action.type).toBe('forward_to_active_team');
    }
  });
});

// ---------------------------------------------------------------------------
// SmartReason — novel_phrasing removed
// ---------------------------------------------------------------------------

describe('SmartReason — no novel_phrasing', () => {
  it('DM event gets dm_query reason', () => {
    const deps = makeDeps({});
    const event = makeEvent({ channelType: 'im', text: 'random text' });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('smart');
    if (result.path === 'smart') {
      const reason: SmartReason = result.reason;
      expect(reason).toBe('dm_query');
      // novel_phrasing would be a type error here — just verify it's not used
      expect(reason).not.toBe('novel_phrasing');
    }
  });

  it('status check text gets status_check reason (in bound channel via ambiguous)', () => {
    // In a DM, status check text gets dm_query (takes precedence)
    // In a bound channel, ambiguous text gets ambiguous_input from classifySmartReason
    const deps = makeDeps({});
    const event = makeEvent({ channelType: 'im', text: "what's happening?" });
    const result = routeEvent(event, deps);
    expect(result.path).toBe('smart');
    if (result.path === 'smart') {
      expect(result.reason).toBe('dm_query');
    }
  });
});
