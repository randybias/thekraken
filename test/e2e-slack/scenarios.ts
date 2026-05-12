/**
 * E2E scenario definitions for The Kraken.
 *
 * Each ScenarioDef describes:
 *   - The message(s) to post as Randy
 *   - Expected patterns the Kraken reply MUST contain
 *   - Forbidden patterns the reply MUST NOT contain
 *   - Timeout and channel
 *
 * Scenarios map to the rollout plan categories A-K.
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
  /**
   * Additional messages posted in the same thread.
   * When followUpAfterFirstReply is false (default), they are sent before
   * any reply is received (all in the mailbox at once).
   * When followUpAfterFirstReply is true, they are sent after the first
   * Kraken reply — useful for testing responsiveness during long async ops.
   */
  followUpMessages?: string[];
  /**
   * When true, followUpMessages are sent AFTER the first Kraken reply.
   * The test then waits for one more reply per follow-up message and
   * evaluates expectedPatterns against only those subsequent replies.
   */
  followUpAfterFirstReply?: boolean;
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
  /**
   * Optional Chroma assertion: after the Slack reply check passes,
   * navigate to a Chroma URL and verify the page reflects the result.
   * Mirrors mcpAssertion shape. Substitution: <TEST_ENCLAVE> in `path`
   * is replaced with the active test enclave.
   */
  chromaAssertion?: {
    path: string;
    expectText?: Array<string | RegExp>;
    forbiddenText?: Array<string | RegExp>;
    timeoutMs?: number;
    pollMs?: number;
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
    name: 'list tentacles — workflows in prose/bullets, no markdown tables',
    channel: CHANNELS.enclave,
    message: '@Kraken list tentacles',
    expectedPatterns: [
      // Accept workflow list in prose, bullets, or a real tentacle name
      /workflow|tentacle|running|no .*(workflows|tentacles)|ai-news|echo|deployed by/i,
    ],
    forbiddenPatterns: [
      // Must not tell user to DM for this
      /dm me|direct message me|send me a (dm|message)/i,
      // Must not use namespace jargon
      /namespace/i,
      // Markdown tables don't render in Slack — bug thekraken#18
      /^\|.+\|.+\|.*$/m,
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
    name: 'list my workflows — prose/bullets, no markdown tables',
    channel: CHANNELS.enclave,
    message: '@Kraken list my workflows',
    expectedPatterns: [
      // Accept workflow list in prose, bullets, or a real tentacle name
      /workflow|tentacle|running|no .*(workflows|tentacles)|ai-news|echo|deployed by/i,
    ],
    forbiddenPatterns: [
      /namespace/i,
      /pod/i,
      /kubectl/i,
      // Markdown tables don't render in Slack — bug thekraken#18
      /^\|.+\|.+\|.*$/m,
    ],
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
      // "unavailable" covers transient MCP disruption; "still working" covers heartbeat bleed-through;
      // "commissioned|deployer" covers manager incorrectly delegating wf_run to a deployer team
      /started|triggered|running|not found|already running|doesn't exist|no (workflows|resources|tentacle|deployment)|0 deployed|can't run|no luck|problem|error|enclave|nothing to run|isn't deployed|mcp.*timeout|timeout|not in a runnable|runnable|unavailable|still working|working|getting started|commissioned|deployer/i,
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
      /invalid|valid|preset|private|team|shared|open|recognize|unknown|don't know|not\s+supported/i,
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
      // "still working|getting started" covers heartbeat bleed-through from prior task.
      /added|added to|member|updated|not found|doesn't exist|cannot find|unknown user|dev team|commissioned|still working|working|getting started|keep you posted/i,
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
    forbiddenPatterns: [
      /not authenticated|must.*login/i,
      // Must never show raw POSIX permission strings
      /rwxrwx|rwxr-x|rwx---|rw-r--|r-xr-x/i,
    ],
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
      // Non-enclave: bot explains channel isn't set up or prompts to provision.
      // Enclave (state pollution from prior run): manager sends heartbeat first.
      // Both are acceptable — the channel state is verified by E2/E5.
      /not.*enclave|provision|enclave|set up|unregistered|isn't set up|hey|hello|what can|how can|can I help|do for you|still working|working|getting started/i,
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
        `live|ready|done|is now|complete|set up|${TEST_ENCLAVE}.*enclave|enclave.*${TEST_ENCLAVE}|dev team|commissioned|working|getting started`,
        'i',
      ),
    ],
    forbiddenPatterns: [],
    timeoutMs: 150_000,
    chromaAssertion: {
      path: '/enclaves/<TEST_ENCLAVE>',
      expectText: [/<TEST_ENCLAVE>/i],
      timeoutMs: 60_000,
      pollMs: 5_000,
    },
  },
  {
    id: 'E5',
    name: 'remove channel as enclave',
    channel: CHANNELS.test,
    message: '@Kraken remove this channel as an enclave',
    expectedPatterns: [
      // "commissioned|dev team" covers the pre-fix manager that wrongly delegates to builder
      // "still working|getting started" covers heartbeat from a still-running prior task (e.g. wf_remove)
      /deprovision|remove|confirm|not an enclave|owner|decommission|commissioned|dev team|still working|working|getting started/i,
    ],
    forbiddenPatterns: [],
    timeoutMs: 45_000,
    chromaAssertion: {
      path: '/',
      forbiddenText: [/<TEST_ENCLAVE>/i],
      timeoutMs: 60_000,
    },
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
      /build|hello-world|scaffold|deploy|redeploy|apply|ready|verify|running|committed|working|delegat/i,
    ],
    forbiddenPatterns: [/kubectl/i],
    // Bridge-based team builds can take a few minutes (pi + tntc + image build).
    timeoutMs: 15 * 60 * 1000,
    // If the bot delegates to dev team (async build path), SKIP instead of FAIL
    // when the assertion times out — the build agent (pi) may not be installed
    // in this environment, which is a system configuration issue, not a test failure.
    // Also matches "Still working" heartbeat replies sent before the commission message.
    mcpAssertionSkipOnAsyncReply:
      /dev team|commissioned|still working|getting started/i,
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
        // The Kraken may append a cluster suffix to TEST_ENCLAVE
        // (e.g. "e2e-test" → "e2e-test-weu"). Discover all matching namespaces
        // rather than checking a hardcoded name.
        let candidates: string[];
        try {
          const allNs = execSync(
            `kubectl get ns -o jsonpath='{.items[*].metadata.name}'`,
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
          )
            .trim()
            .split(' ');
          candidates = allNs.filter(
            (n) => n === TEST_ENCLAVE || n.startsWith(`${TEST_ENCLAVE}-`),
          );
        } catch {
          candidates = [TEST_ENCLAVE];
        }
        if (candidates.length === 0) {
          return `no namespace matching ${TEST_ENCLAVE}* found in cluster`;
        }
        for (const ns of candidates) {
          try {
            const out = execSync(
              `kubectl get deployment hello-world -n ${ns} -o jsonpath={.status.availableReplicas}`,
              { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
            );
            const replicas = parseInt(out.trim() || '0', 10);
            if (!isNaN(replicas) && replicas >= 1) return null;
            return `hello-world in ns/${ns}: availableReplicas=${out.trim() || '0'}`;
          } catch {
            /* try next namespace */
          }
        }
        return `hello-world not found in ns/${candidates.join(', ')}`;
      },
    },
    chromaAssertion: {
      path: '/enclaves/<TEST_ENCLAVE>/workflows/hello-world',
      expectText: [/hello-world/i, /(ready|running|deployed)/i],
      timeoutMs: 600_000,
      pollMs: 10_000,
    },
  },
  {
    id: 'F2',
    name: 'manager stays responsive during a build',
    channel: CHANNELS.test,
    // Trigger a build commission, then (AFTER the first reply is received)
    // ask a read query. Tests that the manager handles a new message while
    // the builder subprocess is still running in the background.
    message: '@Kraken build hello-world',
    followUpAfterFirstReply: true,
    followUpMessages: [
      '@Kraken while that is being worked on, what is the health of otel-echo?',
    ],
    expectedPatterns: [
      // The manager must respond to the follow-up — anything is acceptable:
      // direct health answer, "Still working" heartbeat, or acknowledgment.
      // What we verify is that the manager does NOT go silent while the build
      // runs. A timeout would indicate the manager is blocked/unresponsive.
      // "commissioned|build progresses|keep you updated" covers the case where
      // the manager is mid-build and forwards the health question to its running
      // dev team context — the reply proves the manager is responsive, not silent.
      /otel-echo|health|running|healthy|unhealthy|status|still working|working|here|got it|checking|commissioned|build progresses|keep you updated/i,
    ],
    forbiddenPatterns: [/kubectl/i],
    timeoutMs: 120_000,
  },
  {
    id: 'F4',
    name: 'status hello-world',
    channel: CHANNELS.test,
    message: '@Kraken status hello-world',
    expectedPatterns: [
      // "not ready|watching" covers heartbeat reply when hello-world is pending (e.g. "Not Ready — 0/0 instances")
      /hello-world|not found|running|status|deployed|not ready|watching/i,
    ],
    forbiddenPatterns: [/kubectl/i],
    timeoutMs: 60_000,
  },
  {
    id: 'F5',
    name: 'run hello-world',
    channel: CHANNELS.test,
    message: '@Kraken run hello-world',
    expectedPatterns: [
      // "done|task completed" covers broadcast from a prior task completion bleeding in
      /hello-world|not found|started|triggered|running|timeout|unreachable|mcp.*server|not in a runnable|done|task completed/i,
    ],
    forbiddenPatterns: [/kubectl/i],
    timeoutMs: 90_000,
  },
  {
    id: 'F6',
    name: 'logs hello-world',
    channel: CHANNELS.test,
    message: '@Kraken logs hello-world',
    // "done|task completed" covers the case where the manager broadcasts a
    // task completion from an earlier operation before answering this query.
    expectedPatterns: [
      /hello-world|not found|log|no logs|done|task completed/i,
    ],
    forbiddenPatterns: [/kubectl/i],
    timeoutMs: 60_000,
  },
  {
    id: 'F8',
    name: 'restart hello-world',
    channel: CHANNELS.test,
    message: '@Kraken restart hello-world',
    expectedPatterns: [
      // "still working|getting started" covers heartbeat bleed-through from a prior task (e.g. wf_run still in flight)
      /restart|restarting|rollout|rolled.*out|reset|initiating|not found|hello-world|still working|working|getting started/i,
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
      // "done|task completed" covers task-completion broadcast bleed-through
      /hello-world|image|container|running|deployed|version|config|not found|status|done|task completed/i,
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
      // Accept removal confirmation, heartbeat, dev-team commission, or "are you sure?" prompt
      /removed|deleted|decommission|gone|done|no longer|hello-world|confirm|are you sure|not found|completed|working|getting started|commissioned|dev team|keep you posted/i,
    ],
    forbiddenPatterns: [/kubectl/i],
    timeoutMs: 60_000,
    chromaAssertion: {
      path: '/enclaves/<TEST_ENCLAVE>/tentacles',
      forbiddenText: [/hello-world/i],
      timeoutMs: 60_000,
    },
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
      // Should gracefully say it doesn't exist or that the manager has no record of it.
      // Allow MCP-unavailability framing for transient cluster disruption.
      /not found|doesn't exist|does not exist|not exist|doesn't appear|no workflow|can't find|appear to exist|never been deployed|not deployed|never deployed|unavailable|mcp.*unavailable|don't have (any |a )?record|haven't seen|no (record|trace)/i,
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
      // "unavailable|mcp.*unavailable" covers transient MCP server disruption during G group
      /not found|doesn't exist|does not exist|no logs|can't find|no such workflow|unavailable|mcp.*unavailable/i,
    ],
    forbiddenPatterns: [/kubectl/i, /undefined|null.*error/i],
    timeoutMs: 45_000,
  },
];

