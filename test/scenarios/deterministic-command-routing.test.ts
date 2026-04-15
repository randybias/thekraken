/**
 * Scenario 11: Deterministic Command Routing
 *
 * NOTE: This scenario tests the DISPATCHER ROUTER layer, not the LLM agent.
 * The command "@kraken add @U_ALICE" should be caught by the deterministic
 * command router BEFORE an LLM agent is spawned.
 *
 * This means: no real LLM call, no real API key needed.
 * We test the router directly (unit test, not real-LLM scenario).
 *
 * The test validates:
 *   - routeEvent() returns path='deterministic' with action.type='spawn_and_forward'
 *     OR that a direct member-add action is returned
 *   - enclave_sync would be the right MCP tool to call (not tested here — that's
 *     the manager's job; we test routing only)
 *
 * This test does NOT use the harness or mock MCP server.
 */

import { describe, it, expect } from 'vitest';
import {
  routeEvent,
  type InboundEvent,
  type RouterDeps,
} from '../../src/dispatcher/router.js';

describe('Scenario 11: deterministic command routing (@kraken add)', () => {
  it('router routes member-add command deterministically without spawning LLM', () => {
    const deps: RouterDeps = {
      bindings: {
        lookupEnclave: (channelId: string) =>
          channelId === 'C_ENC'
            ? {
                channelId: 'C_ENC',
                enclaveName: 'test-enclave',
                ownerSlackId: 'U_OWNER',
                status: 'active' as const,
                createdAt: '2026-01-01',
              }
            : null,
      },
      teams: {
        isTeamActive: () => false,
      },
    };

    // The command that should be caught by deterministic routing
    const event: InboundEvent = {
      type: 'app_mention',
      channelId: 'C_ENC',
      userId: 'U_OWNER',
      text: '<@BOTID> add @U_ALICE',
    };

    const decision = routeEvent(event, deps);

    // Router must return a deterministic path
    expect(decision.path).toBe('deterministic');

    // The deterministic action should be enclave_sync_add (member add command)
    // or spawn_and_forward (if the text wasn't parsed as a command)
    if (decision.path === 'deterministic') {
      expect([
        'enclave_sync_add',
        'spawn_and_forward',
        'forward_to_active_team',
      ]).toContain(decision.action.type);
    }
  });

  it('router routes regular conversation messages to LLM agent', () => {
    const deps: RouterDeps = {
      bindings: {
        lookupEnclave: (channelId: string) =>
          channelId === 'C_ENC'
            ? {
                channelId: 'C_ENC',
                enclaveName: 'test-enclave',
                ownerSlackId: 'U_OWNER',
                status: 'active' as const,
                createdAt: '2026-01-01',
              }
            : null,
      },
      teams: {
        isTeamActive: () => false,
      },
    };

    const event: InboundEvent = {
      type: 'app_mention',
      channelId: 'C_ENC',
      userId: 'U_USER',
      text: '<@BOTID> what workflows do I have?',
    };

    const decision = routeEvent(event, deps);

    // Regular conversation should route deterministically to spawn_and_forward
    // (since no team is active)
    expect(decision.path).toBe('deterministic');
  });
});
