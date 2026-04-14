# Phase 3: Commands + Channel Events + Personas — Tasks

**Change ID:** phase3-commands-events
**Status:** DRAFT
**Created:** 2026-04-13
**Branch:** feature/phase3-commands-events

---

## Conventions

- **Pre-push gate:** `npm test && npx tsc --noEmit && npm run lint && npm run format:check`
- **Commit after each task group passes the pre-push gate.**
- **Conventional Commits** on `feature/phase3-commands-events`.
- Phase 2 baseline: 448 tests. Phase 3 must not regress.

---

## Task Groups

### TG-A: Command Infrastructure (T01-T04)

**Parallelism:** T01 and T02 independent. T03 depends on T01+T02. T04 depends on T02.

#### T01: Expand parseCommand() in router.ts

Extend `src/dispatcher/router.ts` with full command grammar.

- Add action types: `enclave_archive`, `enclave_delete`, `enclave_members`, `enclave_whoami`, `enclave_help`, `ignore_no_mention`.
- Multi-mention: `add @user1 @user2` (change `targetUserId` to `targetUserIds[]`).
- `transfer to @user` pattern ("to" optional keyword).
- Exact-phrase: `archive`, `delete enclave`, `members`, `whoami`, `help`.
- Disambiguation: first non-filler word after verb must be @mention.
- Remove `novel_phrasing` from SmartReason.

**DoD:** parseCommand() handles 9 command types. >= 25 unit tests. Typecheck passes.

#### T02: Command context types + factory

Define `CommandContext`, `CommandResult`, `McpCallFn` in `src/enclave/commands.ts`. Implement `buildCommandContext()`.

**DoD:** Types exported. Factory tested. Typecheck passes.

#### T03: Membership command handlers

Implement `handleAdd`, `handleRemove`, `handleTransfer`, `executeTransfer` in `src/enclave/commands.ts`. Owner-only gate. Transfer returns confirmation prompt.

**DoD:** >= 15 unit tests (mocked mcpCall, resolveEmail). Typecheck passes.

#### T04: Lifecycle command handlers

Implement `handleArchive`, `handleDelete`, `executeDelete`, `handleMembers`, `handleWhoami`, `handleHelp` in `src/enclave/commands.ts`.

**DoD:** >= 12 unit tests. Archive calls wf_remove per tentacle. Delete returns double-confirm. Typecheck passes.

---

### TG-B: Bot Wiring + Channel Events (T05-T08)

**Parallelism:** T05 depends on TG-A. T06 independent. T07 depends on T06. T08 depends on T07.

#### T05: Wire commands into bot.ts executeDecision()

Replace Phase 1 stubs with real command handling. Import handlers, run auth gate, build context, post ephemeral. Implement double-confirmation flow (in-memory `PendingConfirmation` map, 60s timeout).

**DoD:** All command actions execute handlers. Double-confirm for transfer/delete. 5 integration-level tests. Typecheck passes.

#### T06: Channel event handlers in src/slack/events.ts

Replace stub. `member_joined_channel` (log, no action), `member_left_channel` (remove if member, transfer), `channel_archive` (freeze + dehydrate), `channel_unarchive` (activate, no auto-rehydrate), `channel_rename` (sync name). Filter bot self-events.

**DoD:** >= 12 unit tests. Typecheck passes.

#### T07: Wire channel events into bot.ts

Register `app.event()` handlers. Normalize into InboundEvent, route through routeEvent(). Add new deterministic action type `channel_event`. OTel spans.

**DoD:** All 5 event types registered. Typecheck passes.

#### T08: FN-2 — Bound-channel @mention requirement

Messages in enclave channels without @mention and not in an existing thread return `ignore_no_mention`. DMs unaffected.

**DoD:** 4 unit tests. Typecheck passes.

---

### TG-C: Provisioning + Personas + Drift (T09-T11)

**Parallelism:** T09 and T10 independent. T11 depends on T09.

#### T09: Persona inference engine

Implement `src/enclave/personas.ts`. 11 archetypes with keywords, languageLevel, suggestedScaffolds, technicalDetail. `inferPersona(description)` returns best match. `formatPersonaForMemory(persona)` for MEMORY.md.

**DoD:** 14 unit tests (one per archetype + 3 edge cases). Typecheck passes.

