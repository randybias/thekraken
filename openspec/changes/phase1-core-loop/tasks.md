# Phase 1: Core Loop — Tasks

**Change ID:** phase1-core-loop
**Status:** DRAFT
**Created:** 2026-04-13
**Author:** Senior Product Manager

---

## Execution Order

Tasks numbered in execution order. **[PARALLEL]** marks concurrent tasks.
Each task group commits + passes pre-push gates before the next begins.

---

### T01: Add Runtime Dependencies

**Owner:** Developer

Add pino, `@opentelemetry/api`, `@opentelemetry/sdk-node`,
`@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/semantic-conventions`,
`@opentelemetry/instrumentation-http`, `@modelcontextprotocol/sdk`.

**DoD:**
- [ ] All packages added with appropriate versions
- [ ] `npm ci` succeeds, `npx tsc --noEmit` clean, `npm test` passes (Phase 0
      tests unbroken)

---

### T02: Implement Pino Structured Logger

**Owner:** Developer

Create `src/logger.ts` exporting a configured pino logger.

**DoD:**
- [ ] JSON output with timestamp, level, module fields
- [ ] Child logger factory: `logger.child({ module, threadKey?, enclave? })`
- [ ] `LOG_LEVEL` env var (default: 'info')
- [ ] Unit test validates JSON structure

---

### T03: Implement OTel SDK Initialization

**Owner:** Developer **[PARALLEL with T02]**

Create `src/telemetry.ts` initializing OTel NodeSDK with OTLP HTTP exporter.

**DoD:**
- [ ] `initTelemetry()` and `shutdownTelemetry()` exported
- [ ] `OTEL_EXPORTER_OTLP_ENDPOINT` env var (empty = disabled)
- [ ] Service name: `thekraken`
- [ ] Exporter failure logged as warning, no crash
- [ ] Unit test with in-memory exporter validates span creation
- [ ] `LOG_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT` added to config.ts

---

### T04: Implement LLM API Key Validation (F3)

**Owner:** Developer **[PARALLEL with T03]**

Add LLM API key validation to `src/config.ts`.

**DoD:**
- [ ] `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` added to
      config type as optional
- [ ] Validation: `defaultProvider` key required; each `allowedProvider` key
      required
- [ ] Combined into Phase 0 multi-error throw pattern
- [ ] Unit tests for each provider/key combination
- [ ] Phase 0 config tests still pass

---

### T05: Implement Enclave Binding Engine (Read-Only)

**Owner:** Developer **[PARALLEL with T03, T04]**

Implement `src/enclave/binding.ts`.

**DoD:**
- [ ] `lookupEnclave(db, channelId): EnclaveBinding | null`
- [ ] Queries `enclave_bindings WHERE channel_id = ? AND status = 'active'`
- [ ] `EnclaveBinding` type exported from `src/types.ts`
- [ ] Unit tests with in-memory SQLite

---

### T06: Implement Per-Thread Queue

**Owner:** Developer **[PARALLEL with T03, T04, T05]**

Implement `src/agent/queue.ts`.

**DoD:**
- [ ] `ThreadQueue` class: `enqueue(threadKey, fn): Promise`
- [ ] Same threadKey: serial FIFO; different threadKeys: concurrent
- [ ] `drain(timeoutMs)` waits for in-flight, rejects new
- [ ] Unit tests validate serial + concurrent + drain behaviors

---

### T07: Implement MCP HTTP Wrapper

**Owner:** Developer

Implement `src/agent/mcp-connection.ts` — ~100 LOC thin wrapper on
`@modelcontextprotocol/sdk`.

**DoD:**
- [ ] `createMcpConnection(url, bearerToken)` returns MCP client
- [ ] Bearer token in Authorization header
- [ ] Tool category constants exported: `ENCLAVE_SCOPED`,
      `BLOCKED_IN_ENCLAVE`, `DM_ALLOWED`, `ALWAYS_ALLOWED` per design §13.5
- [ ] Tool definitions exposed in pi-Agent-consumable format
- [ ] Health check method
- [ ] Reconnection on transient failure (1 retry with backoff)
- [ ] OTel span per tool call (attrs: tool.name, tool.status,
      tool.duration_ms)
- [ ] Unit tests with MCPMock from Phase 0
- [ ] Implementation ~100 LOC (thin, not a framework)

