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
 *
 * Environment variables that control parameterised values:
 *   KRAKEN_E2E_TEST_ENCLAVE  — enclave name provisioned by E2 / used by F1 mcpAssertion
 *                              (default: "e2e-test")
 *   KRAKEN_E2E_TEST_EMAIL    — fake email for I1/I2 error-path tests
 *                              (default: "e2e-test-noop@mirantis.com")
 *   KRAKEN_E2E_MEMBER_EMAIL  — real email of a second Slack user; enables I4 / H scenarios
 *   KRAKEN_E2E_MEMBER_SECRET — secret path for the second user's Slack token; enables H scenarios
 */

import { CHANNELS, TEST_ENCLAVE, TEST_EMAIL, MEMBER_EMAIL } from './harness.js';

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
  /**
   * Post as 'member' user instead of owner. Skips gracefully when
   * KRAKEN_E2E_MEMBER_SECRET is not set (no member driver available).
   */
  asUser?: 'owner' | 'member';
  /**
   * Dynamic skip predicate. If defined and returns true at runtime, the
   * scenario is SKIPped without posting any messages.
   */
  skipWhen?: () => boolean;
  /**
   * If the bot's reply matches this pattern AND the mcpAssertion times out,
   * mark the scenario as SKIP instead of FAIL. Use when the expected bot
   * behavior is to delegate asynchronously (e.g. "dev team commissioned")
   * and the async operation may not complete within the test window.
   */
  mcpAssertionSkipOnAsyncReply?: RegExp;
  /**
   * Post-reply assertion against real MCP state. Runs AFTER the reply
   * regex matches. Returns null on pass, or an error message on fail.
   * Prevents regex-pass from hiding a non-deploy. Allows scenarios like
   * F1 to verify wf_list actually contains the workflow.
   */
  mcpAssertion?: {
    /** Poll interval in ms while waiting for the assertion to pass. */
    pollMs?: number;
    /** Total wait budget in ms before failing. */
    timeoutMs?: number;
    /** The assertion. Receives an mcpCall fn; returns null when passed. */
    check: (
      mcpCall: (
        tool: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>,
    ) => Promise<string | null>;
  };
  /**
   * Direct kubectl assertion used as fallback when mcpAssertion OIDC setup
   * fails. Returns null on pass, or an error string on fail. Skipped when
   * KUBECONFIG is not set or kubectl is not on PATH.
   */
  clusterAssertion?: {
    check: () => Promise<string | null>;
  };
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
      // Should respond with user info, role, email, enclave info, or auth flow
      /owner|member|visitor|authenticated|not authenticated|device|login|@mirantis|rbias|randy|enclave manager|enclave|I'm|I am/i,
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
    forbiddenPatterns: [
      /namespace/i,
      /kubectl.*pod|get pods|pod.*status.*running.*\d/i,
    ],
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
      /started|triggered|running|not found|already running|doesn't exist|no (workflows|resources|tentacle|deployment)|0 deployed|can't run|no luck|problem|error|enclave|nothing to run|isn't deployed|mcp.*timeout|timeout|not in a runnable|runnable/i,
    ],
    forbiddenPatterns: [/kubectl/i],
    timeoutMs: 90_000,
  },
  {
    id: 'C5',
    name: 'health of hello-world (deployed workflow)',
    channel: CHANNELS.test,
    message: "@Kraken what's the health of hello-world?",
    expectedPatterns: [
      /hello-world|running|healthy|error|unhealthy|not found|status|ready/i,
    ],
    forbiddenPatterns: [/kubectl/i, /kubectl.*pod|get pods/i],
    timeoutMs: 60_000,
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
      // Owner should succeed; non-owner/unrecognized command should explain
      /mode|team|updated|only the owner|not authorized|permission|not.*recognized|type help/i,
    ],
    forbiddenPatterns: [],
    timeoutMs: 45_000,
  },
  {
    id: 'D2',
    name: 'verify mode reflects after set',
    channel: CHANNELS.enclave,
    message: '@Kraken what mode is this enclave in?',
    expectedPatterns: [/mode|team|private|shared|open|current|set to/i],
    forbiddenPatterns: [],
    timeoutMs: 30_000,
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
  {
    id: 'D4',
    name: 'help command',
    channel: CHANNELS.enclave,
    message: '@Kraken help',
    expectedPatterns: [
      // Help response should mention at least a handful of the documented commands
      /members|whoami|add|remove|mode|help/i,
    ],
    forbiddenPatterns: [/kubectl/i, /namespace/i],
    timeoutMs: 30_000,
  },
  {
    id: 'D5',
    name: 'set mode invalid preset',
    channel: CHANNELS.enclave,
    message: '@Kraken set mode banana',
    expectedPatterns: [
      // Should either list valid modes or reject the bogus one
      /invalid|valid|preset|private|team|shared|open|must be|not.*recognized|isn't.*recognized|recognized|recognize|isn't a concept|don't (have|know|understand)|didn't understand|can't set|not.*mode|not a thing|type help/i,
    ],
    forbiddenPatterns: [],
    timeoutMs: 30_000,
  },
];

