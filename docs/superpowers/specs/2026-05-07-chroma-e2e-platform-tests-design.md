# Integrated platform E2E tests — Slack + Chroma — Design

**Date:** 2026-05-07
**Status:** awaiting user spec review
**Origin:** rc.13 nats-weu E2E surfaced 35/57 PASS but covers only the Slack/Kraken side. Chroma (the chromatophore observability dashboard) has no live test coverage. Per user direction (2026-05-07): users access Chroma only as a continuation of the Slack conversational UX, so tests must drive Slack actions and verify the resulting state appears correctly in Chroma.

## Goals

1. **Full enclave + tentacle lifecycle** verified end-to-end: provision → build tentacle → run → describe → deprovision, with each Slack-side action's effect verified in Chroma.
2. **Per-component scenario authoring** — Chroma-specific scenario definitions live in `tentacular-chroma`, Slack scenarios stay in `thekraken`. The runner in `thekraken` composes both.
3. **Manual one-time Keycloak login** is acceptable; no automated form-driving for the Keycloak login UI in the v0.10.x line.
4. **nats-weu only** — eastus is semi-production (connected to Mirantis Slack) and out of scope until production-grade replacement lands.

## Non-goals (out of v0.10.x)

- Automated Keycloak login (form-driving). Manual cookie-jar setup is fine.
- eastus or any other cluster.
- Multi-tenant isolation tests (multi-org Chroma access — not yet supported).
- Visual regression tests / pixel-diff snapshots.
- Performance / load tests against Chroma.

## Architecture

### Three scenario patterns, each where it fits

The composite design lets us cover full journeys, retrofit existing scenarios cheaply, and add Chroma-only smoke tests where Slack isn't involved.

#### A. Linear lifecycle scenarios

A single scenario contains an ordered sequence of `slack` and `chroma` steps. Each step has an action + assertion. Used for headline user journeys.

```typescript
{
  id: 'PLAT-LIFECYCLE-1',
  name: 'create enclave → tentacle → run → verify each in Chroma → remove',
  channel: CHANNELS.test,
  steps: [
    { kind: 'slack', message: '@Kraken provision this channel as an enclave',
      expectedPatterns: [/provision|enclave/i] },
    { kind: 'chroma', path: '/enclaves/<TEST_ENCLAVE>',
      expectText: ['<TEST_ENCLAVE>'] },
    { kind: 'slack', message: '@Kraken build a hello-world tentacle from the echo-probe scaffold',
      expectedPatterns: [/build|deploy/i], timeoutMs: 600_000 },
    { kind: 'chroma', path: '/enclaves/<TEST_ENCLAVE>/tentacles/hello-world',
      expectText: ['hello-world', /ready|running|deployed/i] },
    { kind: 'slack', message: '@Kraken run hello-world',
      expectedPatterns: [/started|triggered|run/i] },
    { kind: 'chroma', path: '/enclaves/<TEST_ENCLAVE>/tentacles/hello-world/runs',
      waitForText: ['hello-world'], minRowCount: 1 },
    { kind: 'slack', message: '@Kraken remove hello-world',
      expectedPatterns: [/removed|gone/i] },
    { kind: 'slack', message: '@Kraken deprovision this channel',
      expectedPatterns: [/deprov|removed/i] },
  ],
  gatedBy: 'KRAKEN_E2E_ALLOW_DESTRUCTIVE',
}
```

Lives in `thekraken/test/e2e-platform/scenarios.ts` (NEW dir).

#### B. Existing scenarios + `chromaAssertion` field

Augment the existing `ScenarioDef` with an optional `chromaAssertion` mirror to `mcpAssertion`. After the Slack reply assertion passes, the runner navigates to a Chroma URL and runs a check.

```typescript
chromaAssertion?: {
  /** URL path on Chroma — TEST_ENCLAVE / TEST_TENTACLE substituted. */
  path: string;
  /** Expected text/patterns on the page. */
  expectText?: Array<string | RegExp>;
  /** Forbidden text/patterns. */
  forbiddenText?: Array<string | RegExp>;
  /** Poll for up to this long for the check to pass. */
  timeoutMs?: number;
  pollMs?: number;
};
```

