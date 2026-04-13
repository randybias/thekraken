# Phase 0: Scaffold + Test Harness + Git-State Infra Port

**Change ID:** phase0-scaffold
**Status:** COMPLETE (all reviews passed; ready to archive)
**Created:** 2026-04-13
**Author:** Senior Product Manager

---

## Why Phase 0 Exists

The Kraken v2 is a greenfield rewrite on top of the pi agent toolkit. Before
any feature work can begin (core loop, auth, commands, UX), the project needs
a working skeleton: a compilable TypeScript project, test infrastructure that
does not require a live cluster, and the git-backed state infrastructure that
every subsequent phase depends on.

Without Phase 0, developers have no repo to commit to, no test harness to
validate against, and no CI to catch regressions. Every subsequent phase
(1 through 5) depends on this foundation being solid.

Git-backed state is a hard requirement for v2 (design Section 14). The Kraken
refuses to start if git config is missing. Porting the git-state
infrastructure (entrypoint, Helm gitState section, Dockerfile git
installation, pre-commit hook) in Phase 0 ensures this contract is
established from day one, not bolted on later.

---

## What Phase 0 Delivers

### D1: Compilable TypeScript Project Skeleton

A `thekraken/` repo with:

- `package.json` with pi dependencies (`@mariozechner/pi-agent-core`,
  `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent` -- all pinned at
  v0.66.1), plus `@slack/bolt`, `better-sqlite3`, `vitest`, `typescript`,
  `eslint`, `prettier`
- `tsconfig.json` configured for Node.js 22 + ESM
- ESLint + Prettier configs matching pi-coding-agent conventions
- Directory structure under `src/` per design Section 11 (empty stub files
  with exported type placeholders for each module)
- `npm run build`, `npm test`, `npx tsc --noEmit`, `npm run lint`,
  `npm run format:check` all pass on the skeleton

**Acceptance Criteria:**

- [ ] `npm ci` installs without errors
- [ ] `npx tsc --noEmit` exits 0
- [ ] `npm run build` produces `dist/` output
- [ ] `npm run lint` exits 0
- [ ] `npm run format:check` exits 0
- [ ] `npm test` exits 0 (runs vitest, at least one placeholder test passes)
- [ ] pi packages resolve: `@mariozechner/pi-agent-core@0.66.1`,
      `@mariozechner/pi-ai@0.66.1`, `@mariozechner/pi-coding-agent@0.66.1`

### D2: AIMock Test Infrastructure

AIMock (LLMock + MCPMock) installed and configured with vitest integration.
A single smoke test demonstrates LLMock intercepting an Anthropic API call
and MCPMock intercepting an MCP tool call.

**Acceptance Criteria:**

- [ ] AIMock is a devDependency in `package.json`
- [ ] A test file `test/unit/aimock-smoke.test.ts` exists
- [ ] The smoke test creates an LLMock instance, sends a mock Claude request,
      and asserts a deterministic response
- [ ] The smoke test creates an MCPMock instance and asserts a mocked MCP
      tool call returns the configured response
- [ ] Both smoke tests pass in `npm test`

### D3: Mock Slack WebClient + Event Simulator

A hand-built mock Slack WebClient (`test/mocks/slack-client.ts`) and event
simulator (`test/mocks/event-simulator.ts`) that allow testing Slack
interactions without a real Slack workspace.

**Acceptance Criteria:**

- [ ] `MockSlackWebClient` records all API method calls with arguments
- [ ] `MockSlackWebClient` supports `addResponse(method, response)` for
      scripted API returns
- [ ] `MockSlackWebClient.calls[method]` returns an array of call arguments
- [ ] `SlackEventSimulator` can generate valid `app_mention`, `message`,
      `channel_archive`, `channel_rename`, and `member_left_channel` event
      payloads
- [ ] A test file `test/unit/slack-mock-smoke.test.ts` validates both mocks
- [ ] All mock smoke tests pass in `npm test`

### D4: SQLite Schema

Fresh v2 schema in `src/db/schema.ts` with five tables: `user_tokens`,
`enclave_bindings`, `outbound_messages`, `deployments`, `thread_sessions`.
Schema applied by `src/db/migrations.ts` (single initial migration for v2 --
no evolution needed yet).

