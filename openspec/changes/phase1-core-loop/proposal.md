# Phase 1: Core Loop — Slack + Pi Agent + MCP Wrapper + Enclave Binding

**Change ID:** phase1-core-loop
**Status:** REVISED (2026-04-13 pivot — see design.md for the authoritative post-pivot architecture)
**Created:** 2026-04-13
**Revised:** 2026-04-13 (dispatcher + per-enclave-team pivot)
**Author:** Senior Product Manager (initial), Senior Architect (revised)
**Branch:** feature/phase1-core-loop

---

## 🚨 POST-PIVOT NOTICE (2026-04-13)

This proposal was written before the architectural pivot. The deliverables
D1-D12 listed below are **still the right things to ship**, but the
technical shape of how they're delivered changed significantly:

- **Architecture is now dispatcher + per-enclave teams**, not a custom
  daemon with bare pi-agent-core. Kraken is a pi-coding-agent in a custom
  Kraken-owned "slack" mode that spawns per-enclave teams via
  `pi-mono-team-mode` + `pi-subagents` patterns.
- **Extensions are standard pi-coding-agent extensions** (not our own
  hook system). Tool-scoping, jargon-filter, context-injector are pi
  extensions.
- **Per-enclave teams** (not per-thread agents) with filesystem NDJSON
  IPC (`mailbox.ndjson`, `outbound.ndjson`, `signals.ndjson`).
- **User-identity hard partition**: every spawned subprocess carries the
  initiating user's OIDC token. No service identities for enclave work.

**Authoritative technical reference:** `design.md` (~1,539 lines, post-pivot).
**Authoritative task list:** `tasks.md` (revised, includes T22-T26 for new
test infrastructure and PIV1-PIV7 scenario tests).

The deliverables and followups below still stand, but always cross-reference
design.md for current implementation shape.

---

---

## Why Phase 1 Exists

Phase 0 delivered a compilable skeleton with test infrastructure, SQLite
schema, git-state plumbing, Helm chart, and CI. None of it does anything at
runtime.

Phase 1 makes the Kraken alive: a Slack bot that receives @mentions in
enclave-bound channels, dispatches per-thread pi Agent instances, connects
those agents to the Tentacular MCP server, and responds conversationally.
This is the minimum viable core loop — the foundation every subsequent phase
(auth, commands, polish, hardening) builds on.

Phase 1 also picks up the SigNoz/OTel observability carryover from Phase 0.
Without instrumentation from day one, the core loop ships blind and operators
have no visibility into agent behavior, MCP call patterns, or Slack event
processing.

---

## PM Decision: Deploy/Rollback Flow Deferral

**Decision:** Defer the deploy/rollback FLOW to Phase 4.

Phase 1 wires up the pi Agent + MCP plumbing and registers all MCP tools in
their scoping categories (ENCLAVE_SCOPED, BLOCKED_IN_ENCLAVE, DM_ALLOWED,
ALWAYS_ALLOWED). The agent CAN call read-only MCP tools (wf_list,
wf_describe, wf_status, wf_health, etc.) in Phase 1.

The deterministic deploy gate logic — explanation validation, git commit,
tag, push, wf_apply with version + git_sha pass-through — requires MCP server
cross-repo work (design Section 14.6a: wf_apply requires version + git_sha
parameters). That cross-repo work is Phase 4. Building the deploy flow before
the MCP server supports it creates a dead path.

Phase 1 scope: "agent can hold a conversation in a thread and call read-only
MCP tools." Phase 4 scope: "agent can deploy tentacles through the full
git-backed versioning pipeline."

**Tracked:** Added to followups as F16 to prevent this from being lost.

---

## What Phase 1 Delivers

### D1: Slack Bot (Dual-Mode Transport)

Implement `src/slack/bot.ts` using @slack/bolt with dual-mode transport
controlled by the existing `SLACK_MODE` env var from Phase 0 config.

**Acceptance Criteria:**

- [ ] HTTP mode (production): Bolt ExpressReceiver on port 3000, events at
      `/slack/events`
- [ ] Socket mode (dev): Bolt SocketModeReceiver using SLACK_APP_TOKEN
- [ ] SLACK_MODE env var selects transport (default: 'http')
- [ ] Health endpoint `/healthz` composed into the HTTP server in HTTP mode
- [ ] Health endpoint served by standalone server in socket mode
- [ ] Bot connects to Slack and receives events
- [ ] Graceful shutdown on SIGTERM
- [ ] Unit tests for both modes using mock Slack client from Phase 0

### D2: Slack Event Handlers (app_mention + message)

Register `app_mention` and `message` event handlers on the Bolt app.

**Acceptance Criteria:**