Used to retrofit ~10–15 existing scenarios:
- F1 (deploy hello-world) → chroma shows hello-world tentacle
- F4 (status hello-world) → chroma shows status badge
- F10 (remove hello-world) → chroma no longer shows hello-world
- E2 (provision) → chroma shows the enclave
- E5 (deprovision) → chroma no longer shows the enclave
- M3 (revert) → chroma reflects new version
- N1, N5 (workflow listings) → chroma list page renders without table-format errors

Lives in the existing `thekraken/test/e2e-slack/scenarios.ts` — one-line addition per scenario.

#### C. Standalone Chroma scenarios

Pure Chroma tests with no Slack involvement. Live in `tentacular-chroma/test/e2e/scenarios.ts`. The runner imports them.

```typescript
{
  id: 'CHROMA-SMOKE-1',
  name: 'unauthenticated user is redirected to Keycloak login',
  // No channel, no message — Chroma only.
  chromaPath: '/',
  expectRedirect: /\/auth\/realms\/tentacular\/protocol\/openid-connect\/auth/,
}
```

Coverage:
- CHROMA-SMOKE-1: unauthenticated → login redirect
- CHROMA-SMOKE-2: authenticated `/` loads, shows enclave list
- CHROMA-SMOKE-3: authenticated `/enclaves/<known>` loads (deep-link from Slack)
- CHROMA-SMOKE-4: deprovisioned enclave does NOT appear in `/`
- CHROMA-SMOKE-5: 404 on unknown enclave path
- CHROMA-SMOKE-6: read-only — no POST/PUT/DELETE form fields rendered (smoke check)
- CHROMA-SMOKE-7: tentacle detail page renders DAG node list

### Runner architecture

```
thekraken/test/
├── e2e-slack/                         # existing — Slack scenarios
│   ├── scenarios.ts                   # + chromaAssertion field added (B)
│   ├── slack-driver.ts                # existing
│   ├── harness.ts                     # extended to run chromaAssertion
│   └── run-all.ts                     # extended to load other scenario sources
│
├── e2e-platform/                      # NEW — lifecycle (A) scenarios
│   ├── scenarios.ts                   # PLAT-LIFECYCLE-* scenarios
│   └── lifecycle-runner.ts            # walks step list, dispatches to slack/chroma drivers
│
└── e2e-chroma/                        # NEW — Chroma driver + import bridge
    ├── chroma-driver.ts               # Playwright wrapper: navigate, wait, assert
    ├── chroma-session.ts              # browser-context lifecycle, persisted login
    └── load-chroma-scenarios.ts       # imports tentacular-chroma/test/e2e/scenarios.ts

tentacular-chroma/test/
└── e2e/
    └── scenarios.ts                   # CHROMA-SMOKE-* scenarios (C)
```

The thekraken runner imports Chroma scenarios via relative path from the sibling repo:

```typescript
// thekraken/test/e2e-chroma/load-chroma-scenarios.ts
import { CHROMA_SCENARIOS } from '../../../tentacular-chroma/test/e2e/scenarios.js';
```

This is acceptable because both repos sit in `~/code/tentacular-main/` and are pinned together via lockstep tags. If the path doesn't resolve at build time, the loader falls back to an empty array with a warning, so thekraken can build standalone.

### ChromaDriver

A thin Playwright wrapper, parallel to `SlackDriver`:

```typescript
export interface ChromaDriver {
  /** Navigate to a path under the configured Chroma base URL. */
  goto(path: string): Promise<void>;

  /** Wait for the page to settle, then return innerText of <body>. */
  pageText(): Promise<string>;

  /** Wait for text to appear (poll up to timeoutMs). */
  waitForText(needle: string | RegExp, timeoutMs?: number): Promise<void>;

  /** Assert no occurrence of the patterns. */
  assertNoText(patterns: Array<string | RegExp>): Promise<void>;

  /** Capture screenshot for debugging on failure. */
  screenshot(): Promise<Buffer>;

  /** Close the browser context. */
  close(): Promise<void>;
}
```