#### T10: Drift detection loop

Implement `src/enclave/drift.ts`. `DriftDetector` class with start/stop, configurable interval + batch size, round-robin offset. Never auto-add, never remove owner, skip frozen. Uses drift service token. Wire into index.ts startup. Wire GC to startup + hourly (F24).

**DoD:** >= 10 unit tests with fake timers. GC wired. Typecheck passes.

#### T11: Enclave provisioning flow

Implement `src/enclave/provisioning.ts`. `ProvisioningFlow` class with 7-state machine. 10-min timeout. Channel ownership via Slack API. Calls `enclave_provision` with defaults. Persona inference on description. MEMORY.md write. Post description card.

**DoD:** >= 10 unit tests for state transitions. Typecheck passes.

---

### TG-D: Jargon Filter (T12-T13)

**Parallelism:** T12 independent. T13 depends on T12.

#### T12: Jargon filter module

Implement `src/extensions/jargon-filter.ts`. Port vocabulary + narration filter from reference. Code block protection (split on triple-backtick, filter only non-code). `filterOutput()` combines both.

**DoD:** >= 25 unit tests (before/after pairs + code block preservation). Typecheck passes.

#### T13: Wire jargon filter into outbound poller

Apply `filterOutput()` in `processRecord()` for `slack_message` records only.

**DoD:** Unit test verifies filtered text posted. Typecheck passes.

---

### TG-E: Followup Closure (T14-T18)

**Parallelism:** All independent. Can run parallel with TG-C/TG-D.

#### T14: F23 — Complete routing matrix test

Test criterion 5 (`enclave_sync_transfer`), smart reasons (`status_check`, `help_request`). Remove `novel_phrasing`, add `ignore_visitor` emission path.

**DoD:** All 13 criteria tested. Typecheck passes.

#### T15: F24 — gcStaleTeams() and checkIdle() tests

Unit tests for GC (filesystem fixtures) and idle timeout (fake timers). Wire GC to startup + hourly interval.

**DoD:** >= 4 tests. GC wired. Typecheck passes.

#### T16: F25 — Team directory permissions 0o700

Add `{ mode: 0o700 }` to `ensureTeamDir()` mkdirSync.

**DoD:** Unit test verifies mode. Typecheck passes.

#### T17: F26 — Config test cleanup

Add `delete process.env['KRAKEN_TEAMS_DIR']` to beforeEach in config.test.ts.

**DoD:** No env var leak. Typecheck passes.

#### T18: Drift detection config

Add `DriftConfig` to `src/config.ts` (intervalMs, maxChannelsPerCycle, serviceToken). Update Helm values.yaml + secret.yaml. Disabled with warning if no token.

**DoD:** Config tested. Helm updated. Typecheck passes.

---

## Review Gates

### Gate 1: After TG-A + TG-B

**Reviewer:** Code Reviewer. All commands execute. Auth gate enforced. Channel events route correctly. Double-confirm works. No regression.

### Gate 2: After all TGs

**Reviewer:** Code Reviewer + Security Architect. Provisioning correct. Personas cover 11 archetypes. Drift uses service token (Security sign-off). Jargon preserves code blocks. All followups closed. Tests >= 530.

### Gate 3: QA Engineer

Scenario tests for provisioning, disambiguation (20+ edge cases), drift, jargon regression.

### Gate 4: Security Architect

Drift token scope narrow. Not propagated. Owner-only destructive commands. Double-confirm. No token leakage in ephemeral.

---

## Execution Order

```
Week 1:  T01, T02 (parallel) -> T03 -> T04    | T09, T10, T12 (parallel) | T14-T18 (parallel)
Week 2:  T05 -> T06 -> T07 -> T08             | T11 -> T13
         Gate 1 -> Gate 2 -> Gate 3 -> Gate 4
```

## Config Changes

| Env Var | Default | Required | Purpose |
|---------|---------|----------|---------|
| `KRAKEN_DRIFT_INTERVAL_MS` | `300000` | No | Drift interval |
| `KRAKEN_DRIFT_BATCH_SIZE` | `5` | No | Enclaves per cycle |
| `KRAKEN_DRIFT_SERVICE_TOKEN` | empty | No | Service token for drift |