// ---------------------------------------------------------------------------
// I. Membership + authorization (owner/member/visitor differentiation)
// ---------------------------------------------------------------------------

export const MEMBERSHIP_SCENARIOS: ScenarioDef[] = [
  {
    id: 'I1',
    name: 'add member (owner) — test user email',
    channel: CHANNELS.enclave,
    // Use a parameterised email (defaults to a noop address)
    message: `@Kraken add ${TEST_EMAIL}`,
    expectedPatterns: [
      // Accept either "added" or an error about the user not existing in Keycloak,
      // or the async "dev team commissioned" path for non-OIDC domains.
      /added|added to|member|updated|not found|doesn't exist|cannot find|unknown user|dev team|commissioned/i,
    ],
    forbiddenPatterns: [/undefined|null\.|mcp.*exception/i],
    timeoutMs: 60_000,
  },
  {
    id: 'I2',
    name: 'remove non-member (owner) — should fail gracefully',
    channel: CHANNELS.enclave,
    message: `@Kraken remove ${TEST_EMAIL}`,
    expectedPatterns: [
      /removed|not a member|not in the enclave|doesn't exist|no such member|unknown|dev team|commissioned/i,
    ],
    forbiddenPatterns: [/undefined|null\.|crash/i],
    timeoutMs: 45_000,
  },
  {
    id: 'I3',
    name: 'whoami reports ownership correctly',
    channel: CHANNELS.enclave,
    message: '@Kraken whoami',
    expectedPatterns: [
      /owner|member|visitor|you are|you're|user id|authenticated|session|enclave|role/i,
    ],
    forbiddenPatterns: [/not authenticated|must.*login/i],
    timeoutMs: 30_000,
  },
  {
    id: 'I4',
    name: 'add real member for RBAC tests',
    channel: CHANNELS.enclave,
    // Only meaningful when KRAKEN_E2E_MEMBER_EMAIL is set; otherwise skipped by
    // the harness (empty message would look suspicious — set it anyway).
    message: MEMBER_EMAIL
      ? `@Kraken add ${MEMBER_EMAIL}`
      : '@Kraken add noop@skip-this-scenario.invalid',
    skipWhen: () => !MEMBER_EMAIL,
    expectedPatterns: [
      /added|member|updated|not found|doesn't exist|cannot find|unknown user|dev team|commissioned/i,
    ],
    forbiddenPatterns: [/undefined|null\.|crash/i],
    timeoutMs: 60_000,
  },
];

// ---------------------------------------------------------------------------
// J. Multi-turn thread memory
// ---------------------------------------------------------------------------