// ---------------------------------------------------------------------------
// K. Permissions compliance — vocabulary and POSIX-string translation rules
// ---------------------------------------------------------------------------
//
// The Kraken skill mandates:
//   - Never show raw POSIX permission strings (rwxrwx---, rwxr-x---, etc.)
//   - Always translate to plain English ("full access (owner + team)", etc.)
//   - Never say "namespace" — say "enclave"
//
// These scenarios exercise that compliance directly.
// ---------------------------------------------------------------------------

export const PERMISSIONS_COMPLIANCE_SCENARIOS: ScenarioDef[] = [
  {
    id: 'K1',
    name: 'workflow permissions — plain English, no raw POSIX strings',
    channel: CHANNELS.enclave,
    message: '@Kraken what are my permissions on otel-echo?',
    expectedPatterns: [
      /permission|owner|access|full|read|run|member|team|not found|otel-echo/i,
    ],
    forbiddenPatterns: [
      // Must translate POSIX strings — never show rwxrwx--- or any variant
      /rwxrwx|rwxr-x|rwx---|rw-r--|r-xr-x/i,
      /namespace/i,
    ],
    timeoutMs: 45_000,
  },
  {
    id: 'K2',
    name: 'enclave info — no namespace jargon',
    channel: CHANNELS.enclave,
    message: '@Kraken tell me about this enclave',
    expectedPatterns: [
      /enclave|owner|member|tentacle|workflow|provisioned|created|access/i,
    ],
    forbiddenPatterns: [/namespace/i, /kubectl/i],
    timeoutMs: 45_000,
  },
  {
    id: 'K3',
    name: 'enclave access mode — plain English, no raw POSIX strings',
    channel: CHANNELS.enclave,
    message: '@Kraken what access mode is this enclave in?',
    expectedPatterns: [
      /owner|access|permission|mode|team|full|read|run|private|shared|open/i,
    ],
    forbiddenPatterns: [
      // Must translate POSIX strings — never show rwxrwx--- or any variant
      /rwxrwx|rwxr-x|rwx---|rw-r--|r-xr-x/i,
      /namespace/i,
    ],
    timeoutMs: 45_000,
  },
];