**Acceptance Criteria:**

- [ ] `src/db/schema.ts` exports the SQL DDL as a string constant
- [ ] Tables match the schemas from the design doc:
  - `user_tokens`: slack_user_id (PK), access_token, refresh_token,
    expires_at, keycloak_sub, email (no FK)
  - `enclave_bindings`: channel_id (PK), enclave_name (UNIQUE — FK
    target), owner_slack_id, status, created_at
  - `outbound_messages`: id (PK), channel_id, thread_ts, message_ts,
    content_hash, created_at (NO FK — DMs may not have enclave bindings)
  - `deployments`: id (PK auto), enclave, tentacle, version, git_sha,
    git_tag, deploy_type, summary, details, deployed_by_email,
    triggered_by_channel, triggered_by_ts, created_at, status,
    status_detail; UNIQUE(enclave, tentacle, version);
    **FK: enclave -> enclave_bindings(enclave_name) ON DELETE CASCADE**
  - `thread_sessions`: channel_id + thread_ts (composite PK), session_id,
    user_slack_id, enclave_name, created_at, last_active_at;
    **FK: enclave_name -> enclave_bindings(enclave_name) ON DELETE CASCADE**
- [ ] `src/db/migrations.ts` sets `PRAGMA foreign_keys = ON` AND
      `PRAGMA journal_mode = WAL` before applying schema
- [ ] `src/db/migrations.ts` applies the schema to an in-memory SQLite
      database without errors
- [ ] A unit test creates the schema, inserts a row into each table, and
      reads it back
- [ ] A unit test validates FK enforcement:
  - Inserting `deployments` with unknown enclave fails
  - Inserting `thread_sessions` with unknown enclave fails
  - Deleting `enclave_bindings` row CASCADEs into both
    `deployments` and `thread_sessions`
  - `outbound_messages` inserts succeed regardless of
    `enclave_bindings` state (proves no FK)

### D5: Health Endpoint Stub

`src/health.ts` exports a minimal `/healthz` HTTP handler that returns
`200 OK` with `{"status":"ok"}`.

**Acceptance Criteria:**

- [ ] `src/health.ts` exports a function that creates an HTTP server
      (or handler) on a configurable port
- [ ] GET `/healthz` returns HTTP 200 with JSON body `{"status":"ok"}`
- [ ] A unit test validates the response status and body

### D6: Config Module

`src/config.ts` loads all configuration from environment variables with
sensible defaults. Covers: Slack credentials, OIDC settings, MCP URL,
LLM provider/model allowlists (design Section 15), git-state settings,
server port.

**Acceptance Criteria:**

- [ ] All config fields are typed and documented with JSDoc
- [ ] Missing required env vars (SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET or
      SLACK_APP_TOKEN depending on mode) throw a clear error at startup
- [ ] LLM allowlist/denylist config fields exist per design Section 15
      (defaultProvider, defaultModel, allowedProviders, allowedModels,
      disallowedModels)
- [ ] Git-state config fields: GIT_STATE_REPO_URL, GIT_STATE_BRANCH,
      GIT_STATE_DIR -- all required (no opt-in toggle; Kraken refuses to
      start if unset)
- [ ] A unit test validates that missing required vars throw, and that
      defaults are applied for optional vars

### D7: Git-State Infrastructure Port

Port from `thekraken-reference/` with one critical change: git-state is
mandatory, not opt-in.

**Acceptance Criteria:**

- [ ] `scripts/entrypoint.sh` exists, is executable, and:
  - Sets git identity (`user.name`, `user.email`)
  - Configures credential helper from mounted secret
  - Clones or pulls the git-state repo
  - Sets `core.hooksPath` to `/app/kraken-hooks`
  - **Hard-fails** (exits non-zero) if GIT_STATE_REPO_URL is unset or empty
  - **Hard-fails** if the clone/pull fails (no "continue with stale copy"
    fallback -- v2 treats this as fatal)
  - Writes tntc config with `git_state` section
