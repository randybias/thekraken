# Phase 4: Polish + Deploy — Proposal

**Change ID:** phase4-polish-deploy
**Status:** IMPLEMENTED
**Created:** 2026-04-13
**Author:** Senior Developer

---

## Problem

After Phase 3, The Kraken had working commands and channel events but all
output was plain text. The deployment path (teams writing tentacle code) had
no git-backed commit/tag/apply flow, no rollback capability, and no structured
Slack UI for enclaves. Key Codex findings from Phase 3 review were also
unaddressed.

## Deliverables

**D1 — Block Kit Formatter**
Port the reference formatter to a pure function. Apply in the outbound poller
so all agent responses render as structured Block Kit rather than raw Markdown.

**D2 — Structured Cards**
Purpose-built Block Kit cards for four surfaces: enclave list, workflow status,
health summary, and auth prompts. Used by commands that need richer output
than a plain paragraph.

**D3 — Slack Home Tab**
Wire `app_home_opened`. Authenticated users see their enclaves with health
indicators (green/yellow/red/white circles), roles, and Chroma deep links.
Unauthenticated users see a device-flow login prompt.

**D4 — Git-State Deploy Flow**
The deployer subprocess calls `deploy()` which: validates a human-readable
explanation (no infra jargon, 10-80 chars), commits the tentacle YAML, lets
the pre-commit hook bump the monotonic version, tags `{tentacle}-v{N}`, pushes,
calls `wf_apply` on the MCP server, and records the deployment in SQLite.

**D5 — Git-State Rollback Flow**
The `rollback()` function verifies a target tag exists, checks out that tag's
directory tree into the working tree (without detaching HEAD), commits (version
bumps again), re-tags, pushes, and calls `wf_apply`.

**D6 — Wire Drift Detection**
Enable the disabled `DriftDetector` with real Slack adapters (`resolveEmail`
from `users.info`, `listChannelMembers` from `conversations.members`). The
drift detector is the single D6 exception: background process uses service
config, not user OIDC token.

**D7 — Codex Fixes**
(a) Per-request user-bound `mcpCall` — wrap MCP call with the current user's
OIDC token instead of a shared service token.
(b) Mention gate before command parse — top-level channel messages without a
bot mention do NOT trigger command parsing; they forward to the team.
(c) Trailing text rejection — mutating commands (add/remove/transfer/archive/
delete) that have non-mention trailing text return `null` from `parseCommand`.

**D8 — Docs**
Update README.md, CLAUDE.md, charts/thekraken/README.md, and write these
OpenSpec artifacts to reflect Phase 4 additions.

## Non-Goals

- LLM wiring for the smart path (Phase 5+)
- Home Tab live data from MCP (post-Phase 4, marked TODO)
- Advanced deploy validation (schema checks, dry-run) (Phase 5)

## Acceptance Criteria

- `npm test` passes with 742+ tests
- `npx tsc --noEmit` clean
- `npm run lint` 0 errors
- `npm run format:check` clean
- All eight deliverables have corresponding unit tests