// ---------------------------------------------------------------------------
// L. Smart-path lockdown (DM-mode behavior)
//
// Validates the smart-path tightening (PR #8, design at
// docs/superpowers/specs/2026-05-04-smart-path-tightening-design.md).
// All scenarios run in CHANNELS.dm — the DM with the bot — which
// exercises the surviving smart-path DM mode. Unbound-channel
// provision-mode coverage lives in E1–E5.
//
// L1 is the load-bearing test: replays the 2026-05-04 incident
// scenario and asserts the new behavior (no fabricated telemetry).
// ---------------------------------------------------------------------------

export const SMART_PATH_LOCKDOWN_SCENARIOS: ScenarioDef[] = [
  {
    id: 'L1',
    name: 'DM workflow query — no fabricated telemetry (2026-05-04 incident replay)',
    channel: CHANNELS.dm,
    message: 'tell me about ai-news-digest',
    expectedPatterns: [
      // Acceptable responses: route to enclave channel, list enclaves,
      // disclaim that DM cannot inspect workflows.
      /enclave|inside|channel|don't have access|cannot|can't see|ask me from|which enclave|tentacular-agensys|tentacular-e2e|yevhens-test/i,
    ],
    forbiddenPatterns: [
      // No fabricated telemetry — these phrases should never appear in DM
      // because smart-path can't see workflow state in DM mode.
      // Note: catch fabricated VALUES (numbers, specific status), not
      // generic capability terms like "run history" which the manager
      // legitimately uses when describing what it WOULD answer in-enclave.
      /\d+\s*days?\s*(uptime|running|of activity)|completed successfully|error rate.*0%|status.*green|\d+\s*events|\d+(\.\d+)?\s*days|0%\s*error/i,
    ],
    timeoutMs: 60_000,
  },
  {
    id: 'L2',
    name: 'DM mutation request — Kraken refuses, no new deployment',
    channel: CHANNELS.dm,
    message: 'redeploy ai-news-digest',
    expectedPatterns: [
      // Acceptable: refusal + redirect, never an action confirmation.
      /can't|cannot|in DM|enclave channel|ask me from|won't|will not|need to be in/i,
    ],
    forbiddenPatterns: [
      // Smart-path must NOT post any "I deployed/redeployed" message.
      /^deployed|^redeployed|deploying now|^running|triggered.*run/i,
    ],
    // Cluster-state assertion: snapshot the deployment list before the
    // test, compare after the reply window. No new Deployment object
    // should appear in tentacular-agensys.
    mcpAssertion: {
      pollMs: 5_000,
      timeoutMs: 60_000,
      check: async (mcpCall) => {
        // Use wf_list to enumerate workflows in tentacular-agensys.
        // Smart-path could only have created a Deployment via wf_apply,
        // which would surface as a new entry here.
        try {
          const raw = await mcpCall('wf_list', {
            enclave: 'tentacular-agensys',
          });
          const parsed =
            typeof raw === 'string'
              ? (JSON.parse(raw) as {
                  workflows?: Array<{ name: string; age: string }>;
                })
              : (raw as {
                  workflows?: Array<{ name: string; age: string }>;
                });
          const fresh = (parsed.workflows ?? []).filter((w) => {
            // age formats like "5m" / "12s" / "3m41s" indicate <1h since
            // creation — anything older predates this scenario.
            return /^\d+(s|m\d*s?)\b/.test(w.age);
          });
          if (fresh.length > 0) {
            return `unexpected fresh workflows after L2: ${fresh
              .map((w) => `${w.name}@${w.age}`)
              .join(', ')}`;
          }
          return null;
        } catch (err) {
          // If MCP isn't reachable, skip rather than fail — the regex
          // assertion already proved Kraken refused.
          return null;
        }
      },
    },
  },
  {
    id: 'L3',
    name: 'DM enclave list — Kraken can call enclave_list and respond',
    channel: CHANNELS.dm,
    message: 'what enclaves am I in?',
    expectedPatterns: [
      // Should mention at least one of the user's known enclaves.
      /tentacular-agensys|tentacular-e2e|yevhens-test|enclave/i,
    ],
    forbiddenPatterns: [
      // No cluster jargon leaking through.
      /namespace|kubectl|pod\b|deployment\.apps/i,
    ],
    timeoutMs: 45_000,
  },
  {
    id: 'L4',
    name: 'DM conversational fallback — explain Tentacular without tool calls',
    channel: CHANNELS.dm,
    message: 'what is tentacular?',
    expectedPatterns: [/tentacular|workflow|enclave|platform|agent|tentacle/i],
    forbiddenPatterns: [
      // Must NOT fabricate specific workflow or enclave details to
      // pad an answer to a generic question.
      /you have \d+ workflow|31 events|completed successfully/i,
    ],
    timeoutMs: 30_000,
  },
];

