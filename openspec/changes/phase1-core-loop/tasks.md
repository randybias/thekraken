# Phase 1: Core Loop — Tasks (REVISED for Dispatcher + Team Pivot)

**Change ID:** phase1-core-loop
**Status:** DRAFT (post-pivot 2026-04-13)
**Created:** 2026-04-13
**Revised:** 2026-04-13 (dispatcher + per-enclave-team pivot)
**Author:** Senior Product Manager (initial), Senior Architect (revised)

---

## Execution Order

Tasks numbered in execution order. **[PARALLEL]** marks concurrent tasks.
Each task group commits + passes pre-push gates before the next begins.
Task definitions reference the authoritative design in
`design.md` (post-pivot, ~1,539 lines).

Pre-pivot task numbering preserved for traceability. DoD items that no
longer apply have their original language in `~~strikethrough~~` for
reference; new DoD items marked `[NEW]`.

---

### T01: Add Runtime Dependencies

**Owner:** Developer

Add `pi-mono-team-mode` (as dev-dep reference for type definitions).
Add/confirm `@mariozechner/pi-coding-agent@0.66.1` (provides the `pi` CLI
binary via `node_modules/.bin/pi` — no global install needed; resolves F20).
Confirm `pino`, `@opentelemetry/*`, `@modelcontextprotocol/sdk` already
present from pre-pivot Phase 1 work.

**DoD:**
- [ ] `package.json` includes all required runtime deps
- [ ] `node_modules/.bin/pi` resolves after `npm ci`
- [ ] Dockerfile confirms `pi` binary is reachable at runtime path
- [ ] `npm ci` succeeds, `npx tsc --noEmit` clean, `npm test` passes

---

### T02: Pino Structured Logger

**Status:** DONE (existing `src/logger.ts` survives the pivot).

---

### T03: OTel SDK Initialization

**Status:** DONE (existing `src/telemetry.ts` survives the pivot).

---

### T04: LLM API Key Validation + Teams Dir Config

**Owner:** Developer

Existing LLM key validation DONE. Extend config with teams directory.

**DoD:**
- [x] LLM API key validation (existing)
- [ ] [NEW] `KRAKEN_TEAMS_DIR` env var (default: `/app/data/teams`)
- [ ] [NEW] `KrakenConfig.teamsDir: string` exposed
- [ ] [NEW] Unit test verifies default + override

---

### T05: Enclave Binding Engine (Read-Only)

**Status:** DONE (existing `src/enclave/binding.ts` survives the pivot).

---

### T06: Per-Thread Queue

**Status:** DONE (existing `src/agent/queue.ts` may be used by the dispatcher
smart-path for serialization within a single Slack thread; no work needed
unless a new use case emerges).

---

### T07: NDJSON Protocol Layer **[NEW — replaces MCP HTTP Wrapper in dispatcher]**

**Owner:** Developer

~~Implement `src/agent/mcp-connection.ts` in the dispatcher.~~ (MCP calls
now live inside spawned team subprocesses with user tokens.)

Implement `src/teams/ndjson.ts` — append-only NDJSON writer + reader with
byte-offset tracking. Backs all three team protocol files
(`mailbox.ndjson`, `outbound.ndjson`, `signals.ndjson`).

**DoD:**
- [ ] `appendNdjson(path, record)` appends atomically (fsync semantics)
- [ ] `NdjsonReader` class with `readNew()` returning new records since
      last read; tracks byte offset
- [ ] Handles missing file gracefully (returns empty array)
- [ ] Handles partial lines at EOF (buffered, waits for next read)
- [ ] Records with invalid JSON are logged and skipped (corruption
      recovery)
- [ ] Unit tests for concurrent write + read
- [ ] Unit tests for reader resuming after restart (offset reset)
- [ ] Unit tests for atomic append under simulated crash

---

### T08: System Prompt Builder (Per-Role)

**Owner:** Developer

Existing `src/agent/system-prompt.ts` survives as base builder. Extend with
role-specific builders for manager/builder/deployer.