- [ ] `app_mention` in enclave-bound channels dispatches to agent runner
- [ ] `message` events in active threads dispatch to existing thread's agent
- [ ] DM messages dispatch to agent runner in DM mode
- [ ] Messages in non-enclave channels are silently ignored
- [ ] Bot/self messages ignored
- [ ] Each event logged with structured attributes
- [ ] Unit tests using Phase 0 event simulator + mock Slack client

### D3: Enclave Binding Engine (Read-Only)

Implement `src/enclave/binding.ts` — lookup `channel_id` to `enclave_name`
from the `enclave_bindings` SQLite table.

**Acceptance Criteria:**

- [ ] `lookupEnclave(channelId): EnclaveBinding | null`
- [ ] Queries enclave_bindings WHERE status = 'active'
- [ ] Returns enclave_name, owner_slack_id, status, created_at
- [ ] Returns null for unbound channels
- [ ] DM channels return null (DM mode determined by channel type)
- [ ] Read-only in Phase 1
- [ ] Unit tests with in-memory SQLite

### D4: Per-Thread Pi Agent Runner

Implement `src/agent/runner.ts` — lifecycle manager for per-thread pi Agent
instances.

**Acceptance Criteria:**

- [ ] `getOrCreateAgent(threadKey)` returns an active pi Agent
- [ ] Thread key format: `{channel_id}:{thread_ts}`
- [ ] Agent configured with: LLM provider/model, MCP connection, system prompt
- [ ] Thread sessions tracked in `thread_sessions` SQLite table
- [ ] Idle threads cleaned up after 7 days
- [ ] Concurrent threads run in parallel
- [ ] Agent responses posted back to originating Slack thread
- [ ] Unit tests with AIMock

### D5: MCP HTTP Wrapper

Implement `src/agent/mcp-connection.ts` — thin custom HTTP layer (~100 LOC)
on `@modelcontextprotocol/sdk` per design Section 14 / followup decision
(no community adapter).

**Acceptance Criteria:**

- [ ] Creates an MCP client connection to TENTACULAR_MCP_URL
- [ ] Per-instance Bearer token injection (service token for Phase 1; per-user
      tokens in Phase 2)
- [ ] Registers all MCP tools from design Section 13.5 in four categories
- [ ] Tool definitions exposed to pi Agent's tool system
- [ ] Tool scoping enforcement is NOT in Phase 1 (Phase 2 adds enforcement)
- [ ] Connection health check
- [ ] Unit tests with MCPMock from Phase 0

### D6: Per-Thread Queue

Implement `src/agent/queue.ts` — per-thread concurrency control.

**Acceptance Criteria:**

- [ ] Messages for the same thread queued and processed serially
- [ ] Different threads process concurrently
- [ ] Queue drains on shutdown (with timeout)
- [ ] Unit tests validate serial-within-thread, parallel-across-threads

### D7: System Prompt + [CONTEXT] Block Injection

Implement `src/agent/system-prompt.ts` and `src/extensions/context-injector.ts`.

**Acceptance Criteria:**

- [ ] System prompt assembled from: global MEMORY.md + enclave MEMORY.md +
      skill references (placeholder content for Phase 1)
- [ ] `[CONTEXT]` block prepended to every user message with: enclave name,
      user_email (placeholder in Phase 1 — real values in Phase 2 after OIDC),
      slack_user_id, mode (enclave or dm)
- [ ] Context injector implemented as a pi extension
- [ ] Format matches design Section 13.4 exactly
- [ ] Unit tests validate block format and content

### D8: SigNoz/OTel Instrumentation (Carryover F2)

Add structured logging and OpenTelemetry tracing to the core loop.

**Acceptance Criteria:**

- [ ] `pino` runtime dependency; all Kraken modules use structured JSON logging
- [ ] `@opentelemetry/api` + `@opentelemetry/sdk-node` + OTLP HTTP exporter
- [ ] Spans for: Slack event handling, agent invocations, MCP tool calls
- [ ] GenAI span attributes: model ID, token counts, thinking level — NO
      prompt/response content
- [ ] `OTEL_EXPORTER_OTLP_ENDPOINT` env var consumed (default: empty = disabled)
- [ ] NetworkPolicy egress rule added for OTel collector (port 4318)
- [ ] Graceful degradation: if collector unreachable, Kraken continues
- [ ] Unit tests validate span creation (in-memory exporter)

### D9: Outbound Message Tracking + Restart Dedup

Implement outbound message tracking using the Phase 0 `outbound_messages`
schema.

**Acceptance Criteria:**

- [ ] Every Slack message Kraken sends recorded with channel_id, thread_ts,
      message_ts, content_hash
- [ ] On startup, `hasOutboundInThread()` checks prevent re-sending
- [ ] Unit tests validate dedup behavior across simulated restarts

### D10: LLM API Key Validation (Followup F3)

Validate the configured LLM provider has its API key set.

**Acceptance Criteria:**

