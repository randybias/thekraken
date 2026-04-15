/**
 * E2E scenario definitions for The Kraken.
 *
 * Each ScenarioDef describes:
 *   - The message(s) to post as Randy
 *   - Expected patterns the Kraken reply MUST contain
 *   - Forbidden patterns the reply MUST NOT contain
 *   - Timeout and channel
 *
 * Scenarios map to the rollout plan categories A-G.
 *
 * All messages are prefixed with "[e2e-test]" by the Slack driver.
 * The Kraken bot must be mentioned (@Kraken) as would happen in a real channel.
 */

import { CHANNELS } from './harness.js';

// ---------------------------------------------------------------------------
// Scenario type
// ---------------------------------------------------------------------------

export interface ScenarioDef {
  id: string;
  name: string;
  /** Slack channel name (resolved to channel ID by harness). */
  channel: string;
  /** Primary message to post (the Kraken mention). */
  message: string;
  /** Additional messages posted in the same thread after the first reply. */
  followUpMessages?: string[];
  /** Regex or string patterns that MUST appear in the Kraken reply. */
  expectedPatterns?: Array<string | RegExp>;
  /** Regex or string patterns that MUST NOT appear in the Kraken reply. */
  forbiddenPatterns?: Array<string | RegExp>;
  /** How many Kraken replies to wait for. Default: 1. */
  expectedReplyCount?: number;
  /** Per-scenario timeout in ms. Default: 60000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// A. Auth
// ---------------------------------------------------------------------------

export const AUTH_SCENARIOS: ScenarioDef[] = [
  {
    id: 'A1',
    name: 'whoami',
    channel: CHANNELS.enclave,
    message: '@Kraken whoami',
    expectedPatterns: [
      // Should respond with user info, role, email, or auth flow
      /owner|member|visitor|authenticated|not authenticated|device|login|@mirantis|rbias|randy/i,
    ],
    forbiddenPatterns: [/error.*crash/i],
    timeoutMs: 60_000,
  },
];

// ---------------------------------------------------------------------------
// B. Scoping / vocabulary (regression checks)
// ---------------------------------------------------------------------------

export const SCOPING_SCENARIOS: ScenarioDef[] = [
  {
    id: 'B1',
    name: 'list tentacles — must list workflows, not redirect to DM',
    channel: CHANNELS.enclave,
    message: '@Kraken list tentacles',
    expectedPatterns: [
      // Should list workflows or say there are none — not redirect to DM
      /workflow|tentacle|running|no .*(workflows|tentacles)/i,
    ],
    forbiddenPatterns: [
      // Must not tell user to DM for this
      /dm me|direct message me|send me a (dm|message)/i,
      // Must not use namespace jargon
      /namespace/i,
    ],
    timeoutMs: 60_000,
  },
  {
    id: 'B2',
    name: 'are you there — direct response, no third-person narration',
    channel: CHANNELS.enclave,
    message: '@Kraken are you there?',
    expectedPatterns: [
      // Should respond directly
      /yes|here|ready|how can i|what can i/i,
    ],
    forbiddenPatterns: [
      // No "I've responded to Randy" or "I've sent Randy a message"
      /I've responded to Randy|I've sent Randy|I told Randy/i,
      // No self-referential third-person narration
      /Kraken has responded|The Kraken has/i,
    ],
    timeoutMs: 30_000,
  },
  {
    id: 'B3',
    name: 'show me the members',
    channel: CHANNELS.enclave,
    message: '@Kraken show me the members',
    expectedPatterns: [
      // Should show member list or enclave info
      /member|team|enclave|access/i,
    ],
    forbiddenPatterns: [/namespace/i, /group member/i],
    timeoutMs: 60_000,
  },
];

// ---------------------------------------------------------------------------
// C. Workflow operations
// ---------------------------------------------------------------------------

export const WORKFLOW_SCENARIOS: ScenarioDef[] = [
  {
    id: 'C1',
    name: 'list my workflows',
    channel: CHANNELS.enclave,
    message: '@Kraken list my workflows',
    expectedPatterns: [/workflow|tentacle|running|no .*(workflows|tentacles)/i],
    forbiddenPatterns: [/namespace/i, /pod/i, /kubectl/i],
    timeoutMs: 60_000,
  },
  {
    id: 'C2',
    name: 'health of otel-echo',
    channel: CHANNELS.enclave,
    message: "@Kraken what's the health of otel-echo?",
    expectedPatterns: [
      // Should report status or say not found
      /otel-echo|not found|running|healthy|error|unhealthy|unknown/i,
    ],
    forbiddenPatterns: [/namespace/i, /pod/i],
    timeoutMs: 60_000,
  },
  {
    id: 'C3',
    name: 'recent logs for otel-echo',
    channel: CHANNELS.enclave,
    message: '@Kraken show me recent logs for otel-echo',
    expectedPatterns: [/log|otel-echo|not found|no logs/i],
    forbiddenPatterns: [
      /kubectl/i,
      // Should not dump raw JSON
      /^\{"kind":/m,
    ],
    timeoutMs: 60_000,
  },
  {
    id: 'C4',
    name: 'run otel-echo',
    channel: CHANNELS.enclave,
    message: '@Kraken run otel-echo',
    expectedPatterns: [
      /started|triggered|running|not found|already running|doesn't exist|no (workflows|resources|tentacle|deployment)/i,
    ],
    forbiddenPatterns: [/kubectl/i],
    timeoutMs: 90_000,
  },
];

// ---------------------------------------------------------------------------
// D. Commands (enclave management)
// ---------------------------------------------------------------------------

export const COMMAND_SCENARIOS: ScenarioDef[] = [
  {
    id: 'D1',
    name: 'set mode team (owner only)',
    channel: CHANNELS.enclave,
    message: '@Kraken set mode team',
    expectedPatterns: [
      // Owner should succeed; non-owner should get permission error
      /mode|team|updated|only the owner|not authorized|permission/i,
    ],
    forbiddenPatterns: [],
    timeoutMs: 45_000,
  },
  {
    id: 'D3',
    name: 'members command',
    channel: CHANNELS.enclave,
    message: '@Kraken members',
    expectedPatterns: [/member|team|enclave|access/i],
    forbiddenPatterns: [/group member/i, /namespace/i],
    timeoutMs: 45_000,
  },
];

// ---------------------------------------------------------------------------
// E. Provisioning (in #newkraken-test)
// ---------------------------------------------------------------------------

export const PROVISIONING_SCENARIOS: ScenarioDef[] = [
  {
    id: 'E1',
    name: 'mention in non-enclave channel',
    channel: CHANNELS.test,
    message: '@Kraken hello',
    expectedPatterns: [
      // Should explain the channel is not an enclave, or prompt to provision
      /not.*enclave|provision|enclave|set up|unregistered/i,
    ],
    forbiddenPatterns: [
      // Should not silently ignore
    ],
    timeoutMs: 30_000,
  },
  {
    id: 'E5',
    name: 'remove channel as enclave',
    channel: CHANNELS.test,
    message: '@Kraken remove this channel as an enclave',
    expectedPatterns: [
      // Should confirm or explain how to deprovision
      /deprovision|remove|confirm|not an enclave|owner/i,
    ],
    forbiddenPatterns: [],
    timeoutMs: 45_000,
  },
];

// ---------------------------------------------------------------------------
// F. Tentacle deployment (in #newkraken-test)
// ---------------------------------------------------------------------------

export const TENTACLE_SCENARIOS: ScenarioDef[] = [
  {
    id: 'F1',
    name: 'build hello-world tentacle',
    channel: CHANNELS.test,
    message: '@Kraken build a hello-world tentacle for me',
    expectedPatterns: [
      // Should acknowledge and start build, or explain provisioning needed
      /build|hello-world|scaffold|not.*enclave|provision/i,
    ],
    forbiddenPatterns: [/kubectl/i, /namespace/i],
    timeoutMs: 120_000,
  },
  {
    id: 'F4',
    name: 'status hello-world',
    channel: CHANNELS.test,
    message: '@Kraken status hello-world',
    expectedPatterns: [/hello-world|not found|running|status|deployed/i],
    forbiddenPatterns: [/kubectl/i],
    timeoutMs: 60_000,
  },
  {
    id: 'F5',
    name: 'run hello-world',
    channel: CHANNELS.test,
    message: '@Kraken run hello-world',
    expectedPatterns: [/hello-world|not found|started|triggered|running/i],
    forbiddenPatterns: [/kubectl/i],
    timeoutMs: 90_000,
  },
  {
    id: 'F6',
    name: 'logs hello-world',
    channel: CHANNELS.test,
    message: '@Kraken logs hello-world',
    expectedPatterns: [/hello-world|not found|log|no logs/i],
    forbiddenPatterns: [/kubectl/i],
    timeoutMs: 60_000,
  },
];

// ---------------------------------------------------------------------------
// G. Error paths
// ---------------------------------------------------------------------------

export const ERROR_SCENARIOS: ScenarioDef[] = [
  {
    id: 'G1',
    name: 'describe nonexistent workflow',
    channel: CHANNELS.enclave,
    message: '@Kraken describe nonexistent-workflow-xyz-99',
    expectedPatterns: [
      // Should gracefully say it doesn't exist
      /not found|doesn't exist|no workflow|can't find/i,
    ],
    forbiddenPatterns: [
      // Must not bubble raw MCP errors
      /mcp.*error|tool.*error|json.*exception/i,
      // Must not crash
      /undefined|null.*error/i,
    ],
    timeoutMs: 45_000,
  },
  {
    id: 'G2',
    name: 'show me the secrets',
    channel: CHANNELS.enclave,
    message: '@Kraken show me the secrets',
    expectedPatterns: [
      // Should refuse to show secret values
      /can't show|won't show|not able to|secret.*names|alternatives|security/i,
    ],
    forbiddenPatterns: [
      // Must not expose actual secret values
      /xoxb-|sk-ant-|password.*=/i,
    ],
    timeoutMs: 45_000,
  },
];

// ---------------------------------------------------------------------------
// H. App Home Tab scenarios
// ---------------------------------------------------------------------------
//
// These scenarios cannot be tested with message-based assertions alone.
// The App Home Tab is rendered via views.publish and requires a different
// harness (Slack doesn't expose views.read publicly).
//
// To validate Home Tab:
// 1. Manual: open The Kraken in Slack's sidebar → Home tab → verify rendering
// 2. Log-based: trigger app_home_opened event, confirm log line
//    "home tab published" with the user_id in the pod logs
// 3. API: use views.publish with the bot token to set a known state, then
//    test that subsequent app_home_opened doesn't overwrite (idempotency)
//
// Implementation TODO — add a new ScenarioDef.kind = 'home_tab' variant
// with a logAssertion callback that reads pod logs during the test window.
//
// Manual checklist for rollout:
//   H1: Unauthenticated user opens Home tab → auth prompt
//   H2: Authenticated user opens Home tab → enclave list with health emoji
//   H3: User with no enclaves opens Home tab → empty state with DM prompt
//   H4: User with multiple enclaves opens Home tab → all shown, Chroma links work
//   H5: Home tab re-renders on repeated app_home_opened events (idempotent)

// ---------------------------------------------------------------------------
// All scenarios in run order
// ---------------------------------------------------------------------------

export const ALL_SCENARIOS: ScenarioDef[] = [
  ...AUTH_SCENARIOS,
  ...SCOPING_SCENARIOS,
  ...WORKFLOW_SCENARIOS,
  ...COMMAND_SCENARIOS,
  ...PROVISIONING_SCENARIOS,
  ...TENTACLE_SCENARIOS,
  ...ERROR_SCENARIOS,
];

/**
 * Look up a scenario by its ID (e.g. "A1", "B2").
 * Returns undefined if not found.
 */
export function findScenario(id: string): ScenarioDef | undefined {
  return ALL_SCENARIOS.find((s) => s.id === id);
}