**DoD:**
- [x] `buildSystemPrompt()` exists (placeholder layers)
- [ ] [NEW] `buildManagerPrompt(enclaveName, userEmail, config)` —
      manager role prompt including tentacular skill, Kraken skill,
      enclave MEMORY.md, `[CONTEXT]` block with user identity
- [ ] [NEW] `buildBuilderPrompt(taskDescription, enclaveName, userEmail)` —
      builder role prompt (coding-focused)
- [ ] [NEW] `buildDeployerPrompt(taskDescription, enclaveName, userEmail)` —
      deployer role prompt (deploy-flow focused)
- [ ] Every role prompt includes the user identity block (D6)
- [ ] Unit tests for all three role prompts + `[CONTEXT]` format assertion

---

### T09: Dispatcher Router **[NEW — replaces CONTEXT injector extension]**

**Owner:** Developer

~~Implement `src/extensions/context-injector.ts` as a pi extension.~~
(`[CONTEXT]` block now assembled inside system prompt builders; see T08.)

Implement `src/dispatcher/router.ts` — deterministic vs smart routing.
This is the contract for **D4 (hybrid paths)**.

**DoD:**
- [ ] `routeEvent(event, deps): RouteDecision` function
- [ ] All deterministic admission criteria from design Section 2.5
      implemented (enclave @mention → `deliver_to_team`, DM unknown →
      `smart_response`, `@kraken add` → `enclave_sync`, etc.)
- [ ] Smart path fallthrough for DMs and ambiguous events
- [ ] Command parser: `parseCommand(text)` for `@kraken add/remove/
      transfer/archive/whoami/members/help`
- [ ] 100% branch coverage on routing logic
- [ ] Unit tests: `test/unit/dispatcher-router.test.ts` table-driven
      with every event type → expected path + outcome

---

### T10: TeamLifecycleManager **[NEW — replaces per-thread Agent runner]**

**Owner:** Developer

~~Implement `src/agent/runner.ts` — per-thread Agent lifecycle.~~

Implement `src/teams/lifecycle.ts` — per-enclave team spawn/monitor/GC.

**DoD:**
- [ ] `TeamLifecycleManager` class: `spawnTeam(enclaveName, initialContext)`,
      `sendToTeam(enclaveName, record)`, `isTeamActive(enclaveName)`,
      `shutdownAll()`, `gcStaleTeams()`
- [ ] Manager subprocess spawned via `child_process.spawn` using
      `node_modules/.bin/pi` (F20 resolution)
- [ ] User's OIDC token passed in subprocess env as `TNTC_ACCESS_TOKEN`
      (D6) — NEVER a service token, NEVER a fallback
- [ ] `PI_SUBAGENT_DEPTH` + `PI_SUBAGENT_MAX_DEPTH` set (depth guard
      to prevent recursive subagent spawning)
- [ ] Team state directory creation (`{KRAKEN_TEAMS_DIR}/{enclave}/`)
- [ ] Idle timeout: 30 minutes of no mailbox activity → SIGTERM (D7)
- [ ] Process exit monitoring with directory state preservation
- [ ] `gcStaleTeams()` sweeps directories older than 7 days with no
      live PID
- [ ] Token expiration detection: mailbox record with expired token
      triggers clean task failure (D6 — no fallback)
- [ ] Unit tests with mock `pi` binary (see T22)
- [ ] Unit tests for cross-user token isolation: two mailbox records
      for the same enclave, different users, each spawns its own
      subprocess (Phase 1) or serializes with correct per-record
      token (Phase 3) — Phase 1 serial is acceptable

---

### T11: Outbound Poller **[NEW — replaces outbound message tracking standalone]**

**Owner:** Developer

~~Standalone `src/slack/outbound.ts` tracking.~~ (SQLite dedup survives;
the polling layer is new.)

Implement `src/teams/outbound-poller.ts` — polls every active team's
`outbound.ndjson` and posts records to Slack via Bolt client.