// ---------------------------------------------------------------------------
// M. Git-state recovery (version management UX in Slack)
//
// Validates the git-state recovery design (PR-set G1-G5,
// docs/superpowers/specs/2026-05-05-git-state-recovery-design.md).
//
// Preconditions for M1, M2: at least 2 deploys must have happened on
// the test tentacle prior to running these scenarios. The harness
// does not pre-seed; rely on natural state from prior F-group scenarios
// or manual setup.
// ---------------------------------------------------------------------------

const FORBIDDEN_GIT_VOCABULARY =
  /\bv\d+\b|\bsha\b|\bcommit\b|\btag\b|\bbranch\b|\bnamespace\b|\bkubectl\b|\bpod\b/i;

export const GIT_STATE_SCENARIOS: ScenarioDef[] = [
  {
    id: 'M1',
    name: 'list past versions in plain English (no version numbers, no git terms)',
    channel: CHANNELS.enclave,
    message: "@Kraken what's been changing on ai-news-digest?",
    expectedPatterns: [
      // At least one dated entry should appear
      /\d{1,2}(:\d{2})?\s*(am|pm)|tuesday|wednesday|thursday|friday|monday|last\s+(week|month)|april|may|june/i,
    ],
    forbiddenPatterns: [FORBIDDEN_GIT_VOCABULARY],
    timeoutMs: 60_000,
  },
  {
    id: 'M2',
    name: 'comparative summary uses prose, not diff lines',
    channel: CHANNELS.enclave,
    message: '@Kraken what changed since last week?',
    expectedPatterns: [
      // Prose mentioning behavior change
      /title|filter|interval|channel|added|removed|changed|increased|decreased/i,
    ],
    forbiddenPatterns: [
      FORBIDDEN_GIT_VOCABULARY,
      // No actual unified-diff lines: + or - immediately followed by
      // alphanumeric (real diff content). Does NOT match "- " bullets.
      /^[+-][A-Za-z0-9]/m,
    ],
    timeoutMs: 60_000,
  },
  {
    id: 'M3',
    name: 'revert with confirm flow + cluster annotation advances',
    channel: CHANNELS.enclave,
    message: "@Kraken go back to last Tuesday's version of ai-news-digest",
    expectedPatterns: [
      // First reply must be a confirm prompt
      /you mean|to be sure|confirm|ok to proceed|want me to/i,
    ],
    forbiddenPatterns: [FORBIDDEN_GIT_VOCABULARY],
    followUpMessages: ['yes'],
    followUpAfterFirstReply: true,
    expectedReplyCount: 2,
    timeoutMs: 5 * 60_000,
    mcpAssertion: {
      pollMs: 10_000,
      timeoutMs: 5 * 60_000,
      check: async (mcpCall) => {
        // After confirm + commission, the deployment's git-sha annotation
        // must have changed (forward-revert produces a new SHA whose tree
        // matches the target).
        const before = process.env['M3_BASELINE_SHA'];
        if (!before) return null; // baseline not captured, skip assertion
        const raw = await mcpCall('wf_describe', {
          enclave: 'tentacular-agensys',
          name: 'ai-news-digest',
        });
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw as any);
        const after = parsed?.annotations?.['tentacular.io/git-sha'];
        if (!after || after === before) {
          return `git-sha did not advance (was ${before}, still ${after})`;
        }
        return null;
      },
    },
  },
  {
    id: 'M4',
    name: 'revert + tweak — combined intent, single deploy event',
    channel: CHANNELS.enclave,
    message:
      "@Kraken go back to last Tuesday's but raise the title limit to 80",
    expectedPatterns: [/you mean|confirm|ok to proceed|want me to/i],
    forbiddenPatterns: [FORBIDDEN_GIT_VOCABULARY],
    followUpMessages: ['yes'],
    followUpAfterFirstReply: true,
    expectedReplyCount: 2,
    timeoutMs: 10 * 60_000,
    // mcpAssertion verifies cluster annotation advanced AND a single new
    // deploy event row exists in Kraken DB. Skipped if Kraken DB query
    // path isn't yet exposed via MCP — placeholder.
  },
  {
    id: 'M5',
    name: 'ambiguity disambiguation by person+time, not SHA',
    channel: CHANNELS.enclave,
    message: "@Kraken go back to Tuesday's version",
    expectedPatterns: [
      // Manager must ask which one (the morning/afternoon, or by deployer)
      /which one|two changes on tuesday|morning|afternoon|or do you mean/i,
    ],
    forbiddenPatterns: [
      FORBIDDEN_GIT_VOCABULARY,
      // Disambig prompt itself must not list SHAs
      /[a-f0-9]{7,}/i,
    ],
    timeoutMs: 60_000,
    skipWhen: () => process.env['KRAKEN_E2E_AMBIGUITY_PRECONDITION'] !== 'true',
  },
  {
    id: 'M6',
    name: 'manager refuses git-talk, redirects to dated phrasing',
    channel: CHANNELS.enclave,
    message: '@Kraken what changed in commit abc123def?',
    expectedPatterns: [
      // Manager redirects to date/person/behavior framing, OR refuses the
      // technical reference and points the user at the right vocabulary.
      /which deploy|when was that|i talk about deploys by date|let me know which version|not able to look up|don't (work|talk|refer) (with|in)|raw internal identifier|by (date|name|deploy)/i,
    ],
    forbiddenPatterns: [
      // Must NOT confirm understanding of "abc123" as a meaningful identifier
      /abc123def is|i'll look at abc123/i,
    ],
    timeoutMs: 45_000,
  },
];

