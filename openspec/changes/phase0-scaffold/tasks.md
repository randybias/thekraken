# Phase 0: Scaffold + Test Harness + Git-State Infra Port — Tasks

**Change ID:** phase0-scaffold
**Status:** Implementation Complete (T01-T17 done; T18-T22 reviews pending)
**Created:** 2026-04-13
**Author:** Senior Product Manager

---

## Execution Order

Tasks are numbered in execution order. Tasks marked **[PARALLEL]** can run
concurrently with the preceding task(s) as indicated. All other tasks are
sequential.

---

### T01: Initialize Project and Package Configuration

**Owner:** Developer

**Description:** Create `package.json`, `tsconfig.json`, ESLint + Prettier
configs, `.gitignore`, and `README.md` stub. Install pi dependencies at
v0.66.1, Slack Bolt, better-sqlite3, vitest, TypeScript 5.x, ESLint,
Prettier.

**Definition of Done:**

- [x] `package.json` exists with `name: "thekraken"`, `version: "2.0.0"`,
      `type: "module"`
- [x] Scripts defined: `build`, `dev`, `test`, `lint`, `format`,
      `format:check`
- [x] `@mariozechner/pi-agent-core@0.66.1`, `@mariozechner/pi-ai@0.66.1`,
      `@mariozechner/pi-coding-agent@0.66.1` listed as dependencies
- [x] `@slack/bolt`, `better-sqlite3` listed as dependencies
- [x] `vitest`, `typescript`, `eslint`, `prettier`,
      `@types/better-sqlite3` listed as devDependencies
- [x] `tsconfig.json` targets Node.js 22, ESM output, strict mode
- [x] `npm ci` succeeds
- [x] `npx tsc --noEmit` exits 0 (on empty project)
- [x] `npm run lint` exits 0
- [x] `npm run format:check` exits 0

---

### T02: Create Source Directory Structure

**Owner:** Developer

**Description:** Create the `src/` directory tree per design Section 11.
Each directory gets an `index.ts` barrel export. Leaf modules get a stub
file with a placeholder type export and/or a TODO comment.

**Definition of Done:**

- [x] Directories exist: `src/slack/`, `src/enclave/`, `src/auth/`,
      `src/agent/`, `src/db/`, `src/extensions/`, `src/git-state/`
- [x] Stub files for every module listed in design Section 11
- [x] `npx tsc --noEmit` exits 0

---

### T03: Create Test Directory Structure

**Owner:** Developer **[PARALLEL with T02]**

**Description:** Create `test/` tree: `test/unit/`, `test/integration/`,
`test/scenarios/`, `test/fixtures/`, `test/mocks/`. Add a passing
placeholder test.

**Definition of Done:**

- [x] All five test directories exist
- [x] `test/unit/placeholder.test.ts` passes under vitest
- [x] `vitest.config.ts` exists at the project root
- [x] `npm test` exits 0

---

### T04: Implement Config Module

**Owner:** Developer

**Description:** Implement `src/config.ts` to load configuration from
environment variables. Slack, OIDC, MCP, LLM allowlists (design §15),
git-state (mandatory), server port. Refuses to start without
`GIT_STATE_REPO_URL`.

**Definition of Done:**

- [x] `loadConfig()` returns a typed config object
- [x] Missing required vars throw descriptive errors
- [x] LLM config: `defaultProvider`, `defaultModel`, `allowedProviders`,
      `allowedModels`, `disallowedModels`
- [x] Git-state config mandatory (no opt-in toggle)
- [x] Unit test validates required/optional behavior
- [x] `npx tsc --noEmit` and `npm test` pass

---

### T05: Implement SQLite Schema

**Owner:** Developer **[PARALLEL with T04]**

**Description:** Implement `src/db/schema.ts` (DDL) and
`src/db/migrations.ts` (applies DDL to SQLite). Five tables:
`user_tokens`, `enclave_bindings`, `outbound_messages`, `deployments`,
`thread_sessions`. FKs on `deployments.enclave` and
`thread_sessions.enclave_name` targeting `enclave_bindings.enclave_name`
(UNIQUE), both with `ON DELETE CASCADE ON UPDATE CASCADE`. Enforce via
`PRAGMA foreign_keys = ON`.

**Definition of Done:**

- [x] DDL matches design doc §5 exactly (FK + UNIQUE included)
- [x] `deployments` has `UNIQUE(enclave, tentacle, version)` and indexes
      on `(enclave, tentacle)` and `(created_at DESC)`
