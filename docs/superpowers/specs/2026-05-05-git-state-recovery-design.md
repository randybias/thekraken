# Git-State Recovery — Design

**Date:** 2026-05-05
**Status:** approved (brainstorming complete, awaiting spec review and implementation plan)
**Owner:** rbias
**Ships in:** v0.10.0-rc.10 lockstep
**Related:**
- Master plan: `~/.claude/plans/2026-05-04-eastus-stabilization-rc10.md` (Task #6)
- Smart-path tightening (predecessor): `docs/superpowers/specs/2026-05-04-smart-path-tightening-design.md`

## Problem

Tentacular's git-state plumbing is partially landed but the user-facing
loop is incomplete:

- `tntc deploy` annotates Deployments with `tentacular.io/{git-sha,git-repo,git-branch}`.
- Kraken has `src/git-state/deployments-db.ts` (SQLite tracking
  version, sha, tag, summary, channel, ts).
- A `kraken-hooks/pre-commit` does monotonic `version:` bumps in
  `workflow.yaml`.

What's missing: **the recovery loop a non-technical user (marketing,
sales, ops) needs to revert a tentacle to an earlier behavior, modify
it, and redeploy — without ever seeing a SHA, version number, or git
term.**

The agent-callable CLI for revert (`tntc state restore`) doesn't
exist. Reconciliation between Kraken DB and cluster annotations
doesn't exist. The Kraken manager has no skill or tools for the
"version management" conversation. The deployer never composes a
plain-English summary of what it just shipped.

## Decision summary

Five decisions taken during brainstorming:

| # | Question | Choice |
|---|---|---|
| 1 | What is a "version" to the marketing/sales user? | **Deploy events** (Q1=A). Each deploy = a versioned moment with timestamp, deployer, summary. Numbers are internal-only. |
| 2 | Source of truth for what's deployed vs available vs the deploy log? | **Three different sources, all valid simultaneously**: cluster annotations for *what's deployed*, git history for *what's available*, Kraken DB for *deploy events* (rebuildable from cluster on loss). |
| 3 | When does the plain-English per-deploy summary get composed? | **Both** (Q3=C): per-deploy summary at deploy time by the deployer subprocess; comparative summaries lazily by the manager on query, cached after first generation. |
| 4 | What happens mechanically on "revert + tweak"? | **Manager commissions dev team with combined intent** (Q4=A). Forward-revert (not hard reset). One deploy event written for the combined change. |
| 5 | Disambiguation strategy for "go back to Tuesday's"? | **Always confirm before destructive actions** (Q5=A). Queries proceed without confirm; revert/tweak always confirms. |

Additional: **the user never sees a SHA, version number, or git term.** The
manager translates user intent ↔ internal identifiers behind the scenes.

## Architecture

```
Marketing user (Slack)         Agents (Claude Code, Kraken subprocesses)
        │                              │
        ▼                              ▼
  Enclave Manager              tntc state restore/log/status
   (LLM, skill)                       (CLI)
        │                              │
        ▼                              ▼
  Internal-ops:                  Cluster (annotations)
    list_deploy_events                  ▲ source of truth: WHAT IS DEPLOYED
    describe_change                     │
    commission_revert            Tentacles git repo
        │                               ▲ source of truth: WHAT IS AVAILABLE
        ▼                               │
    Kraken DB                    Dev team subprocess
   (deploy events,               (builder + deployer)
    LLM-generated                       │
    summaries)                          ▼
   ▲ source of truth:            On deploy: writes annotation,
    DEPLOY EVENT LOG              writes Kraken DB row with summary
    (rebuildable from cluster
    annotations on loss)
```

### Data model (locked)

| Question | Source of truth |
|---|---|
| What's actually deployed right now? | **Cluster annotations** (`tentacular.io/git-sha` on the Deployment object). Period. |
| What versions are available to deploy? | **Git history** of the tentacle's path in the tentacles repo. |
| Who deployed what when, with what summary? | **Kraken DB** (`deployments-db.ts`). Authoritative for events; reconstructible from cluster annotations if lost. |
| Plain-English summaries (per-deploy + comparative) | **Kraken DB cache.** Per-deploy summary generated at deploy time by deployer; comparative summaries generated on first query, cached. |

