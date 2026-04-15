/**
 * Unit coverage for the build/deploy classifier inside routeEvent.
 *
 * This is the gate that decides whether an enclave-bound @mention goes
 * to the long-running team subprocess (builder/deployer) or stays on
 * the inline dispatcher smart-path. Getting it wrong in either
 * direction is a visible regression: conversational traffic hitting
 * the team hangs for minutes; build requests hitting smart-path never
 * actually deploy anything.
 */
import { describe, it, expect } from 'vitest';
import {
  routeEvent,
  type InboundEvent,
  type RouterDeps,
} from '../../src/dispatcher/router.js';

const CHANNEL = 'C_ALPHA';
const USER = 'U_ALICE';

function mkDeps({
  boundTo,
  teamActive,
}: {
  boundTo?: string;
  teamActive?: boolean;
}): RouterDeps {
  return {
    bindings: {
      lookupEnclave: (channelId: string) =>
        channelId === CHANNEL && boundTo
          ? {
              channelId,
              enclaveName: boundTo,
              ownerSlackId: USER,
              status: 'active',
              createdAt: '',
            }
          : null,
    } as unknown as RouterDeps['bindings'],
    teams: {
      isTeamActive: () => teamActive ?? false,
    } as unknown as RouterDeps['teams'],
  };
}

function event(text: string): InboundEvent {
  return {
    type: 'app_mention',
    channelId: CHANNEL,
    userId: USER,
    text,
  };
}

describe('router: enclave-bound mentions', () => {
  const deps = mkDeps({ boundTo: 'alpha' });

  // ------------------------------------------------------------------------
  // BUILD/DEPLOY → team
  // ------------------------------------------------------------------------
  const buildPhrases = [
    '<@BOT> build a hello-world tentacle for me',
    '<@BOT> create a new workflow',
    '<@BOT> scaffold a crawler tentacle',
    '<@BOT> generate a pipeline',
    '<@BOT> make me a hello-world tentacle',
    '<@BOT> write me a new tentacle',
    '<@BOT> deploy my tentacle',
    '<@BOT> redeploy the tentacle please',
  ];
  for (const text of buildPhrases) {
    it(`routes "${text.slice(10, 35)}..." to team`, () => {
      const d = routeEvent(event(text), deps);
      expect(d.path).toBe('deterministic');
      if (d.path === 'deterministic') {
        expect(['spawn_and_forward', 'forward_to_active_team']).toContain(
          d.action.type,
        );
      }
    });
  }

  it('forwards to existing team when team is active', () => {
    const d = routeEvent(
      event('<@BOT> build a new tentacle'),
      mkDeps({ boundTo: 'alpha', teamActive: true }),
    );
    if (d.path !== 'deterministic') throw new Error('expected deterministic');
    expect(d.action.type).toBe('forward_to_active_team');
  });

  // ------------------------------------------------------------------------
  // READ / CONVERSATIONAL → smart path
  // ------------------------------------------------------------------------
  const smartPhrases = [
    '<@BOT> what workflows are running?',
    '<@BOT> show me recent logs for otel-echo',
    "<@BOT> what's the health of my tentacles?",
    '<@BOT> run otel-echo',
    '<@BOT> status hello-world',
    '<@BOT> list tentacles',
    '<@BOT> are you there?',
  ];
  for (const text of smartPhrases) {
    it(`routes "${text.slice(10, 35)}..." to smart path`, () => {
      const d = routeEvent(event(text), deps);
      expect(d.path).toBe('smart');
    });
  }

  // ------------------------------------------------------------------------
  // Note: Deterministic commands (whoami, members, add, remove, set-mode,
  // help) are handled by parseCommand in bot.ts BEFORE routeEvent runs.
  // routeEvent's own parseCommand deliberately returns null for these so
  // any mention that reaches the router is non-command text — classified
  // into team vs smart-path by phrasing. That split is tested above.
  // ------------------------------------------------------------------------

  // ------------------------------------------------------------------------
  // Unbound channel rejects everything
  // ------------------------------------------------------------------------
  it('unbound non-DM channel gets ignore_unbound', () => {
    const d = routeEvent(event('<@BOT> build a tentacle'), mkDeps({}));
    if (d.path !== 'deterministic') throw new Error('expected deterministic');
    expect(d.action.type).toBe('ignore_unbound');
  });
});