- [x] `enclave_bindings.enclave_name` has UNIQUE constraint (FK target)
- [x] `applyMigrations()` sets `PRAGMA foreign_keys = ON` AND
      `PRAGMA journal_mode = WAL` before executing schema
- [x] Migration applies cleanly to in-memory DB
- [x] Unit test inserts + reads every table
- [x] Unit test validates FK enforcement:
  - Insert into `deployments` with unknown `enclave` -> SQLite throws
  - Insert into `thread_sessions` with unknown `enclave_name` -> throws
  - Delete `enclave_bindings` row -> `deployments` + `thread_sessions`
    rows for that enclave disappear (CASCADE)
  - Insert into `outbound_messages` for channel not in
    `enclave_bindings` -> succeeds (no FK)
- [x] `npm test` passes

---

### T06: Implement Health Endpoint Stub

**Owner:** Developer **[PARALLEL with T04, T05]**

**Description:** Minimal HTTP handler responding `200 OK` with
`{"status":"ok"}` on `/healthz`.

**Definition of Done:**

- [x] Function to start/create the health handler exported from
      `src/health.ts`
- [x] GET `/healthz` returns 200 with correct JSON body
- [x] Unit test validates

---

### T07: Set Up AIMock Test Infrastructure

**Owner:** Developer

**Description:** Install AIMock. Create `test/unit/aimock-smoke.test.ts`
demonstrating LLMock (mock Anthropic) and MCPMock (mock MCP tool call).

**Definition of Done:**

- [x] AIMock is a devDependency (verify exact npm package name at this
      step; document any deviations in a test-file comment)
- [x] Both smoke tests pass under `npm test`

---

### T08: Build Mock Slack WebClient

**Owner:** Developer **[PARALLEL with T07]**

**Description:** `test/mocks/slack-client.ts` — records API calls,
supports scripted responses.

**Definition of Done:**

- [x] `MockSlackWebClient` with `calls`, `addResponse()`, `lastCall()`
- [x] Unit test validates recording + scripting

---

### T09: Build Slack Event Simulator

**Owner:** Developer **[PARALLEL with T07, T08]**

**Description:** `test/mocks/event-simulator.ts` — generates valid
payloads for `app_mention`, `message`, `channel_archive`,
`channel_rename`, `member_left_channel`.

**Definition of Done:**

- [x] Factory functions for each event type
- [x] Unit test validates structure of each payload
- [x] `npm test` passes

---

### T10: Port entrypoint.sh (Git-State Hard Requirement)

**Owner:** Developer

**Description:** Port `scripts/entrypoint.sh` from `thekraken-reference/`
with v2 changes: git-state is mandatory, remove `GIT_STATE_ENABLED`
conditional, remove NanoClaw artifacts (Claude session symlink, sender
allowlist migration).

**Definition of Done:**

- [x] Hard-fails on missing `GIT_STATE_REPO_URL`
- [x] Hard-fails on clone/pull failure (no stale-copy fallback)
- [x] Sets git identity "The Kraken" / `kraken@tentacular.dev`
- [x] Configures credential helper from `/app/.git-credentials/token`
- [x] Sets `core.hooksPath` to `/app/kraken-hooks`
- [x] Writes tntc `git_state` config
- [x] `shellcheck` clean
- [x] No references to dropped NanoClaw artifacts

---

### T11: Port Pre-Commit Hook

**Owner:** Developer **[PARALLEL with T10]**

**Description:** Create `kraken-hooks/pre-commit` per design §14.4.
Monotonic version bump for any tentacle with staged changes.

**Definition of Done:**

- [x] Reads staged paths, groups by tentacle dir, bumps `version:` in
      `workflow.yaml`, re-stages