- [ ] If `defaultProvider` is anthropic, fail without ANTHROPIC_API_KEY
- [ ] If allowedProviders includes openai/google, fail without their keys
- [ ] Validation runs at config load time (fail fast)
- [ ] Combined into Phase 0 multi-error throw pattern
- [ ] Unit tests for each provider/key combination

### D11: Helm Required Guards (Followup F14)

Add `required()` or `values.schema.json` guards for Slack, OIDC, MCP, LLM.

**Acceptance Criteria:**

- [ ] `helm install` fails with clear error if SLACK_BOT_TOKEN missing
- [ ] Mode-conditional: SLACK_SIGNING_SECRET required when http,
      SLACK_APP_TOKEN required when socket
- [ ] OIDC_ISSUER, OIDC_CLIENT_ID required
- [ ] TENTACULAR_MCP_URL required
- [ ] At least one LLM API key required
- [ ] `helm lint` still passes with valid values
- [ ] Chart README documents required values per mode

### D12: Main Entry Point (src/index.ts)

Replace Phase 0 stub with full startup sequence.

**Acceptance Criteria:**

- [ ] Loads config (with D10 validation)
- [ ] Initializes SQLite database
- [ ] Initializes pino logger and OTel SDK
- [ ] Creates MCP connection, Slack bot, agent runner
- [ ] Starts health endpoint and connects to Slack
- [ ] Logs startup banner: version, mode, MCP URL, enclave count
- [ ] SIGTERM/SIGINT graceful: drain queues, close connections, flush OTel
- [ ] Integration test: startup with mocks succeeds

---

## What Phase 1 Does NOT Deliver

- **OIDC device flow** — Phase 2 (uses service token in Phase 1)
- **POSIX authorization enforcement** — Phase 2
- **Tool scoping enforcement** — Phase 2 (registered but not blocked)
- **@kraken commands** — Phase 3
- **Channel lifecycle events** — Phase 3
- **Enclave provisioning** — Phase 3 (binding read-only in Phase 1)
- **Persona inference** — Phase 3
- **Drift detection** — Phase 3
- **Block Kit cards** — Phase 4 (plain text in Phase 1)
- **Slack Home Tab** — Phase 4
- **Deploy/rollback flow** — Phase 4 (PM decision; F16)
- **Jargon filter extension** — Phase 3
- **Restart notification to active enclaves** — Phase 5

---

## Followups Addressed

| ID | Action | Phase 1 |
|----|--------|---------|
| F2 | SigNoz/OTel instrumentation | YES — D8 |
| F3 | LLM API key validation | YES — D10 |
| F14 | Helm required() guards | YES — D11 |

## Followups Deferred

| ID | Target | Reason |
|----|--------|--------|
| F1 | Phase 3+ | Archive history — no archive flow in Phase 1 |
| F4 | Future | TNTC_REGISTRY — no runtime change needed |
| F5 | Phase 2 | OIDC client type — cannot resolve without OIDC impl |
| F6 | Phase 2 | Token-at-rest encryption — no token storage wired |
| F7 | Phase 4-5 | tntc checksum — hardening |
| F8 | Phase 4-5 | CiliumNetworkPolicy FQDN — hardening |
| F9 | Phase 5 | Read-only root filesystem — hardening |
| F10 | Phase 4-5 | Conditional SSH egress — hardening |
| F11 | Phase 4-5 | Docker latest tag on RC — before first RC |
| F12 | Phase 1 | Design doc mock path — trivial, fix during impl |
| F13 | Phase 4-5 | Git credential helper scoping — hardening |
| F15 | Future | PR CI Docker build smoke — nice to have |

## New Followup

### F16: Deploy/Rollback Flow Deferred from Phase 1

Tracked in `scratch/kraken-v2-followups.md`.

---

## Dependencies

| Dependency | Source | Status |
|------------|--------|--------|
| Phase 0 complete | thekraken | DONE |
| pi packages v0.66.1 | npm | Available |
| @modelcontextprotocol/sdk | npm | Available |
| pino | npm | Available |
| @opentelemetry/* | npm | Available |
| Tentacular MCP server | In-cluster | Running |
| OTel collector | In-cluster | Running (existing) |

No cross-repo code changes required for Phase 1.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Pi Agent API doesn't support per-instance tool config cleanly | Medium | High | Architect investigates pi-agent-core API in design phase; fallback to wrapper that creates fresh Agent per thread with closure |
| MCP SDK HTTP client doesn't support Bearer injection | Low | Medium | Thin wrapper is ~100 LOC; we control the HTTP layer |
| OTel SDK conflicts with pi's internal instrumentation | Low | Medium | Test early in D8; isolate OTel SDK init |
| Slack Bolt health route differs from Phase 0 assumptions | Low | Low | Phase 0 healthHandler is Express-compatible |
| Service token for MCP (Phase 1 placeholder) lacks permissions | Medium | Medium | Document required MCP permissions; test against live MCP early |
