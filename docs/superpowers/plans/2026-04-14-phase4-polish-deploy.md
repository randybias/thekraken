# Phase 4: Polish + Deploy Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Block Kit formatting, structured cards, Home Tab, and git-state deploy flow so the Kraken produces polished Slack output and can deploy tentacles via git-backed versioning.

**Architecture:** Port pure-function formatters from `thekraken-reference/`. The formatter, cards, and Home Tab have no side effects — they transform data to Block Kit JSON. Git-state deploy wraps `tntc deploy` subprocess calls.

**Port source:** `thekraken-reference/src/slack-formatter.ts`, `thekraken-reference/src/slack-cards.ts`, `thekraken-reference/src/slack-home-tab.ts`

**No MCP tools called directly.** All three Slack modules are pure functions.

---

## Tasks

### Task 1: Block Kit Formatter (515 lines, 67 tests)
Port `slack-formatter.ts` and its tests. Pure state-machine parser.

### Task 2: Structured Cards (443 lines, 62 tests)
Port `slack-cards.ts` and its tests. Four card builders + dispatcher.

### Task 3: Home Tab (173 lines, 16 tests)
Port `slack-home-tab.ts` and its tests. Enclave summary view.

### Task 4: Wire Formatter into Outbound
Apply Block Kit formatting to outbound messages in the poller.

### Task 5: Wire Home Tab into Slack Bot
Register `app_home_opened` event handler, build and publish Home Tab.

### Task 6: Git-State Deploy Flow
Implement deploy/rollback wrappers that call `tntc deploy` subprocess.

### Task 7: Final Verification
Full test suite, type check, lint, tag.