---

### T08: Implement System Prompt Builder

**Owner:** Developer **[PARALLEL with T07]**

Implement `src/agent/system-prompt.ts`.

**DoD:**
- [ ] `buildSystemPrompt(globalMemory, enclaveMemory?, skills?)` returns
      string
- [ ] Concatenates layers with clear delimiters
- [ ] Placeholder content for Phase 1
- [ ] Unit tests validate structure and ordering

---

### T09: Implement [CONTEXT] Block Injector

**Owner:** Developer **[PARALLEL with T07, T08]**

Implement `src/extensions/context-injector.ts` as a pi extension.

**DoD:**
- [ ] Pi extension hooks `input` or `before_agent_start` event (architect
      determines exact hook in design)
- [ ] Block format matches design §13.4 exactly:
      `[CONTEXT]\nenclave: ...\nuser_email: ...\nslack_user_id: ...\nmode: ...\n[/CONTEXT]`
- [ ] Enclave mode: enclave name from binding lookup
- [ ] DM mode: `mode=dm`, `enclave=none`
- [ ] `user_email` placeholder "unknown" in Phase 1
- [ ] Unit tests for both modes

---

### T10: Implement Per-Thread Pi Agent Runner

**Owner:** Developer

Depends on T06, T07, T08, T09. Implement `src/agent/runner.ts`.

**DoD:**
- [ ] `AgentRunner` manages Map of `threadKey -> Agent`
- [ ] `handleMessage(threadKey, message, context)` queues via ThreadQueue,
      creates agent if needed, invokes pi Agent
- [ ] Agent configured: LLM provider/model, MCP tools, system prompt,
      context injector
- [ ] Response text returned (caller posts to Slack)
- [ ] Thread session recorded in `thread_sessions` table
- [ ] OTel span per agent invocation (attrs: enclave.name, llm.provider,
      llm.model, agent.thread_id)
- [ ] GenAI span attrs: model ID, token counts (no content)
- [ ] Idle thread cleanup: prune `last_active_at > 7 days`
- [ ] Unit tests with AIMock + MCPMock

---

### T11: Implement Outbound Message Tracking

**Owner:** Developer **[PARALLEL with T10]**

Implement outbound message tracking using `outbound_messages` schema.

**DoD:**
- [ ] `storeOutboundMessage(db, channelId, threadTs, messageTs,
      contentHash)` inserts row
- [ ] `hasOutboundInThread(db, channelId, threadTs)` returns boolean
- [ ] Content hash via SHA-256
- [ ] Unit tests validate store + dedup-after-restart

---

### T12: Implement Slack Bot (Dual-Mode)

**Owner:** Developer

Depends on T10, T05, T11. Implement `src/slack/bot.ts`.

**DoD:**
- [ ] `createSlackBot(config, deps)` returns Bolt App
- [ ] HTTP mode: ExpressReceiver, `/slack/events`, `/healthz` composed via
      Phase 0 `healthHandler`
- [ ] Socket mode: SocketModeReceiver, standalone health server via Phase 0
      `createHealthServer`
- [ ] `app_mention` handler: lookup enclave -> if bound, dispatch to runner
      -> post in thread
- [ ] `message` handler: in active threads dispatch; in DMs dispatch in DM
      mode; in non-enclave channels ignore
- [ ] Bot/self messages ignored
- [ ] All outbound messages tracked via T11
- [ ] OTel span per Slack event (attrs: event.type, channel, thread_ts, user)
- [ ] Structured pino logging per event
- [ ] Graceful shutdown: stop + queue drain
- [ ] Unit tests with mock Slack client + event simulator

---

### T13: Implement Main Entry Point

**Owner:** Developer

Depends on T12, T03, T02. Replace Phase 0 stub `src/index.ts`.

**DoD:**
- [x] Loads config with LLM key validation
- [x] Initializes pino, OTel, SQLite (with migrations)
- [x] Creates MCP connection, Slack bot, agent runner
- [x] Starts health endpoint (mode-aware), connects to Slack
- [x] Logs startup banner: version, mode, MCP URL, enclave count
- [x] SIGTERM/SIGINT: drain queues, close MCP, stop Slack, flush OTel,
      exit 0
- [x] Integration test: startup + shutdown with mocks

---