The driver wraps `mcp__playwright__*` tools or a direct Playwright import — whichever is more reliable in our test environment. Single browser context for the whole run; the manual login cookies are persisted on disk under `~/.kraken-e2e-chroma/` so subsequent runs reuse them until expired.

### Session management

- **First run on a workspace:** runner detects no auth cookie, prompts the user to log in once via the URL printed to stdout. Test paused until cookies file appears.
- **Subsequent runs (within Keycloak refresh window):** cookies loaded from disk, browser context starts logged in, no prompt.
- **Cookies expired:** runner detects login redirect on first navigate, prompts user to re-login, resumes.

Persistence path: `process.env.KRAKEN_E2E_CHROMA_COOKIES ?? ~/.kraken-e2e-chroma/cookies.json`.

### Configuration

New env vars:
- `KRAKEN_E2E_CHROMA_BASE_URL` — default `https://chroma.westeurope-dev1.ospo-dev.miralabs.dev`
- `KRAKEN_E2E_CHROMA_COOKIES` — path to persisted cookie jar
- `KRAKEN_E2E_DISABLE_CHROMA` — set to `1` to skip all Chroma scenarios (useful for CI without VPN access)

Existing env vars unchanged.

### Order in `ALL_SCENARIOS`

The aggregate order in `run-all.ts` becomes:

```
A. Identity (existing)
B. Vocabulary (existing)
C. Workflow ops (existing, some with chromaAssertion retrofit)
D. Commands (existing)
I. Membership (existing)
J. Thread memory (existing)
E. Provisioning (existing, E2/E5 with chromaAssertion)
F. Tentacle lifecycle (existing, with chromaAssertion retrofit)
G. Error paths (existing)
H. RBAC (existing)
K. Permissions vocab (existing)
L. Smart-path lockdown (existing)
M. Git-state recovery (existing, M3 with chromaAssertion)
N. Manager output hygiene (existing)
PLAT-LIFECYCLE-* (NEW, gated by KRAKEN_E2E_ALLOW_DESTRUCTIVE)
CHROMA-SMOKE-* (NEW, no gate)
```

Pattern A and Pattern C scenarios run after the existing groups so they can rely on or test against the state earlier scenarios produced.

## Components

| Component | File | Responsibility |
|---|---|---|
| Scenario shape extension | `thekraken/test/e2e-slack/scenarios.ts` | Add optional `chromaAssertion` field to `ScenarioDef` |
| Lifecycle scenarios | `thekraken/test/e2e-platform/scenarios.ts` | Define PLAT-LIFECYCLE-* scenarios with step lists |
| Lifecycle runner | `thekraken/test/e2e-platform/lifecycle-runner.ts` | Walk a scenario's step array, dispatch to slack/chroma drivers, aggregate results |
| Chroma driver | `thekraken/test/e2e-chroma/chroma-driver.ts` | Playwright-based navigation + DOM assertion helpers |
| Session manager | `thekraken/test/e2e-chroma/chroma-session.ts` | Persist + restore browser cookies, prompt on first login |
| Chroma scenario loader | `thekraken/test/e2e-chroma/load-chroma-scenarios.ts` | Import CHROMA_SCENARIOS from tentacular-chroma/ |
| Chroma scenario definitions | `tentacular-chroma/test/e2e/scenarios.ts` | CHROMA-SMOKE-* — standalone Chroma assertions |
| Runner integration | `thekraken/test/e2e-slack/run-all.ts` | Aggregate all three scenario sources, dispatch each to its runner, single Chroma session for the run |
| Chroma assertion executor | `thekraken/test/e2e-slack/harness.ts` | When `chromaAssertion` present on a scenario, run it after the Slack reply check |

## Data flow — lifecycle scenario