**DoD:**
- [ ] `OutboundPoller` class with `start()` and `stop()`
- [ ] Polls each active team's `outbound.ndjson` every 1 second
- [ ] Posts messages to correct Slack channel/thread
- [ ] Records outbound messages in SQLite for restart dedup (reuses
      existing `OutboundTracker`)
- [ ] Handles heartbeat records per design Section 8 (friendly
      human-addressed format, 30-60s floor, manager-decided significance)
- [ ] OTel span per outbound post
- [ ] Graceful shutdown: drains outstanding records on stop
- [ ] Unit tests with mock Slack client

---

### T12: Slack Bot (Revised — Dispatcher Routing)

**Owner:** Developer

Refactor `src/slack/bot.ts` from the pre-pivot implementation. Same dual-mode
HTTP + Socket transport. Event handlers now call `routeEvent()` and execute
the returned `RouteDecision`.

**DoD:**
- [ ] `createSlackBot(config, deps)` returns Bolt App (dual-mode
      preserved)
- [ ] `app_mention` handler calls `routeEvent()` and executes result
- [ ] `message` handler calls `routeEvent()` (DMs + thread replies)
- [ ] Deterministic path: spawn/forward to team, NO LLM call
- [ ] Smart path: invoke dispatcher's `AgentSession.prompt()`
- [ ] Bot/self messages ignored
- [ ] Non-enclave channels: silent (D2)
- [ ] OTel spans per event; structured pino logging per event
- [ ] Graceful shutdown
- [ ] Unit tests with mock Slack client + Phase 0 event simulator

---

### T13: Dispatcher Entry Point (Revised)

**Owner:** Developer

Replace pre-pivot `src/index.ts` with dispatcher boot.

**DoD:**
- [ ] Loads config with LLM key validation
- [ ] Initializes pino, OTel, SQLite (with migrations)
- [ ] Creates `AgentSession` via `pi-coding-agent`'s `createAgentSession()`
      with dispatcher custom tools (T15)
- [ ] Creates `TeamLifecycleManager`, `OutboundPoller`,
      `EnclaveBindingEngine`
- [ ] Creates Slack bot with dispatcher deps
- [ ] Starts health endpoint, outbound poller, Slack bot
- [ ] Logs startup banner (version, mode, MCP URL, enclave count,
      teamsDir)
- [ ] SIGTERM/SIGINT: stop poller, stop bot, shutdown all teams,
      flush OTel, exit 0
- [ ] Integration test: startup + shutdown with mocks (mock Slack,
      mock pi binary)

---

### T14: Helm Required Guards + Teams PVC

**Owner:** Developer **[PARALLEL with T13]**

Existing required() guards survive. Add teams directory config + PVC
mount.

**DoD:**
- [x] `values.schema.json` guards (existing)
- [ ] [NEW] `KRAKEN_TEAMS_DIR` in ConfigMap (default `/app/data/teams`)
- [ ] [NEW] PVC mount for teams directory (sub-path of existing PVC)
- [x] NetworkPolicy egress: port 4318 to tentacular-observability
      (existing)
- [x] `helm lint` passes with valid values

---

### T15: Dispatcher Tools (Pi ToolDefinitions)

**Owner:** Developer **[PARALLEL with T13]**

Implement `src/tools/dispatcher-tools.ts` — custom tools for the
dispatcher's `AgentSession` (used on the smart path).

**DoD:**
- [ ] `spawn_enclave_team` tool: delegates to TeamLifecycleManager
- [ ] `send_to_team` tool: appends to mailbox.ndjson via NDJSON writer
- [ ] `check_team_status` tool: reads team signals.ndjson + outbound.ndjson
      and returns structured status summary
- [ ] `post_to_slack` tool: direct Slack WebClient call (for
      dispatcher-originated messages like ephemeral auth cards)
- [ ] All tools registered as pi `ToolDefinition`s and exposed to the
      dispatcher's AgentSession
- [ ] Unit tests for each tool

---

### T16: Validate Full Build Pipeline

**Owner:** Developer

**DoD:**
- [ ] `npm ci`, `npx tsc --noEmit`, `npm run build`, `npm test`,
      `npm run lint`, `npm run format:check` all clean