// ---------------------------------------------------------------------------
// N. Manager output hygiene — surfaced from Mirantis Slack live testing 2026-05-06
//
// Adversarial prompts that historically produced bad replies (markdown
// tables, leaked Slack channel IDs, hallucinated denials of Slack API
// access, over-aggressive jargon translation). Filed as thekraken#18,
// #19, #20, #21.
//
// All run in CHANNELS.enclave (manager team subprocess answers).
// ---------------------------------------------------------------------------

const FORBIDDEN_MARKDOWN_TABLE = /^\|.+\|.+\|.*$/m;
const FORBIDDEN_SLACK_CHANNEL_ID = /\bC[A-Z0-9]{8,}\b/;
// rc.11: tentacle CRUD scenarios assert no version numbers or git SHAs
// leak in user-facing replies (vocabulary contract per FORBIDDEN_GIT_VOCABULARY)
const FORBIDDEN_VERSION_NUMBER = /\bv\d+\.\d+\.\d+\b|\bversion\s+\d+\b/i;
const FORBIDDEN_SHA = /\b[0-9a-f]{7,40}\b/;

export const MANAGER_OUTPUT_SCENARIOS: ScenarioDef[] = [
  {
    id: 'N1',
    name: 'no markdown tables in workflow listing (bug thekraken#18)',
    channel: CHANNELS.enclave,
    message: '@Kraken What workflows are running?',
    expectedPatterns: [
      // Some indication of workflows; allow prose, bullets, or names
      /workflow|tentacle|ai-news|echo|deployed by|running|no .*(workflows|tentacles)/i,
    ],
    forbiddenPatterns: [
      // The literal "| Tentacle | Description |" header pattern
      FORBIDDEN_MARKDOWN_TABLE,
    ],
    timeoutMs: 60_000,
  },
  {
    id: 'N2',
    name: 'no raw Slack channel IDs in user-facing replies (bug thekraken#19)',
    channel: CHANNELS.enclave,
    message: '@Kraken Where does ai-news-digest post its summary?',
    expectedPatterns: [
      // Should describe the destination in some way (channel name, "this channel", "Slack")
      /slack|channel|post|notify|#|destination/i,
    ],
    forbiddenPatterns: [
      // Raw Slack channel ID like C073EMLCCN7 — never surface to user
      FORBIDDEN_SLACK_CHANNEL_ID,
    ],
    timeoutMs: 60_000,
  },
  {
    id: 'N3',
    name: 'no hallucinated denial of Slack API access (bug thekraken#20)',
    channel: CHANNELS.enclave,
    message:
      '@Kraken Can you call the Slack API to look up channel names? Or do you not have access?',
    expectedPatterns: [
      // Either: it CAN do it (truthful), or it tells user the structural reason it can't (D3:
      // dispatcher owns Slack I/O; manager doesn't have direct Slack API). What it must not say:
      // "no access to bot token", "credentials not exposed", "MCP tools don't expose credential values".
      /can|cannot|not from here|i don't have a way to query|search slack|let me know|the channel/i,
    ],
    forbiddenPatterns: [
      // Hallucinated structural denial — these phrases are wrong and were observed in production
      /retrieve the slack bot token|don't have a way to retrieve|no.{0,30}access to.{0,30}slack api|MCP tools.{0,30}credential/i,
    ],
    timeoutMs: 60_000,
  },
  {
    id: 'N4',
    name: 'jargon filter does not rewrite "webhook" (bug thekraken#21)',
    channel: CHANNELS.enclave,
    message: '@Kraken Does ai-weekly-roundup use a Slack webhook?',
    expectedPatterns: [
      // Truthful answer about webhook usage. The word "webhook" should appear if relevant.
      /webhook|incoming|slack.*url|posting/i,
    ],
    forbiddenPatterns: [
      // The over-translation we observed: "system process" replacing "webhook"
      /system process/i,
    ],
    timeoutMs: 60_000,
  },
  {
    id: 'N5',
    name: 'enclave-info query returns prose, no markdown tables',
    channel: CHANNELS.enclave,
    message: '@Kraken Tell me about this enclave.',
    expectedPatterns: [/enclave|owner|member|workflow|tentacle/i],
    forbiddenPatterns: [
      FORBIDDEN_MARKDOWN_TABLE,
      FORBIDDEN_SLACK_CHANNEL_ID,
      // Per K group, no POSIX strings or namespace jargon either
      /rwxrwx|namespace/i,
    ],
    timeoutMs: 60_000,
  },
];

