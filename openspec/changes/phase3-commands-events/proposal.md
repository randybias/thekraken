# Phase 3: Commands + Channel Events + Personas — Proposal

**Change ID:** phase3-commands-events
**Status:** DRAFT
**Created:** 2026-04-13
**Author:** Senior Product Manager / Senior Architect
**Branch:** feature/phase3-commands-events

---

## 0. Problem Statement

Phases 0-2 delivered the core dispatcher, per-enclave team architecture, OIDC
auth, POSIX authz, and tool scoping. But the Kraken cannot yet:

- Execute deterministic @kraken commands (add/remove/transfer/archive/delete)
- React to Slack channel lifecycle events (join/leave/archive/rename)
- Provision new enclaves through a DM conversation flow
- Infer team personas from enclave descriptions
- Detect and reconcile membership drift between Slack and Kubernetes
- Filter infrastructure jargon from agent output

These are the operational primitives that make the Kraken useful to
non-technical users. Without them, the only interaction path is the
smart (LLM) path, which cannot perform membership management or
enclave lifecycle operations.

---

## 1. Deliverables

### D1: Command Router — Membership Commands

Implement `@kraken add @user`, `@kraken remove @user`,
`@kraken transfer to @user` as deterministic commands.

**Acceptance Criteria:**
- `add @user` calls `enclave_sync` with `add_members: [email]` using the
  commanding user's OIDC token (D6). Posts ephemeral confirmation.
- `add @user1 @user2` handles multiple mentions in a single command.
- `remove @user` calls `enclave_sync` with `remove_members: [email]`.
  Tentacles owned by the removed user transfer to the enclave owner.
  Posts ephemeral report including transfer summary.
- `transfer to @user` calls `enclave_sync` with `transfer_owner: email`.
  Requires double-confirmation (ephemeral prompt, user must reply "yes").
- All three require the commanding user to be the enclave owner.
  Non-owners get an ephemeral denial.
- All three require a valid OIDC token. Unauthenticated users get the
  device-flow auth card (reuse Phase 2 auth gate).

### D2: Command Router — Enclave Lifecycle Commands

Implement `@kraken archive`, `@kraken delete enclave`, `@kraken members`,
`@kraken whoami`, `@kraken help`.

**Acceptance Criteria:**
- `archive` calls `enclave_sync(status=frozen)`, then calls `wf_remove`
  for each tentacle in the enclave (dehydration). Owner-only.
  Posts ephemeral confirmation with tentacle count.
- `delete enclave` calls `enclave_deprovision`. Requires double-confirmation
  (ephemeral "type DELETE to confirm"). Owner-only. Irreversible.
- `members` calls `enclave_info` and posts ephemeral list: owner + members.
  Available to owners and members.
- `whoami` looks up the user's token, extracts email and role from
  enclave_info. Posts ephemeral result. Available to all authenticated users.
- `help` posts ephemeral natural-language command list (Section 6a of the
  design doc). Available to everyone.
- Command disambiguation: `@kraken add @alice` = command (has @mention);
  `@kraken add a new node` = agent (no @mention). Rule: first non-filler
  word after verb must be @mention for member commands.

### D3: Channel Event Handlers

Register Slack Bolt event handlers for channel lifecycle events.

**Acceptance Criteria:**
- `member_joined_channel`: log as visitor, no enclave membership change.
  No auto-add. (Confirmed: design Section 6c.)
- `member_left_channel`: if user is an enclave member (not just visitor),
  call `enclave_sync(remove_members)`. Transfer tentacles to owner.
  Invalidate authz cache.
- `channel_archive`: call `enclave_sync(status=frozen)`. Dehydrate all
  tentacles (same as `@kraken archive`). Invalidate authz cache.
- `channel_unarchive`: call `enclave_sync(status=active)`. Rehydrate is
  NOT automatic (operator must manually redeploy — see Design Decision 7).
- `channel_rename`: call `enclave_sync(new_channel_name)`.
- All handlers are best-effort: failures logged, drift detection catches up.
- Bot self-events (bot join/leave) are filtered out.

### D4: Enclave Provisioning Flow

Multi-turn DM conversation for creating a new enclave.