- [ ] `helm lint charts/thekraken --set gitState.repoUrl=https://github.com/x/y.git --set gitState.credentialsSecret=x`
      passes
- [ ] `shellcheck scripts/entrypoint.sh kraken-hooks/pre-commit` clean

---

## New Testing Infrastructure Tasks (T22–T26)

The pivot requires additional test infrastructure beyond what Phase 0
provided. These tasks build reusable test helpers that T01-T16 and future
phases will depend on.

### T22: Mock Pi Binary for Tests **[NEW]**

**Owner:** Developer

Create `test/mocks/mock-pi.ts` — a small TypeScript program mimicking the
`pi` CLI surface for unit/integration tests. Reads mailbox, writes
outbound and signals according to scripted behavior, idle-exits. Avoids
real LLM calls or real subprocess pi execution.

**DoD:**
- [ ] Mock pi supports `--mode json`, `-p`, `--append-system-prompt`
- [ ] Scriptable behavior via env var (e.g., `MOCK_PI_SCENARIO=build-ok`)
- [ ] Reads `mailbox.ndjson`, writes `outbound.ndjson` + `signals.ndjson`
- [ ] Idle-exits after no mailbox activity for configurable time
- [ ] Unit tests for the mock itself
- [ ] Docs in `test/mocks/README.md`

---

### T23: NDJSON Test Helpers **[NEW]**

**Owner:** Developer

Create `test/helpers/ndjson.ts` — utilities for NDJSON-based test
assertions.

**DoD:**
- [ ] `appendRecord(path, record)` helper
- [ ] `readRecords(path, filter?)` helper
- [ ] `waitForRecord(path, matcher, timeoutMs)` helper (polls)
- [ ] Used by at least 3 other test files (T07, T10, T11)

---

### T24: Team State Dir Fixture **[NEW]**

**Owner:** Developer

Create `test/helpers/team-fixture.ts` — creates + cleans up temp team
directories matching `~/.pi/teams/{name}/` layout.

**DoD:**
- [ ] `createTeamFixture(enclaveName): TeamFixture` returns dir + helpers
- [ ] `TeamFixture.mailbox`, `.outbound`, `.signals` writers/readers
- [ ] `TeamFixture.cleanup()` removes temp dir
- [ ] Integrates with vitest `afterEach`

---

### T25: Dispatcher Routing Matrix Test **[NEW]**

**Owner:** Developer

Create `test/unit/dispatcher-router.test.ts` — table-driven assertion
for every Slack event type → expected routing path (deterministic or
smart) + expected outcome. This IS the contract for D4.

**DoD:**
- [ ] At least 13 admission criteria tested (8 deterministic + 5 smart)
- [ ] Each row: event payload, expected path label, expected action
- [ ] 100% branch coverage on `routeEvent()`
- [ ] Test fails if a new Slack event type is added without an
      admission criterion

---

### T26: Identity Propagation Fixture **[NEW]**

**Owner:** Developer

Create `test/helpers/identity-fixture.ts` — test utility to spawn the
mock pi with a known user token, intercept all outbound writes and MCP
calls, and verify the token appears in every subprocess spawn.

**DoD:**
- [ ] `withUserIdentity(userToken, fn)` runs test under a spawned
      fixture; asserts token propagates to mailbox env + subprocess env
- [ ] Cross-user leak test: user A spawns team, then user B engages;
      assert B's subprocess env does NOT contain A's token
- [ ] Used by PIV1 and PIV5 scenario tests

---

## Scenario Tests (PIV1–PIV7) **[NEW]**

Add the following scenario tests per the execution plan's revised
Testing Strategy. Scenarios P1–P18 and N1–N20 from the design doc §9
still apply but run through the dispatcher/team architecture.

### PIV1: Two users engage same enclave simultaneously
- [ ] Mailbox records interleave with different user tokens
- [ ] Each processed with correct per-record token (Phase 1: serial)
- [ ] No cross-user state bleed in subprocess env