### Vocabulary contract (the load-bearing UX rule)

The manager's user-facing replies **never** contain:
- Version numbers (`v3`, `version 3`)
- Git SHAs (`abc123`, `commit abc123`)
- Git terms (`commit`, `tag`, `branch`, `revert`, `checkout`, `merge`)
- POSIX/cluster jargon (`namespace`, `kubectl`, `pod`, `rwxrwx`)

Allowed phrasing:
- Dates and times: "Tuesday at 2pm", "last week", "April 14"
- People: "Mary's change", "the version you deployed"
- Behavior: "the version that filtered by topic"
- Order: "the previous one", "two changes ago", "undo"

Internal data structures and CLI calls retain SHAs and identifiers
unchanged. The contract applies only to user-visible output.

### Components

**Existing, modified:**

| Component | Change |
|---|---|
| `tentacular/pkg/cli/state.go` (or similar) | Add `restore` subcommand; keep `init`, `commit`, `status`. (No `state log` — deploy event log with summaries is Kraken-internal, accessed via manager's internal-op, not CLI. Engineer-facing fallback is to read cluster annotations via `tntc state status` for what's deployed.) |
| `tentacular/pkg/cli/state_status.go` | Extend to report cluster-vs-git drift per tentacle. |
| `tentacular/pkg/builder/k8s.go` | Already injects `tentacular.io/git-{sha,repo,branch}`. No change needed. |
| `thekraken/src/git-state/deployments-db.ts` | Schema additions if needed (probably none — existing fields cover it). Add reconciler entry point. |
| `thekraken/src/dispatcher/internal-ops.ts` | Add three new ops: `list_deploy_events`, `describe_change`, `commission_revert`. Plus the deployer-side `record_deploy_event`. |
| `thekraken/src/agent/system-prompt.ts` | Update manager prompt (vocabulary contract, confirm flow, internal-op invocation rules). Update deployer prompt (compose + record summary post-commit, pre-deploy). |
| `thekraken/skills/kraken/SKILL.md` | Add 3-line "Version management" section pointing at the new reference. |
| `thekraken/test/e2e-slack/scenarios.ts` | Add M group (six scenarios). |

**New:**

| Component | Purpose |
|---|---|
| `tentacular/pkg/cli/state_restore.go` | Forward-revert + redeploy implementation. |
| `thekraken/src/git-state/reconciler.ts` | Pod-startup reconciliation: read cluster annotations per enclave, populate missing Kraken DB rows. Idempotent. |
| `thekraken/skills/kraken/references/git-state.md` | Manager's user-facing UX reference: vocabulary contract, four conversation primitives, when to confirm, how to invoke internal-ops. |

### Conversation flows

The four user-facing primitives:

```
1. List
   user:  what's been changing on ai-news-digest?
   mgr:   Three changes I see —
            • Tuesday 2:14pm — Mary raised the title length to 80 chars
            • last Friday   — you added topic filtering for "AI safety"
            • April 14      — original deploy
          Want me to walk through any of these in more detail?

2. Compare
   user:  what changed since last week?
   mgr:   Title length grew from 50 to 80 characters, and "AI safety"
          was added as a topic filter so off-topic items get dropped.

3. Revert (always-confirm)
   user:  go back to last Tuesday's
   mgr:   You mean Mary's Tuesday change — back to before the topic
          filtering was added. Want me to do that?
   user:  yes
   mgr:   On it.
   ... commission dev team, wait for completion ...
   mgr:   Done. Tuesday's behavior is back.

4. Revert + tweak (also always-confirm)
   user:  go back to last Tuesday's but raise the title limit to 80
   mgr:   So: Mary's Tuesday version, but with the title limit you
          want now (80 chars instead of 50). OK to proceed?
   user:  yes
   mgr:   On it.
   ... commission dev team with combined brief ...
   mgr:   Done.
```