- [ ] `kraken-hooks/pre-commit` exists, is executable, and:
  - Reads staged files under `enclaves/`
  - For each affected tentacle directory, bumps `version:` in
    `workflow.yaml` by 1
  - Re-stages the bumped file
  - Passes `shellcheck`
- [ ] A test (shell or vitest) validates the pre-commit hook bumps a
      version correctly given a mock git staging area

### D8: Dockerfile (Multi-Arch)

Port from `thekraken-reference/Dockerfile` adapted for v2.

**Acceptance Criteria:**

- [ ] Dockerfile builds successfully for both `linux/amd64` and
      `linux/arm64` targets
- [ ] Installs `git` package
- [ ] Downloads and bundles `tntc` CLI binary (arch-aware)
- [ ] Copies `scripts/entrypoint.sh` and `kraken-hooks/`
- [ ] Runs as non-root user
- [ ] HEALTHCHECK probes `/healthz`
- [ ] `docker buildx build --platform linux/amd64,linux/arm64` succeeds
      (does not need to push)

### D9: Helm Chart Skeleton

Port `charts/thekraken/` from `thekraken-reference/` with updated gitState
section (required, not optional).

**Acceptance Criteria:**

- [ ] `charts/thekraken/Chart.yaml` exists with name `thekraken`, version
      `0.1.0`, appVersion `2.0.0`
- [ ] `charts/thekraken/values.yaml` includes:
  - `gitState.repoUrl` (required, no default)
  - `gitState.branch` (default: `main`)
  - `gitState.credentialsSecret` (required, no default)
  - No `gitState.enabled` toggle (it is always on)
- [ ] `charts/thekraken/values-mirantis.yaml` overlay exists with
      `gitState.repoUrl` set to the mirantis-tentacle-workflows repo
- [ ] `helm lint charts/thekraken --set gitState.repoUrl=https://github.com/test/repo.git --set gitState.credentialsSecret=test-secret` passes (the `--set` flags satisfy the `required()` template guards)
- [ ] Deployment template mounts git credentials Secret, sets gitState
      env vars, mounts PVC for `/app/data`

### D10: CI Workflows

GitHub Actions workflows for CI and Docker image builds.

**Acceptance Criteria:**

- [ ] `.github/workflows/ci.yml` runs on push and PR to `main`:
  - `npm ci`, `npx tsc --noEmit`, `npm run lint`, `npm run format:check`,
    `npm test`
- [ ] `.github/workflows/docker-build.yml` triggers on `v*` tags:
  - Builds multi-arch (`linux/amd64`, `linux/arm64`) Docker image
  - Pushes to `ghcr.io/randybias/thekraken:<tag>`
- [ ] Both workflows use Node.js 22

### D11: OpenSpec project.md

Bootstrap `openspec/project.md` with conventions for v2 change management.

**Acceptance Criteria:**

- [ ] `openspec/project.md` documents:
  - Change naming convention (phase-based slugs)
  - Required artifacts per change (proposal.md, design.md, tasks.md)
  - Review gates (Code Review, Security, QA, Tech Writer, Codex)
  - Branch naming (`feature/<change-slug>`)
  - Commit convention (Conventional Commits)

---

## What Phase 0 Does NOT Deliver

- **No Slack bot functionality.** No @mention handling, no commands, no
  thread dispatch. That is Phase 1.
- **No pi Agent integration.** No agent runner, no system prompt, no tool
  execution. That is Phase 1.
- **No OIDC authentication.** No device flow, no token refresh, no
  per-user auth. That is Phase 2.
- **No authorization logic.** No POSIX mode bits, no tool scoping. That
  is Phase 2.
- **No enclave binding.** No channel-to-enclave state machine. That is
  Phase 1.
- **No Block Kit formatting.** No cards, no Home Tab. That is Phase 4.
- **No pi extensions.** No jargon filter, no context injector. That is
  Phase 3+.
- **No skills content.** The `skills/` directory is created but empty.
  Content is authored in Phase 3+.
- **No deploy flow.** `git-state/deploy.ts` and `rollback.ts` are Phase 1+
  deliverables. Phase 0 only delivers the infrastructure (entrypoint,
  hooks, Helm, Dockerfile).