### PIV2: Long-running build with heartbeat
- [ ] Builder runs > 60s, emits progress signals
- [ ] Manager emits heartbeat at 30-60s floor, friendly format
- [ ] Dispatcher posts the heartbeat to the originating thread
- [ ] Fewer than N/60 heartbeats per N-second task

### PIV3: Status check mid-build
- [ ] User asks "what's happening?" while builder runs
- [ ] Dispatcher smart path reads signals, summarizes
- [ ] Builder is NOT interrupted

### PIV4: Manager idle timeout
- [ ] No mailbox records for > 30 min
- [ ] Manager gracefully exits
- [ ] Next engagement spawns fresh team
- [ ] MEMORY.md survives on PVC

### PIV5: Token expires mid-task
- [ ] Manager detects failure, posts re-auth prompt
- [ ] Task fails cleanly
- [ ] NO fallback to service identity (D6)

### PIV6: Team directory GC
- [ ] Stale dir (> 7 days, no PID) swept
- [ ] Active team dirs preserved

### PIV7: Kraken pod restart
- [ ] Teams die with the pod (no resume)
- [ ] New dispatcher pod starts fresh
- [ ] First engagement after restart spawns fresh team

---

### T17: Code Review

**Owner:** Code Reviewer

**DoD:**
- [ ] Dispatcher routing logic reviewed (deterministic vs smart boundary
      is clearly named)
- [ ] Team lifecycle reviewed (spawn, idle, GC, token handling, process
      exit monitoring)
- [ ] NDJSON protocol reviewed (atomicity, concurrency, partial-line
      handling)
- [ ] Outbound poller reviewed (polling interval, error handling,
      dedup correctness)
- [ ] Identity propagation reviewed (D6 compliance — no token leakage
      across users, no service-token fallback)
- [ ] No token logged in any span, log line, or error message
- [ ] No unused deps, no stale Phase-0 TODOs
- [ ] Conventional Commits used throughout
- [ ] Sign-off recorded

---

### T18: Security Review

**Owner:** Senior Security Architect

**DoD:**
- [ ] D6 compliance: user token flows from mailbox → subprocess env,
      NEVER falls back to service identity for enclave work
- [ ] Team state directory permissions: `0o700` for the dir, `0o600`
      for all ndjson files
- [ ] User token never appears in `outbound.ndjson` or `signals.ndjson`
      (only in `mailbox.ndjson` and subprocess env)
- [ ] Subprocess env isolation (spawn creates fresh copy; no PATH
      injection)
- [ ] PVC forensics: stale team dirs cleanly GC'd after 7 days (D7)
- [ ] Sign-off recorded

---

### T19: QA Review

**Owner:** Senior QA Engineer

**DoD:**
- [ ] All Phase 0 + Phase 1 tests pass
- [ ] Router tests cover all 13 admission criteria (T25)
- [ ] Team lifecycle tests cover spawn/idle/shutdown/GC
- [ ] NDJSON tests cover concurrent access + crash recovery
- [ ] Outbound poller tests cover poll + post + dedup
- [ ] PIV1–PIV7 scenario tests all pass
- [ ] Identity propagation fixture exercises cross-user leak tests
- [ ] No flaky tests (100 consecutive runs green)
- [ ] Sign-off recorded

---

### T20: Tech Writer Review

**Owner:** Senior Technical Writer

**DoD:**
- [ ] README updated: dispatcher + team architecture, env vars
      (KRAKEN_TEAMS_DIR, OTEL_*, LOG_LEVEL, LLM keys), filesystem layout
- [ ] Project CLAUDE.md created (Phase 1 dispatcher + team architecture,
      references design doc §6 for file map)
- [ ] Chart README updated with required values per mode + teamsDir docs
- [ ] JSDoc on all public functions in new modules
- [ ] Sign-off recorded

---

### T21: Codex Review

**Owner:** Codex (automated)

**Skippable:** Yes, if Codex MCP unreachable (log reason + timestamp).

**DoD:**
- [ ] Codex reviewed full Phase 1 diff
- [ ] Critical findings addressed; non-critical logged as followups
- [ ] Review logged (verdict + timestamp)