**Acceptance Criteria:**
- Owner DMs Kraken with intent to create an enclave (e.g., "set up
  #marketing-analytics as an enclave").
- Flow: authenticate (if needed) -> verify channel ownership -> propose
  name (slugified channel name) -> solicit optional description -> call
  `enclave_provision` with defaults (mode=rwxrwxr--, quota=medium) ->
  post description card in the target channel.
- Conversation state tracked in-memory with 10-minute timeout.
- If description is provided, infer persona (D5) and store in MEMORY.md.
- If description is skipped ("skip"), no persona inference.
- Channel ownership verification via Slack API
  (`conversations.info` -> `creator` field).

### D5: Persona Inference

Infer team persona from enclave description text.

**Acceptance Criteria:**
- 11 archetypes from design Section 3: Marketing, Sales, Customer Support,
  Operations, IT, Software Development, Architecture, Finance, HR, Legal,
  Executive.
- Keyword-based matching on description text. Multiple matches resolved
  by highest keyword count. Tie-breaking: first match in archetype order.
- Persona stored in enclave MEMORY.md (human-readable, loaded into agent
  system prompt for all threads in that enclave).
- Persona adjusts: language level, suggested scaffolds, technical detail.
- Owner can override: "treat us like a technical team" updates MEMORY.md.

### D6: Drift Detection

Periodic reconciliation of Slack channel members vs enclave annotations.

**Acceptance Criteria:**
- Runs on configurable interval (default: 5 minutes).
- Round-robin batches (default: 5 enclaves per cycle).
- Compares Slack channel members (resolved to emails) vs enclave members
  annotation. Removes stale members (in annotation but not in Slack).
- NEVER auto-adds (Slack join != enclave membership).
- NEVER removes the enclave owner.
- Skips frozen enclaves.
- Invalidates authz cache on corrections.
- Logs all discrepancies; never posts to Slack.
- **D6 exception (documented):** Drift detection is system-level, not
  user-initiated. MCP calls use a system context (no specific user token).
  This is the one narrow exception to the user-identity hard partition.
  The MCP server must permit system-level `enclave_info` and `enclave_sync`
  calls for drift. See Design Decision 5.

### D7: Jargon Filter

Post-process agent output to replace infrastructure jargon.

**Acceptance Criteria:**
- Vocabulary from `thekraken-reference/src/jargon-filter.ts` ported and
  extended: namespace->enclave, pod->service, DAG->workflow,
  container->service, gVisor->secure sandbox, etc.
- Narration filter: strip third-person narration and emoji signatures.
- Applied in the outbound poller before Slack posting (centralized,
  one place for all team output).
- Does NOT modify content inside code blocks (backtick-fenced).
- Unit tests with before/after pairs for every substitution.

### D8: Followup Closure

Close deferred followups from Phases 1-2.

**Acceptance Criteria:**
- F23: Complete the routing matrix test. All 13 admission criteria tested.
  Remove dead types (`ignore_visitor`, `novel_phrasing`) or implement them.
- F24: Unit tests for `gcStaleTeams()` and `checkIdle()` using fake timers.
  Wire GC to startup + hourly interval.
- F25: Team directory permissions set to `0o700` in `ensureTeamDir()`.
- F26: Config test `beforeEach` cleans up `KRAKEN_TEAMS_DIR` env var.
- FN-2: Bound-channel messages require @mention or thread context. Messages
  in an enclave channel without @mention and without being in an existing
  thread are ignored (deterministic path, not smart path).

---

## 2. Out of Scope

- Block Kit cards (Phase 4)
- Home Tab (Phase 4)
- Deploy/rollback flow (Phase 4 — requires MCP `wf_apply` version field)
- Restart resilience (Phase 5)
- JWT signature validation (F27, Phase 5)
- Authz cache keying fix (F28, Phase 5)

---

## 3. PM Decision: Dehydration Without `wf_stop`

The MCP server has no `wf_stop` or `wf_scale` tool. The available tools
are `wf_remove` (deletes all resources) and `wf_restart` (rolling restart).

**Decision:** Archive dehydration uses `wf_remove` for each tentacle.
Rehydration is NOT automatic — the operator (or user, in Phase 4 with
deploy flow) must redeploy tentacles after unarchive. This aligns with
the existing position (F1: archive is "somewhat destructive").

**Rationale:** Scaling deployments to 0 replicas would require a new MCP
tool (`wf_scale`). That is cross-repo work and out of scope for Phase 3.
`wf_remove` is the only existing destructive tool that achieves pod
shutdown. The git-state repo preserves all tentacle source — nothing is
permanently lost. Phase 4's deploy flow will enable one-command rehydration.

---

## 4. PM Decision: Drift Detection D6 Exception

Drift detection runs as a background system loop. It cannot carry a
specific user's OIDC token because no user initiated the action. This
is the ONE documented exception to D6 (user identity hard partition).

The MCP server must support system-level read (`enclave_info`,
`enclave_list`) and write (`enclave_sync` for member removal) without
a user-scoped Bearer token. Options:

1. **Operator service account:** A Keycloak service account specifically
   for drift detection, with narrow RBAC (read enclave info, sync members).
2. **Bearer token bypass:** A static token configured via Helm for
   system operations only.
3. **Unauthenticated read + write with audit:** MCP server permits
   certain calls from in-cluster callers without a Bearer token, logged
   as "system:drift-detection".

**Decision:** Option 1 (operator service account) for production. For
development/RC, option 2 (bearer token) is acceptable. The drift
detection config adds `KRAKEN_DRIFT_SERVICE_TOKEN` env var, used ONLY
for drift MCP calls. This token is NOT propagated to any enclave team
or user-facing operation.

This must be reviewed and signed off by the Security Architect.

---

## 5. Dependencies

- Phase 2 complete (OIDC, authz, tool scoping) — DONE
- MCP tools: `enclave_info`, `enclave_sync`, `enclave_provision`,
  `enclave_deprovision`, `enclave_list`, `wf_remove` — all exist
- Slack Bolt event subscriptions: `member_joined_channel`,
  `member_left_channel`, `channel_archive`, `channel_unarchive`,
  `channel_rename` — require Slack app event subscription update

---

## 6. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Slack rate limits on member resolution during drift | Stale drift state | Round-robin batching (5/cycle), email cache |
| Channel ownership API unreliable | Provisioning blocked | Fall back to "first authenticated user" heuristic |
| No `wf_stop` tool | Destructive dehydration | Document in help, implement `wf_scale` in Phase 4+ |
| Drift service token widens attack surface | Security concern | Narrow RBAC, audit log, Security Architect review |

---

## 7. Test Impact

- Phase 2 baseline: 448 tests passing
- Phase 3 target: ~530-550 tests (80-100 new)
- New test files: commands, channel events, provisioning flow, persona
  inference, drift detection, jargon filter, routing matrix completion