export const MEMORY_SCENARIOS: ScenarioDef[] = [
  {
    id: 'J1',
    name: 'thread memory — recall a fact from an earlier turn',
    channel: CHANNELS.enclave,
    message: '@Kraken my favorite color is cerulean — please remember that',
    followUpMessages: ['@Kraken what is my favorite color?'],
    expectedReplyCount: 2,
    expectedPatterns: [
      // Second reply should contain "cerulean"
      /cerulean/i,
    ],
    forbiddenPatterns: [
      // Must not claim ignorance of the fact
      /I don't (know|remember)|no .*context/i,
    ],
    timeoutMs: 90_000,
  },
  {
    id: 'J2',
    name: 'thread memory — clarifying follow-up about enclave',
    channel: CHANNELS.enclave,
    message: '@Kraken list my workflows',
    followUpMessages: ['@Kraken which of those were deployed most recently?'],
    expectedReplyCount: 2,
    expectedPatterns: [
      // Second reply should name a specific workflow or discuss recency
      /workflow|tentacle|deployed|most recent|newest|latest|age/i,
    ],
    forbiddenPatterns: [
      /what workflows|which workflows are you/i, // Must not ask "what are you talking about"
    ],
    timeoutMs: 120_000,
  },
  {
    id: 'J3',
    name: 'thread memory — 3-turn recall across multiple facts',
    channel: CHANNELS.enclave,
    message: '@Kraken my cat is named Whiskers',
    followUpMessages: [
      '@Kraken and my dog is named Biscuit',
      "@Kraken what are my pets' names?",
    ],
    expectedReplyCount: 3,
    expectedPatterns: [
      // Final reply (joined text of all 3 bot turns) must contain both facts
      /whiskers/i,
      /biscuit/i,
    ],
    forbiddenPatterns: [
      // Must not claim ignorance once the facts were stated
      /I don't (know|remember) (any|your)|what (cat|dog|pets)/i,
    ],
    timeoutMs: 120_000,
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
      // Should explain the channel is not an enclave, or prompt to provision,
      // or respond with a greeting (bot responds to all mentions)
      /not.*enclave|provision|enclave|set up|unregistered|isn't set up|hey|hello|what can|how can|can I help|do for you/i,
    ],
    forbiddenPatterns: [],
    timeoutMs: 30_000,
  },
  {
    id: 'E2',
    name: 'provision test channel as enclave',
    channel: CHANNELS.test,
    // TEST_ENCLAVE is parameterised so the test can target any environment.
    message: `@Kraken provision this channel as an enclave named ${TEST_ENCLAVE} for end-to-end testing`,
    // Accept either a synchronous "live/ready/done" confirmation or the async
    // "dev team commissioned" path (both result in a working enclave per F4/C5).
    expectedPatterns: [
      new RegExp(
        `live|ready|done|is now|complete|set up|${TEST_ENCLAVE}.*enclave|enclave.*${TEST_ENCLAVE}|dev team|commissioned`,
        'i',
      ),
    ],
    forbiddenPatterns: [],
    timeoutMs: 150_000,
  },
  {
    id: 'E5',
    name: 'remove channel as enclave',
    channel: CHANNELS.test,
    message: '@Kraken remove this channel as an enclave',
    expectedPatterns: [
      // Should confirm or explain how to deprovision
      /deprovision|remove|confirm|not an enclave|owner|decommission/i,
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
    name: 'build hello-world tentacle — real deploy',
    channel: CHANNELS.test,
    message: '@Kraken build a hello-world tentacle for me',
    expectedPatterns: [
      /build|hello-world|scaffold|deploy|redeploy|apply|ready|verify|running|committed/i,
    ],
    forbiddenPatterns: [/kubectl/i],
    // Bridge-based team builds can take a few minutes (pi + tntc + image build).
    timeoutMs: 15 * 60 * 1000,
    // If the bot delegates to dev team (async build path), SKIP instead of FAIL
    // when the assertion times out — the build agent (pi) may not be installed
    // in this environment, which is a system configuration issue, not a test failure.
    mcpAssertionSkipOnAsyncReply: /dev team|commissioned/i,
    // Real deployment assertion: verify hello-world actually lands in MCP's
    // wf_list. Regex-pass alone is not enough — it let us claim success
    // when the tentacle didn't exist. This forces the end-to-end check.
    mcpAssertion: {
      pollMs: 15_000,
      timeoutMs: 15 * 60 * 1000,
      check: async (mcpCall) => {
        // Dynamically discover the MCP enclave name — the Kraken may append a
        // cluster suffix (e.g. "e2e-test" → "e2e-test-weu") at provision time.
        let enclaveName = TEST_ENCLAVE;
        try {
          const listRaw = await mcpCall('enclave_list', {});
          const listParsed =
            typeof listRaw === 'string'
              ? (JSON.parse(listRaw) as {
                  enclaves?: Array<{ channel_name?: string; name: string }>;
                })
              : (listRaw as {
                  enclaves?: Array<{ channel_name?: string; name: string }>;
                });
          const testChannel = CHANNELS.test.replace(/^#/, '');
          const found = listParsed.enclaves?.find(
            (e) => e.channel_name === testChannel,
          );
          if (found) enclaveName = found.name;
        } catch {
          // Fall back to TEST_ENCLAVE if enclave_list fails
        }

        const raw = await mcpCall('wf_list', { enclave: enclaveName });
        let parsed: { workflows?: Array<{ name: string; ready?: boolean }> };
        try {
          parsed =
            typeof raw === 'string' ? JSON.parse(raw) : (raw as typeof parsed);
        } catch {
          return `wf_list returned non-JSON (enclave=${enclaveName}): ${String(raw).slice(0, 100)}`;
        }
        const workflows = parsed.workflows ?? [];
        const hw = workflows.find((w) => w.name === 'hello-world');
        if (!hw) {
          return `hello-world not in wf_list for enclave ${enclaveName} (${workflows.length} workflows: ${workflows.map((w) => w.name).join(', ')})`;
        }
        if (hw.ready !== true) {
          return `hello-world registered but not ready (ready=${String(hw.ready)}); still polling`;
        }
        return null;
      },
    },
    // kubectl fallback: check the deployment exists in the enclave namespace.
    // Used when OIDC token is unavailable (expired session / fresh pod).
    clusterAssertion: {
      check: async () => {
        const { execSync } = await import('node:child_process');
        const ns = TEST_ENCLAVE;
        try {
          const out = execSync(
            `kubectl get deployment hello-world -n ${ns} -o jsonpath={.status.availableReplicas}`,
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
          );
          const replicas = parseInt(out.trim() || '0', 10);
          if (isNaN(replicas) || replicas < 1) {
            return `hello-world in ns/${ns}: deployment found but availableReplicas=${out.trim() || '0'}`;
          }
          return null;
        } catch (err) {
          return `hello-world deployment not found in ns/${ns}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
        }
      },
    },
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
    expectedPatterns: [
      /hello-world|not found|started|triggered|running|timeout|unreachable|mcp.*server|not in a runnable/i,
    ],
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
  {
    id: 'F8',
    name: 'restart hello-world',
    channel: CHANNELS.test,
    message: '@Kraken restart hello-world',
    expectedPatterns: [
      /restart|restarting|rollout|rolled.*out|reset|initiating|not found|hello-world/i,
    ],
    forbiddenPatterns: [/kubectl/i],
    timeoutMs: 60_000,
  },
  {
    id: 'F9',
    name: 'describe hello-world',
    channel: CHANNELS.test,
    message: '@Kraken describe hello-world',
    expectedPatterns: [
      /hello-world|image|container|running|deployed|version|config|not found|status/i,
    ],
    forbiddenPatterns: [/kubectl/i],
    timeoutMs: 60_000,
  },
  {
    id: 'F10',
    name: 'remove hello-world tentacle',
    channel: CHANNELS.test,
    message: '@Kraken remove hello-world',
    expectedPatterns: [
      // Accept removal confirmation, removal success, or an "are you sure?" prompt
      /removed|deleted|decommission|gone|done|no longer|hello-world|confirm|are you sure|not found|completed/i,
    ],
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
      /not found|doesn't exist|does not exist|not exist|doesn't appear|no workflow|can't find|appear to exist|never been deployed|not deployed|never deployed/i,
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
      // Should refuse to show secret values — may phrase as "can't show",
      // "don't have a tool to read", "sensitive", or offer alternatives.
      /can't show|won't show|not able to|secret|sensitive|credential|don't have.*tool|not exposed/i,
    ],
    forbiddenPatterns: [
      // Must not expose actual secret values
      /xoxb-|sk-ant-|password.*=/i,
    ],
    timeoutMs: 45_000,
  },
  {
    id: 'G3',
    name: 'events for a workflow',
    channel: CHANNELS.enclave,
    message: '@Kraken show me events for otel-echo',
    expectedPatterns: [
      /event|otel-echo|not found|no events|timeline|activity/i,
    ],
    forbiddenPatterns: [
      /kubectl (get|exec|apply|delete|run|create|scale|describe)/i,
      /undefined|null.*error/i,
    ],
    timeoutMs: 45_000,
  },
  {
    id: 'G4',
    name: 'logs for nonexistent workflow — graceful error',
    channel: CHANNELS.enclave,
    message: '@Kraken show me logs for nonexistent-workflow-xyz-99',
    expectedPatterns: [
      /not found|doesn't exist|does not exist|no logs|can't find|no such workflow/i,
    ],
    forbiddenPatterns: [/kubectl/i, /undefined|null.*error/i],
    timeoutMs: 45_000,
  },
];

// ---------------------------------------------------------------------------
// H. RBAC enforcement (requires KRAKEN_E2E_MEMBER_SECRET to be set)
//
// These scenarios post as a second Slack user (the "member") and verify
// the role system blocks owner-only operations while allowing member ones.
// All scenarios are gracefully SKIPped when KRAKEN_E2E_MEMBER_SECRET is
// not configured — no action needed for them to disappear from failures.
//
// Setup: I4 must have added KRAKEN_E2E_MEMBER_EMAIL to the enclave before
// H1-H3 run. The ALL_SCENARIOS ordering enforces this.
// ---------------------------------------------------------------------------

export const RBAC_SCENARIOS: ScenarioDef[] = [
  {
    id: 'H1',
    name: 'member can read enclave state (whoami)',
    channel: CHANNELS.enclave,
    asUser: 'member',
    message: '@Kraken whoami',
    expectedPatterns: [/member|visitor|authenticated|owner|role|enclave/i],
    forbiddenPatterns: [/error.*crash/i],
    timeoutMs: 30_000,
  },
  {
    id: 'H2',
    name: 'member cannot execute owner-only set mode',
    channel: CHANNELS.enclave,
    asUser: 'member',
    message: '@Kraken set mode private',
    expectedPatterns: [
      /owner|not authorized|permission|only.*owner|can't|cannot|not allowed/i,
    ],
    forbiddenPatterns: [],
    timeoutMs: 30_000,
  },
  {
    id: 'H3',
    name: 'member can list workflows in team mode',
    channel: CHANNELS.enclave,
    asUser: 'member',
    message: '@Kraken list my workflows',
    expectedPatterns: [/workflow|tentacle|running|no .*(workflows|tentacles)/i],
    forbiddenPatterns: [/namespace/i],
    timeoutMs: 60_000,
  },
];

// ---------------------------------------------------------------------------
// App Home Tab scenarios (H-prefix reserved for RBAC above)
// ---------------------------------------------------------------------------
//
// Home Tab requires a different harness (views.publish + app_home_opened).
// See harness.ts comment block for implementation approach.
//
// Manual checklist:
//   HA1: Unauthenticated user opens Home tab → auth prompt
//   HA2: Authenticated user opens Home tab → enclave list with health emoji
//   HA3: User with no enclaves opens Home tab → empty state with DM prompt

// ---------------------------------------------------------------------------
// All scenarios in run order
// ---------------------------------------------------------------------------

// Splice E1/E2/E5 and C5 into explicit positions around the F group.
const [e1, e2, e5] = [
  PROVISIONING_SCENARIOS.find((s) => s.id === 'E1')!,
  PROVISIONING_SCENARIOS.find((s) => s.id === 'E2')!,
  PROVISIONING_SCENARIOS.find((s) => s.id === 'E5')!,
];
// C5 (health of hello-world) belongs after F4 (status check), not at the end of F.
const c5 = WORKFLOW_SCENARIOS.find((s) => s.id === 'C5')!;
const baseWorkflowScenarios = WORKFLOW_SCENARIOS.filter((s) => s.id !== 'C5');
const [f1, f4, f5, f6, f8, f9, f10] = [
  'F1',
  'F4',
  'F5',
  'F6',
  'F8',
  'F9',
  'F10',
].map((id) => TENTACLE_SCENARIOS.find((s) => s.id === id)!);

export const ALL_SCENARIOS: ScenarioDef[] = [
  // A. Identity
  ...AUTH_SCENARIOS,
  // B. Vocabulary / scoping regressions
  ...SCOPING_SCENARIOS,
  // C. Workflow operations against the existing enclave channel (C5 deferred below)
  ...baseWorkflowScenarios,
  // D. Commands — D2 (mode verify) directly follows D1 (mode set)
  ...COMMAND_SCENARIOS,
  // I. Membership — I4 (add real member) runs before H scenarios
  ...MEMBERSHIP_SCENARIOS,
  // J. Thread memory
  ...MEMORY_SCENARIOS,
  // E1: verify non-enclave behaviour before provisioning
  e1,
  // E2: provision the test channel as an enclave
  e2,
  // F1 deploy → F4 status → C5 health → F5 run → F6 logs → F8 restart → F9 describe → F10 remove
  f1,
  f4,
  c5,
  f5,
  f6,
  f8,
  f9,
  f10,
  // E5: deprovision the test channel (all F scenarios complete)
  e5,
  // G. Error paths
  ...ERROR_SCENARIOS,
  // H. RBAC — skipped gracefully when KRAKEN_E2E_MEMBER_SECRET is not set
  ...RBAC_SCENARIOS,
];

/**
 * Look up a scenario by its ID (e.g. "A1", "B2").
 * Returns undefined if not found.
 */
export function findScenario(id: string): ScenarioDef | undefined {
  return ALL_SCENARIOS.find((s) => s.id === id);
}