### Manager's tool surface (new internal-ops)

These live in `thekraken/src/dispatcher/internal-ops.ts`. NOT MCP
tools — they touch Kraken-local state (SQLite + git checkout).

| Internal op | Caller | Returns | Notes |
|---|---|---|---|
| `list_deploy_events` | Manager LLM | `Array<{ts, deployer_email, summary, _internal_sha}>` | `_internal_sha` is for the LLM's reasoning, never for output. |
| `describe_change` | Manager LLM | `{summary: string, cached: boolean}` | First checks Kraken DB for cached comparative summary keyed on `(sha1, sha2)`. On miss, runs `git diff <sha1> <sha2>` against the tentacles checkout, returns the diff to the manager (as tool result), manager composes and stores the summary via a follow-up `record_change_summary` call. (Two-step on miss because the LLM is the manager itself.) |
| `commission_revert` | Manager LLM | `{job_id, status: 'commissioned'}` | Triggers dev team subprocess with structured brief: `{target_sha, additional_intent?: string}`. Async; manager waits for completion via the existing team-bridge outbound channel. |
| `record_deploy_event` | Deployer subprocess | `{ok: true}` | Writes deploy event row with summary to Kraken DB. Called between commit and deploy in the deployer workflow. |

### Reconciliation behavior

**On Kraken pod startup:**
1. For each enclave the bot is bound to, call `wf_list <enclave>` via MCP.
2. For each tentacle workflow, read its `tentacular.io/git-sha` and `tentacular.io/deployed-by` annotations.
3. For each `(enclave, tentacle, git-sha)` triple not present in Kraken DB, insert a stub row:
   - `summary = "(reconstructed from cluster — no original notes)"`
   - `deployer_email = annotation deployed-by value`
   - `created_at = annotation deployed-at if present, else "unknown"`
4. Idempotent: re-running the reconciler with no changes is a no-op.

**No backfill of pre-existing tentacles** beyond this. They get one
synthetic row each; subsequent deploys produce real-summary rows.

### Per-deploy summary generation (deployer subprocess)

The deployer's existing workflow gains one step between "commit" and
"wf_apply":

1. Compute the diff:
   ```bash
   git diff <prior_deployed_sha>..HEAD -- <tentacle_path>
   ```
   (or `HEAD~1..HEAD` if no prior deployed SHA exists.)
2. LLM-compose a one-sentence non-engineer summary of the diff via
   the deployer's existing LLM context. Prompt fragment:
   ```
   After the commit, before deploy, compose a one-sentence
   plain-English summary of what THIS deploy changes for a
   non-engineer. Don't mention file names, diff syntax, or
   technical terms. Then call `record_deploy_event` with the
   summary, the git SHA, your email, and the current timestamp.
   ```
3. Call `record_deploy_event` (new internal op).
4. Proceed to `wf_apply`.

If the deployer fails to compose (e.g., LLM error), it falls back to
`summary = "(deployed; no notes)"` and proceeds. Reconciler will not
re-write this row later.

### Skill addition

`thekraken/skills/kraken/references/git-state.md` (NEW) covers:

1. **The vocabulary contract** — what the manager says vs doesn't say (table from this spec).
2. **The four conversation primitives** — list, compare, revert, revert+tweak — with full example dialogues showing the prompt-side patterns the manager should use.
3. **Internal-op invocation rules:**
   - For "what versions / what's been changing" → call `list_deploy_events` first. Never describe state from memory.
   - For "what changed between X and Y" → call `describe_change(<sha_X>, <sha_Y>)` (manager translates user references to SHAs internally).
   - For "go back to X" / "revert" / "undo" → confirm in the same turn, then call `commission_revert` only after explicit user `yes`.