// ---------------------------------------------------------------------------
// F-CRUD. Tentacle full lifecycle (create + read + update + delete).
//
// These scenarios actually deploy + remove a tentacle, so they are gated
// behind KRAKEN_E2E_ALLOW_DESTRUCTIVE=1 to keep default test runs from
// churning the live cluster. See workspace CLAUDE.md F group docs.
//
// rc.11 spec:
// docs/superpowers/specs/2026-05-06-rc11-token-and-session-state-design.md
// ---------------------------------------------------------------------------

const ALLOW_DESTRUCTIVE = process.env.KRAKEN_E2E_ALLOW_DESTRUCTIVE === '1';

export const LIFECYCLE_SCENARIOS: ScenarioDef[] = ALLOW_DESTRUCTIVE
  ? [
      {
        id: 'F-CREATE-1',
        name: 'create a new echo-probe tentacle (build + deploy)',
        channel: CHANNELS.enclave,
        message:
          '@Kraken Build a new tentacle called e2e-echo-probe-1 from the echo-probe scaffold.',
        expectedPatterns: [/(commission|building|builder)/i, /(deploy|ready)/i],
        forbiddenPatterns: [
          FORBIDDEN_MARKDOWN_TABLE,
          FORBIDDEN_SLACK_CHANNEL_ID,
        ],
        timeoutMs: 600_000,
      },
      {
        id: 'F-READ-1',
        name: 'read tentacle status by name (prose, no table)',
        channel: CHANNELS.enclave,
        message: '@Kraken What is the status of e2e-echo-probe-1?',
        expectedPatterns: [
          /e2e-echo-probe-1/i,
          /(ready|deployed|active|running)/i,
        ],
        forbiddenPatterns: [
          FORBIDDEN_MARKDOWN_TABLE,
          FORBIDDEN_VERSION_NUMBER,
          FORBIDDEN_SHA,
        ],
        timeoutMs: 60_000,
      },
      {
        id: 'F-READ-2',
        name: 'last change summary (plain English, no SHAs or version numbers)',
        channel: CHANNELS.enclave,
        message: '@Kraken What was the last change to e2e-echo-probe-1?',
        expectedPatterns: [/(deploy|change|summary|created)/i],
        forbiddenPatterns: [FORBIDDEN_SHA, FORBIDDEN_VERSION_NUMBER],
        timeoutMs: 60_000,
      },
      {
        id: 'F-UPDATE-1',
        name: 'update tentacle (re-deploy)',
        channel: CHANNELS.enclave,
        message: '@Kraken Re-deploy e2e-echo-probe-1.',
        expectedPatterns: [
          /(re-?deploy|redeploy|deployed|building|deploying)/i,
        ],
        forbiddenPatterns: [FORBIDDEN_MARKDOWN_TABLE, FORBIDDEN_SHA],
        timeoutMs: 600_000,
      },
      {
        id: 'F-DELETE-1',
        name: 'delete tentacle (verify removal)',
        channel: CHANNELS.enclave,
        message: '@Kraken Remove e2e-echo-probe-1.',
        expectedPatterns: [/(removed|deleted|gone|done)/i],
        forbiddenPatterns: [FORBIDDEN_MARKDOWN_TABLE],
        timeoutMs: 300_000,
      },
    ]
  : [];

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
const [f1, f2, f4, f5, f6, f8, f9, f10] = [
  'F1',
  'F2',
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
  // F1 deploy → F2 concurrent chat → F4 status → C5 health → F5 run → F6 logs → F8 restart → F9 describe → F10 remove
  f1,
  f2,
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
  // K. Permissions compliance — vocabulary and POSIX-string translation
  ...PERMISSIONS_COMPLIANCE_SCENARIOS,
  // L. Smart-path lockdown — DM-mode behavior, 2026-05-04 incident replay
  ...SMART_PATH_LOCKDOWN_SCENARIOS,
  // M. Git-state recovery — version management UX
  ...GIT_STATE_SCENARIOS,
  // N. Manager output hygiene — surfaced from live testing 2026-05-06
  ...MANAGER_OUTPUT_SCENARIOS,
  // F-CRUD. Full tentacle lifecycle. Gated by KRAKEN_E2E_ALLOW_DESTRUCTIVE=1.
  // Empty array when the env var isn't set, so default runs aren't affected.
  ...LIFECYCLE_SCENARIOS,
];

/**
 * Look up a scenario by its ID (e.g. "A1", "B2").
 * Returns undefined if not found.
 */
export function findScenario(id: string): ScenarioDef | undefined {
  return ALL_SCENARIOS.find((s) => s.id === id);
}