```
Test runner (run-all.ts)
   │
   │ 1. boot Slack drivers (existing)
   │ 2. boot Chroma session (read cookies / prompt for login)
   │ 3. for each scenario in ALL_SCENARIOS (with new groups appended):
   │
   ├── if scenario has steps[] (Pattern A):
   │     └── lifecycle-runner walks steps:
   │           - kind='slack' → SlackDriver.postAsUser + waitForKrakenReply, assert patterns
   │           - kind='chroma' → ChromaDriver.goto + assertions
   │           - any failure aborts the scenario, attempts cleanup, records FAIL
   │
   ├── if scenario has chromaAssertion (Pattern B):
   │     └── existing harness runs scenario as today, then runs chromaAssertion as
   │         a poll-loop (matches mcpAssertion shape)
   │
   └── if scenario has chromaPath (Pattern C):
         └── ChromaDriver.goto + assertions; no Slack drivers used
```

## Error handling

- **Chroma not configured (no Playwright, env var disabled):** all Chroma-touching scenarios SKIP with a clear note. The Slack-only path still runs.
- **First-run, no cookies:** runner prints a login URL + cookie capture instructions, waits up to 10 minutes for the cookie file to appear, then continues.
- **Cookies expired mid-run:** the in-flight scenario fails with a clear error; the runner exits 1 (no auto-resume — manual relogin needed).
- **VPN dropped during run:** Chroma navigations time out; scenario marked ERROR; the run continues (other scenarios may still pass if they don't touch Chroma).
- **Chroma 5xx on a navigate:** scenario marked FAIL with the captured response status. The next scenario continues.

## Testing

This design *is* the test framework — there are no unit tests for the framework itself in this RC line. The framework's correctness is validated by:

1. The PLAT-LIFECYCLE-1 scenario passing means the framework + drivers + runner integration work end-to-end.
2. CHROMA-SMOKE-1 (login redirect) verifies the auth boundary is respected.
3. CHROMA-SMOKE-3 (deep-link) verifies the Slack→Chroma URL contract.

If the framework needs unit tests later (e.g., for the lifecycle-runner's step dispatch), those land in a follow-up.

## Risks

- **Cross-repo import** (`thekraken` importing from `tentacular-chroma/test/e2e/`) creates a build-time path dependency on a sibling checkout. Mitigated by defensive loader (returns empty array on missing import). If this becomes painful, the alternative is publishing Chroma scenarios as a tiny npm package or copying them at build time.
- **Manual login is friction.** Mitigated by 12-hour Keycloak refresh window — most test runs don't need re-login. If Keycloak access-token TTL is shorter than expected, we'll feel this and need to either automate the login OR raise the realm's session TTL.
- **Playwright dependency** adds bundle size to thekraken's test deps. Acceptable — only a test dep, not shipped in the production image.
- **Lifecycle scenarios pollute cluster state on failure mid-flow.** Mitigated by always attempting deprovision in a finally-block. If that fails, manual cleanup — same risk we already accept for the F-CRUD scenarios in rc.11.

## Phase rollout

| Phase | Scope | Effort |
|---|---|---|
| **C1** | Chroma driver + session + ONE smoke scenario (CHROMA-SMOKE-1: unauthenticated → login redirect). Establishes the framework. | small |
| **C2** | Manual cookie persistence + CHROMA-SMOKE-2 (authenticated `/` loads). | small |
| **C3** | Pattern B retrofit on E2/E5/F1/F10 (4 existing scenarios get chromaAssertion). | small |
| **C4** | PLAT-LIFECYCLE-1 (full provision → build → run → remove journey). | medium |
| **C5** | Remaining CHROMA-SMOKE-* scenarios (deep-link, 404, deprovisioned, read-only). | small |
| **C6** | Final E2E run with all three patterns + triage. | medium |

C1–C6 land as a single PR `feat(e2e): platform tests with Chroma coverage`, then ship as part of v0.10.x or v0.11.0 depending on what user decides about cutting v0.10.0 final.

## Open questions

None for v0.10.x. Multi-tenant Chroma isolation and automated Keycloak login are tracked as v0.11+ work.
