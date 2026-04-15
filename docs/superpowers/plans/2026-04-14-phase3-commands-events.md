# Phase 3: Commands + Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the @kraken command router, channel event handlers, jargon filter, and enclave provisioning flow so the Kraken can manage enclave membership, respond to Slack lifecycle events, and filter agent output for end users.

**Architecture:** Port command handlers and event processing from `thekraken-reference/src/commands/` and `thekraken-reference/src/channel-events.ts`. Commands are deterministic (no LLM) — they run before authz and dispatch. The jargon filter runs on all agent output before posting to Slack.

**Tech Stack:** TypeScript, vitest, Slack Bolt event types

**Port source:** `thekraken-reference/src/commands/`, `thekraken-reference/src/channel-events.ts`, `thekraken-reference/src/jargon-filter.ts`

**MCP tools used by this phase:**
- `enclave_info({name})` — fetch enclave metadata for members/whoami/mode commands
- `enclave_sync({name, ...})` — add/remove members, transfer ownership, freeze, rename
- `enclave_provision({name, owner_email, owner_sub, ...})` — create new enclave
- `enclave_deprovision({name})` — delete enclave
- `wf_list({enclave})` — list workflows for prompts/templates commands
- `wf_describe({name, enclave})` — get workflow detail for prompts/templates

**Critical rule:** Commands are deterministic — no LLM involved. They parse text, call MCP, format a response. Port from the reference.

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Replace stub | `src/enclave/commands.ts` | Command parser + handler dispatch |
| Create | `src/enclave/handlers/membership.ts` | add, remove, members, whoami handlers |
| Create | `src/enclave/handlers/mode.ts` | set mode handler |
| Create | `src/enclave/handlers/prompts.ts` | show prompts/templates handlers |
| Replace stub | `src/enclave/provisioning.ts` | Enclave provision/deprovision wrappers |
| Replace stub | `src/enclave/drift.ts` | member_left reconciliation |
| Replace stub | `src/extensions/jargon-filter.ts` | Jargon vocabulary + narration filter |
| Modify | `src/slack/bot.ts` | Wire commands into event flow, apply jargon filter to output |
| Modify | `src/enclave/index.ts` | Re-export commands and provisioning |
| Create | `test/unit/commands.test.ts` | Command parser + handler tests |
| Create | `test/unit/jargon-filter.test.ts` | Jargon + narration filter tests |
| Create | `test/unit/channel-events.test.ts` | Channel event handler tests |
| Create | `test/unit/provisioning.test.ts` | Provision/deprovision tests |

---

### Task 1: Jargon Filter

**Files:**
- Replace: `src/extensions/jargon-filter.ts`
- Create: `test/unit/jargon-filter.test.ts`

Port from `thekraken-reference/src/jargon-filter.ts`. Pure function, no dependencies.

**Tests to write:**
- namespace -> enclave
- pod/container -> service
- postgres -> database, rustfs -> file storage, NATS -> messaging service
- ConfigMap -> configuration
- gVisor -> secure sandbox
- Strips narration ("Informed the user...", "I've sent...")
- Strips emoji signatures (:octopus:, :kraken:)
- Replicas -> instances
- kubectl/tntc commands -> _(system command)_

**Implementation:** Copy `thekraken-reference/src/jargon-filter.ts`, change logger import to `../logger.js`.

---

### Task 2: Command Parser + Router

**Files:**
- Replace: `src/enclave/commands.ts`
- Create: `test/unit/commands.test.ts` (parser tests only)

Port the command parser from `thekraken-reference/src/commands/router.ts`.

**Parser behavior:**
- Detect `@kraken` or `<@BOT_ID>` mention
- Extract command + args after mention
- Match against known commands: add, remove, members, whoami, set mode, show prompts/templates, help, transfer, archive, delete
- Return `{ command, args, raw }` or null (not a command)

**Tests:** Parse "add @user", "remove @user", "members", "whoami", "set mode team", "show prompts", "help", and non-command text.

---

### Task 3: Membership Handlers (add, remove, members, whoami)