### T14: Add Helm Required Guards (F14)

**Owner:** Developer **[PARALLEL with T13]**

Values validation in Helm chart.

**DoD:**
- [x] `values.schema.json` + `required()` guards: SLACK_BOT_TOKEN (always),
      SLACK_SIGNING_SECRET (http mode), SLACK_APP_TOKEN (socket mode),
      OIDC_ISSUER, OIDC_CLIENT_ID, TENTACULAR_MCP_URL
- [ ] At least one LLM API key required (Phase 2 — runtime validated by loadConfig)
- [x] `OTEL_EXPORTER_OTLP_ENDPOINT` added as optional Helm value
- [x] NetworkPolicy egress: port 4318, tentacular-observability namespace
- [x] `helm lint` passes with valid values; fails with missing required
- [ ] Chart README updated with required values table (T20 owner)

---

### T15: OTel Helm Chart Updates

**Owner:** Developer **[PARALLEL with T14]**

Add OTel env vars and NetworkPolicy to Helm.

**DoD:**
- [x] `OTEL_EXPORTER_OTLP_ENDPOINT` added to ConfigMap (optional)
- [x] `LOG_LEVEL` added to ConfigMap (default: info)
- [x] NetworkPolicy egress to tentacular-observability:4318
- [x] `helm template` renders correctly with/without OTel endpoint

---

### T16: Validate Full Build Pipeline

**Owner:** Developer

Run complete pipeline end-to-end.

**DoD:**
- [x] `npm ci`, `npx tsc --noEmit`, `npm run build`, `npm test`,
      `npm run lint`, `npm run format:check` all clean
- [x] `helm lint charts/thekraken` passes
- [x] `shellcheck scripts/entrypoint.sh` passes

---

### T17: Code Review

**Owner:** Code Reviewer

**DoD:**
- [ ] Slack bot dual-mode reviewed
- [ ] Agent runner lifecycle reviewed (memory leaks, thread cleanup)
- [ ] MCP wrapper reviewed (security: Bearer token handling, no logging)
- [ ] OTel reviewed (no PII in spans, graceful degradation)
- [ ] Context injector format matches design §13.4
- [ ] Outbound dedup logic reviewed
- [ ] Conventional Commits used; no stale TODOs
- [ ] Sign-off recorded

---

### T18: Security Review

**Owner:** Senior Security Architect

**DoD:**
- [ ] MCP Bearer token never logged/stored in SQLite/exposed in errors
- [ ] OTel spans contain no prompt/response content, no PII
- [ ] Service token from env (no hardcoding); document Phase 2 migration
- [ ] No new secrets in ConfigMap
- [ ] NetworkPolicy changes scoped correctly (OTel egress)
- [ ] Helm required guards reviewed for completeness
- [ ] No authz bypass paths Phase 2 cannot close
- [ ] Sign-off recorded

---

### T19: QA Review

**Owner:** Senior QA Engineer

**DoD:**
- [ ] All unit tests pass (Phase 0 + Phase 1)
- [ ] Agent runner tests cover create/reuse/idle cleanup
- [ ] MCP wrapper tests cover connect/call/reconnect/auth
- [ ] Slack bot tests cover both modes/mention/thread/DM/ignore
- [ ] Context injector tests cover enclave + DM modes
- [ ] Outbound dedup tests cover restart simulation
- [ ] OTel tests cover span creation + graceful degradation
- [ ] No flaky tests
- [ ] Sign-off recorded

---

### T20: Tech Writer Review

**Owner:** Senior Technical Writer

**DoD:**
- [ ] README updated: deps, env vars (LOG_LEVEL,
      OTEL_EXPORTER_OTLP_ENDPOINT, LLM keys), startup behavior
- [ ] Project CLAUDE.md created (Phase 1 architecture)
- [ ] Chart README updated with required values per mode
- [ ] JSDoc on all public functions in new modules
- [ ] No stale `TODO(phase1)` comments in implemented modules
- [ ] Sign-off recorded

---

### T21: Codex Review

**Owner:** Codex (automated)

**Skippable:** Yes, if Codex MCP unreachable (log reason + timestamp).

**DoD:**
- [ ] Codex reviewed full Phase 1 diff
- [ ] Findings addressed or documented as followups
- [ ] Review logged (verdict + timestamp)