4. **Ambiguity handling** — when multiple deploys match the user's reference (e.g., "Tuesday's" with two Tuesday deploys), ask the user which one with concrete differentiators (deployer name + time-of-day + summary). Never list SHAs as differentiators.
5. **Edge cases:**
   - User asks about a tentacle with no deploy events: "I don't have a record of past deploys for this — as new changes happen I'll start tracking them."
   - User asks about a deploy event with `(reconstructed from cluster — no original notes)`: "I see this was deployed on <date> by <email> but I don't have notes on what changed — want me to compare it against the prior version?"
   - User says SHAs/version numbers/git terms: ignore the technical reference and re-anchor on dates/people/behavior.

`SKILL.md` gets a 3-line pointer:
```markdown
## Version management

Tentacles are versioned by deploy events — each deploy is a moment in
time with a person, summary, and (internally) a git SHA.

Read `references/git-state.md` when:
- User asks what's changed, what versions exist, or what was deployed when
- User wants to go back to a previous behavior, undo a change, or revert
- User wants to revert AND modify in one shot
```

### Manager prompt updates

Three additions to `buildManagerPrompt` in `src/agent/system-prompt.ts`:

1. **Vocabulary contract** (the table content as prose rules).
2. **Confirmation rule** — "For revert-class actions (go back, undo, revert with or without modifications), always present a one-line plain-English confirm and wait for explicit `yes` before commissioning the dev team. Never confirm queries."
3. **Grounding rule** — "When the user asks about versions, deploy history, or what changed, your first action must be `list_deploy_events` (for the tentacle they named, or asking which tentacle if unclear). Never describe state from memory."

### Deployer prompt updates