**Files:**
- Create: `src/enclave/handlers/membership.ts`
- Add tests to `test/unit/commands.test.ts`

Port from `thekraken-reference/src/commands/membership.ts` and `thekraken-reference/src/commands/whoami.ts`.

**MCP calls:**
- `handleAddMember` -> `enclave_sync({name, add_members: [email]})`
- `handleRemoveMember` -> `enclave_sync({name, remove_members: [email]})`
- `handleListMembers` -> `enclave_info({name})`
- `handleWhoami` -> `enclave_info({name})`

**Key rules:**
- add/remove are owner-only
- Cannot remove the owner
- Invalidate authz cache after membership changes
- Resolve Slack @mention to email via `resolveEmail` callback

---

### Task 4: Mode + Prompts/Templates Handlers

**Files:**
- Create: `src/enclave/handlers/mode.ts`
- Create: `src/enclave/handlers/prompts.ts`
- Add tests to `test/unit/commands.test.ts`

Port from `thekraken-reference/src/commands/mode.ts` and `thekraken-reference/src/commands/prompts.ts`.

**MCP calls:**
- `handleSetMode` -> `enclave_sync({name, new_mode: "rwxrwx---"})`
- `handleShowPrompts` -> `wf_list({enclave})` then `wf_describe({name, enclave})` per workflow
- `handleShowPrompt` -> `wf_describe({name, enclave})`
- `handleShowTemplates` -> same pattern as prompts
- `handleShowTemplate` -> `wf_describe({name, enclave})`

**Mode presets:** private=`rwx------`, team=`rwxrwx---`, open-read=`rwxrwxr--`, open-run=`rwxrwxr-x`, shared=`rwxrwxrwx`

---

### Task 5: Channel Events

**Files:**
- Replace: `src/enclave/drift.ts` (rename to channel-events logic)
- Create: `test/unit/channel-events.test.ts`

Port from `thekraken-reference/src/channel-events.ts`.

**Events:**
- `member_joined` -> log only (no MCP call)
- `member_left` -> resolve email, check if member (not visitor/owner), call `enclave_sync({name, remove_members: [email]})`, invalidate cache
- `channel_archive` -> `enclave_sync({name, new_status: "frozen"})`
- `channel_rename` -> `enclave_sync({name, new_channel_name})`

---

### Task 6: Enclave Provisioning

**Files:**
- Replace: `src/enclave/provisioning.ts`
- Create: `test/unit/provisioning.test.ts`

Wrapper functions for `enclave_provision` and `enclave_deprovision` MCP calls.

**MCP calls:**
- `provisionEnclave({name, ownerEmail, ownerSub, platform, channelId, channelName, members, quotaPreset})` -> `enclave_provision({name, owner_email, owner_sub, platform, channel_id, channel_name, members, quota_preset})`
- `deprovisionEnclave(name)` -> `enclave_deprovision({name})`

---

### Task 7: Wire Into Slack Bot + Outbound Filter

**Files:**
- Modify: `src/slack/bot.ts` — add command detection before routing, apply jargon filter to outbound
- Modify: `src/teams/outbound-poller.ts` — apply jargon filter before posting to Slack
- Modify: `src/enclave/index.ts` — barrel exports

Wire the command parser into the Slack message handler: after auth gate, before `routeEvent`, check if the message is a command. If so, execute the command handler directly (deterministic, no LLM) and return.

Wire the jargon filter into the outbound poller: before posting any team message to Slack, run it through `filterJargon` and `filterNarration`.

---

### Task 8: Final Verification

- Run full test suite
- Type check
- Lint + format
- Verify no stale namespace references
- Tag `phase3-complete`

---

## Guardrails

1. **Commands are deterministic.** No LLM. Parse text, call MCP, format response.
2. **Owner-only operations:** add, remove, transfer, set mode, archive, delete. Always check role before executing.
3. **Jargon filter on output only.** Never filter input — the agent needs to see the real terms.
4. **No Helm chart changes.**
5. **All MCP calls use `enclave` param (not `namespace`).** Verified against v0.9.0 tool inventory.