- **No LLM API calls.** Config module defines allowlists; actual model
  instantiation is Phase 1.
- **No task scheduling.** Dropped from v2 entirely.
- **No main/admin channel.** Dropped from v2 entirely.

---

## Dependencies

Phase 0 has no dependencies on other repos or phases. It is the root of
the dependency chain. All subsequent phases (1-5) depend on Phase 0.

---

## Carryover to Phase 1: SigNoz Observability Integration

**Not delivered in Phase 0. Must not be lost.**

The Tentacular platform has a production observability pipeline: tentacles
auto-enrich with OTel spans that flow through a two-collector topology
(tentacular collector -> SigNoz collector -> ClickHouse). GenAI spans
include model, tokens, system prompt hash (no content). SigNoz serves
as the operator/admin plane. This was delivered via Plan A in the
observability project (see memory `project_observability_design.md`;
status COMPLETE as of 2026-04-10; `scratch/plan-a-observability-plumbing.md`).

**The v2 Kraken must participate in this pipeline.** Phase 1 picks this up:

### Phase 1 Requirements (for this carryover)

- **Structured logger.** Add `pino` as a runtime dependency. All Kraken
  code uses structured JSON logging (request ID, user ID where present,
  thread context, enclave name where present).
- **OTel instrumentation.** Install `@opentelemetry/api` +
  `@opentelemetry/sdk-node` + appropriate exporters. Emit spans for:
  - Slack event handling (attrs: `slack.event.type`, `slack.channel`,
    `slack.thread_ts`, `slack.user`)
  - Agent invocations (attrs: `enclave.name`, `user.email`, `llm.provider`,
    `llm.model`, `agent.thread_id`)
  - MCP tool calls (attrs: `mcp.tool.name`, `mcp.tool.args_hash`,
    `mcp.tool.status`, `mcp.tool.duration_ms`)
  - Git operations (attrs: `git.operation`, `git.repo`, `git.sha`,
    `git.duration_ms`)
  - Deploy flow (attrs: `deploy.tentacle`, `deploy.version`,
    `deploy.status`)
- **GenAI span conventions** — match tentacular engine conventions so
  SigNoz dashboards work uniformly. No prompt/response content in spans
  (privacy). Token counts, model ID, thinking level OK.
- **Collector endpoint** — `OTEL_EXPORTER_OTLP_ENDPOINT` env var pointing
  to the in-cluster tentacular collector
  (`http://otel-collector.tentacular-observability.svc.cluster.local:4318`
  per existing NetworkPolicy convention).
- **NetworkPolicy** — add egress rule to `charts/thekraken/templates/networkpolicy.yaml`
  for the tentacular collector (port 4318). Phase 0 port already preserves
  a NetworkPolicy template; Phase 1 extends egress rules.
- **Graceful degradation** — if the collector is down, Kraken continues
  to run. Logged warnings, no crash. Matches tentacle engine behavior.

### Reference Materials

- Memory: `project_observability_design.md` (meta-plan pointer)
- Design doc: `scratch/plan-a-observability-plumbing.md` (COMPLETE — describes
  what's already in production)
- Skill reference: `tentacular-skill/references/observability.md`
- Existing NetworkPolicy pattern: `thekraken-reference/charts/thekraken/templates/networkpolicy.yaml`

### Why Deferred to Phase 1

Phase 0 has no runtime behavior — there are no Slack events to trace, no
agent invocations to instrument. Adding OTel plumbing to a skeleton
project produces no signal and adds complexity without benefit. Phase 1
introduces the core loop; that's the natural point to instrument.

**Task for Phase 1 PM:** add a dedicated deliverable
"D-obs: SigNoz/OTel instrumentation" to the Phase 1 proposal.

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Pi packages v0.66.1 unavailable on npm | Low | Pin exact version in package.json; fail fast if resolution fails |
| AIMock API instability (young project) | Medium | Pin version; if breaking, write thin adapter layer |
| Helm chart port misses v2 schema changes | Low | Architect reviews chart against design doc before merge |
| Pre-commit hook fragile across git versions | Low | Test with git 2.43+ (Docker image version); shellcheck enforced |