`buildDeployerPrompt` (or wherever the deployer's prompt lives) gains
the per-deploy summary step described in "Per-deploy summary
generation" above.

## Implementation phases

| Phase | What | Repo | Branch |
|---|---|---|---|
| **G1** | `tntc state restore` (forward-revert + redeploy) and `tntc state status` extension (drift detection). CLI surface for agents. Unit tests for restore math. | `tentacular` | `feat/cli-state-restore` |
| **G2** | Reconciler at Kraken pod startup. Idempotent. Reads cluster annotations, populates Kraken DB. Unit tests. | `thekraken` | `feat/git-state-reconciler` |
| **G3** | Deployer per-deploy summary generation. Deployer prompt update + `record_deploy_event` internal-op. Unit tests for summary composition. | `thekraken` | `feat/deployer-summary` |
| **G4** | Manager internal-ops: `list_deploy_events`, `describe_change`, `commission_revert`. Wired into dispatcher's existing internal-ops registry. Unit tests. | `thekraken` | `feat/manager-git-state-ops` |
| **G5** | Manager prompt updates + skill addition (`references/git-state.md`, SKILL.md pointer). | `thekraken` | `feat/git-state-skill` |
| **G6** | E2E M group scenarios in `test/e2e-slack/scenarios.ts`. Six scenarios. | `thekraken` | `feat/e2e-git-state-m-group` |

Each phase = its own branch + PR. Land incrementally.

G1 is the prerequisite for everything else. G2 must land before G4
(manager's `list_deploy_events` query relies on reconciled rows for
pre-rc.10 deploys). G3 should land before G4 so the manager's first
real query has actual summaries. G5 depends on G4. G6 depends on
G1–G5 being deployed.

## Testing

### Unit tests

Listed in component table above. Summary:
- `tentacular`: `tntc state restore` forward-revert math, idempotent re-deploy of HEAD, restore writes Kraken DB row, status drift detection.
- `thekraken`: reconciler idempotency + correct row reconstruction, deployer summary composition, internal-op behavior (cache hit/miss for `describe_change`, async commission for `commission_revert`).

### E2E M group (Slack live, in `test/e2e-slack/scenarios.ts`)

| ID | Channel | Message | Validates |
|---|---|---|---|
| **M1** | enclave | `@Kraken what's been changing on ai-news-digest?` | List flow. Forbidden: `/v\d+\b\|sha\|commit\|tag\|branch/i`. Expected: at least 2 dated entries with summaries (after some deploys have happened). |
| **M2** | enclave | `@Kraken what changed since last week?` | Comparative summary. Forbidden: same set, plus `/^[+-]/m`. Expected: prose mentioning specific behavior changes. |
| **M3** | enclave | `@Kraken go back to last Tuesday's version of ai-news-digest` | Revert flow. Expected: confirm prompt; on user `yes`, manager commissions dev team; mcpAssertion: cluster annotation `tentacular.io/git-sha` on the Deployment changes within window. |
| **M4** | enclave | `@Kraken go back to last Tuesday's but raise the title limit to 80` | Revert + tweak. Confirm prompt → yes → dev team commission → cluster annotation advances → Kraken DB row written. |
| **M5** | enclave | (precondition: 2 deploys on same Tuesday) `@Kraken go back to Tuesday's version` | Ambiguity. Expected: manager asks which one (deployer name + time-of-day). Forbidden: SHA in disambig prompt. |
| **M6** | enclave | `@Kraken what changed in commit abc123?` | Vocabulary control. Manager refuses git-talk. Expected: redirect to dated/behavior-based phrasing. Forbidden: confirms understanding of "abc123" as a meaningful identifier. |

The L group's mcpAssertion pattern (poll cluster after reply) is
reused for M3–M5. Forbidden patterns are aggressive — any leakage of
internal vocabulary fails the test.

### Test runtime gates

- M1, M2 require ≥2 deploys to have happened on the test tentacle. Harness can either pre-seed via `tntc deploy` calls or rely on prior-scenario state.
- M3, M4, M5 require Kraken DB to have multiple deploy events. Harness pre-seeds.
- M6 has no preconditions.

## Rollout & migration

- Lives in `tentacular` (CLI) and `thekraken` (manager + skill + tests). Two repos, both in lockstep rc.10.
- No data migration needed.
- Pre-rc.10 tentacles get one synthetic Kraken DB row each on next pod restart (reconciler). Marketing user sees "(no notes available)" for that single row, real summaries for any deploys that happen post-rc.10.
- The `~/tentacles` git repo must have a remote configured (master plan Task #11). Without it, `commission_revert` and `record_deploy_event`'s commit-and-push paths fail. This is a hard prerequisite, sequenced before G6 in the master plan's Phase 4.

## Out of scope

- **Backfill of pre-existing deploy summaries.** Confirmed N/A. Reconciler synthesizes one row each; no LLM call to reconstruct what we don't know.
- **Branching / multiple deployment streams.** Everything lives on `main`. No "deploy a feature branch to staging" flow.
- **Cross-enclave version comparison.** "Show me how ai-news-digest differs between agensys and e2e-test" — not a real workflow.
- **Engineer-friendly CLI ergonomics.** Per the agent-first directive — `tntc state ...` output is whatever an agent parses cleanly.
- **Permission enforcement on revert.** Currently any enclave member can revert. Per-mode (member-edit, owner-only) gating is `tentacular-mcp` authz work, separate scope. Tracked in skill `permissions.md` if it lands later.
- **CI/CD-driven deploys.** Out of scope; this design assumes deploys come from CLI or Kraken's dev team subprocess.

## Acceptance criteria

1. Kraken pod startup reconciliation populates 1 row per currently-deployed tentacle in `tentacular-agensys`. Verified by querying `deployments_db` after restart.
2. Every new deploy via `tntc deploy` or `commission_revert` produces a Kraken DB row with a non-empty `summary` field (not the "(reconstructed from cluster)" placeholder).
3. M1 reply contains zero matches for `/v\d+\b|sha|commit|tag|branch|rwx|namespace|kubectl/i`. Same for M2, M3, M4, M5, M6.
4. M3 — after `yes` confirmation, cluster annotation `tentacular.io/git-sha` on the `ai-news-digest` Deployment in `tentacular-agensys` advances to a new SHA whose tree matches the targeted past commit's tree.
5. M5 reply asks for disambiguation when multiple deploys match the user's reference. Disambiguation prompt uses person + time + summary, not SHAs.
6. End-to-end: a marketing user types in Slack — never sees a SHA, never sees `v\d+`, never sees git terminology — and successfully reverts a tentacle, then modifies it, then queries the change history.