- [x] Ignores changes to `CONTEXT.md` (doc-only commits don't bump)
- [x] `shellcheck` clean
- [x] Test validates bump behavior (temp repo fixture)

---

### T12: Port Dockerfile

**Owner:** Developer

**Description:** Port multi-arch Dockerfile. Remove NanoClaw artifacts
(`groups/`, Claude session dirs, sender allowlist).

**Definition of Done:**

- [x] Base `node:22`, installs `git`, downloads `tntc` arch-aware
- [x] Copies `scripts/entrypoint.sh`, `kraken-hooks/`, `skills/`
- [x] Non-root `node` user, HEALTHCHECK on `/healthz`
- [x] `docker buildx build --platform linux/amd64,linux/arm64 .` succeeds

---

### T13: Port Helm Chart Skeleton

**Owner:** Developer **[PARALLEL with T12]**

**Description:** Port `charts/thekraken/` with v2 change: gitState
mandatory (no `enabled` toggle). Add `values-mirantis.yaml` overlay.

**Definition of Done:**

- [x] Chart metadata: name `thekraken`, version `0.1.0`, appVersion
      `2.0.0`
- [x] `values.yaml`: gitState mandatory; Slack/OIDC/MCP/LLM sections
- [x] `values-mirantis.yaml`: gitState points to
      `mirantis-tentacle-workflows`
- [x] `helm lint` passes
- [x] `helm template` renders with Mirantis overlay

---

### T14: Create CI Workflows

**Owner:** Developer **[PARALLEL with T12, T13]**

**Description:** GitHub Actions for CI and multi-arch Docker builds.

**Definition of Done:**

- [x] `.github/workflows/ci.yml`: npm ci / tsc / lint / format:check /
      test on PR + push to `main`, Node 22
- [x] `.github/workflows/docker-build.yml`: multi-arch build + push to
      `ghcr.io/randybias/thekraken:<tag>` on `v*` tags
- [x] Both workflows valid YAML

---

### T15: Create Skills Directory Structure

**Owner:** Developer **[PARALLEL with T14]**

**Description:** Placeholder structure under `skills/`. No content.

**Definition of Done:**

- [x] `skills/tentacular/` (empty, reserved)
- [x] `skills/kraken/SKILL.md` (placeholder header + TODO)
- [x] `skills/kraken/references/` with placeholder `slack-ux.md`,
      `enclave-personas.md`, `thread-model.md`, `permissions.md`

---

### T16: Bootstrap OpenSpec project.md

**Owner:** Developer **[PARALLEL with T14, T15]**

**Description:** Create `openspec/project.md` documenting v2 conventions.

**Definition of Done:**

- [x] Naming conventions, required artifacts, review gates, branch
      naming, commit convention, pre-push gates, DoD checklist

---

### T17: Validate Full Build Pipeline

**Owner:** Developer

**Description:** Run complete pipeline end-to-end.

**Definition of Done:**

- [x] `npm ci`, `npx tsc --noEmit`, `npm run build`, `npm test`,
      `npm run lint`, `npm run format:check` all pass
- [x] `helm lint charts/thekraken` passes
- [x] `shellcheck scripts/entrypoint.sh kraken-hooks/pre-commit` passes
- [x] `docker buildx build --platform linux/amd64,linux/arm64 .`
      succeeds

---

### T18: Code Review

**Owner:** Code Reviewer

**Definition of Done:**

- [ ] Package structure matches design §11
- [ ] Config covers all env vars
- [ ] SQLite schema matches design §4 and §14.5a
- [ ] entrypoint.sh enforces git-state hard requirement
- [ ] No unused dependencies, no stale TODOs
- [ ] Conventional Commits used
- [ ] Sign-off recorded

---

### T19: Security Review

**Owner:** Senior Security Architect

**Definition of Done:**

- [ ] Git credentials via mounted Secret (no PAT on PVC disk)
- [ ] Dockerfile non-root (UID 1000)
- [ ] Helm Secrets not ConfigMaps for sensitive values
- [ ] NetworkPolicy egress scoped to MCP + git HTTPS
- [ ] No secrets in defaults or committed files
- [ ] Sign-off recorded

---

### T20: QA Review

**Owner:** Senior QA Engineer

**Definition of Done:**

- [ ] All unit tests pass
- [ ] AIMock, Slack mock, event simulator, hook, schema, config, health
      each have tests
- [ ] No flaky tests
- [ ] Sign-off recorded

---

### T21: Tech Writer Review

**Owner:** Senior Technical Writer

**Definition of Done:**

- [ ] README accurate; openspec/project.md complete
- [ ] JSDoc on config fields
- [ ] No stale references to NanoClaw, task scheduling, main/admin channel
- [ ] Sign-off recorded

---

### T22: Codex Review

**Owner:** Codex (automated)

**Skippable:** Yes, if Codex MCP unreachable (log reason + timestamp).

**Definition of Done:**

- [ ] Codex reviewed OR skip logged
- [ ] Critical findings addressed; non-critical logged as issues
