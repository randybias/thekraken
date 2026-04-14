# Phase 4: Polish + Deploy — Design

**Change ID:** phase4-polish-deploy
**Status:** IMPLEMENTED
**Created:** 2026-04-13

---

## D1: Block Kit Formatter

`src/slack/formatter.ts` exports three pure functions:

- `formatAgentResponse(text)` — converts a Markdown string to a Slack
  `KnownBlock[]` array. Line-by-line state machine: fenced code blocks
  (language-labelled), ATX headers (h1=plain bold, h2+ bold-italic), pipe
  tables (formatted pre), bullet/numbered lists, HR dividers, and plain
  paragraphs. Max 50 blocks; overflow batched with continuation note.
- `stripMarkdownFormatting(text)` — strips `**bold**`, `_italic_`, backtick
  inline code, and `[link](url)` from a string (used in card fallback text).
- `translateToMrkdwn(text)` — converts Markdown bold/italic/code to Slack
  mrkdwn syntax.

All functions are side-effect-free. No Slack API calls.

## D2: Structured Cards

`src/slack/cards.ts` exports five functions:

- `enclaveListCard(enclaves, chromaBaseUrl?)` — enclave list with pre-formatted
  table. When 1-5 enclaves and `chromaBaseUrl` provided: per-enclave Chroma
  links. When > 5 enclaves: single "View all in Chroma" link.
- `workflowStatusCard(workflows, enclaveName, chromaBaseUrl?)` — per-workflow
  fields (name, status, ready, version, age). Summary line with ready count.
- `healthCard(summary)` — total/healthy/degraded/down fields. Optional details
  block when `summary.details` is set.
- `authCard(params)` — login URL with user code, countdown timer (ceil to
  minutes), primary button. Used for device flow prompts.
- `buildCard(type, params)` — dispatcher. Routes to the four builders or falls
  back to a raw JSON `<pre>` block for unknown types. Catches errors and
  returns a fallback error block instead of throwing.

Return type for all: `{ text: string; blocks: KnownBlock[] }`.

## D3: Home Tab

`src/slack/home-tab.ts` exports two functions:

- `buildHomeTab(enclaves)` — authenticated view. Header, enclave list with
  health indicators (`:large_green_circle:` 100%, `:large_yellow_circle:`
  50%+, `:red_circle:` < 50%, `:white_circle:` 0 tentacles), role label
  (Owner/Member), Chroma button if `chromaUrl` is set, Quick Reference
  section.
- `buildUnauthenticatedHomeTab()` — unauthenticated view. Welcome header,
  instruction to DM the bot to log in.

Both return `{ type: 'home'; blocks: KnownBlock[] }`.

Wired in `src/slack/bot.ts` via `app.event('app_home_opened', ...)`.
Authenticated users get `buildHomeTab([])` with a TODO comment to populate
from MCP `enclave_list`. Unauthenticated users get the login prompt.

## D4: Deploy Flow

`src/git-state/deploy.ts` exports:

- `validateExplanation(text)` — returns `{ valid, reason }`. Rules:
  - Length 10-80 characters
  - No infra jargon: kubernetes, k8s, namespace, pod, container, docker,
    helm, kubectl, tntc, "git sha", "git commit", dag
  - Not boilerplate: "deploy tentacle", "WIP", "update workflow", etc.
- `readVersionFromWorkflow(path)` — parses `version: <N>` from YAML, throws
  if missing.
- `deploy(params, db, mcpCall, git)` — full flow:
  1. Validate explanation
  2. `git add <tentacleRelPath>`
  3. `git commit -m "deploy(<enclave>/<tentacle>): <explanation>"`
  4. Read version from `workflow.yaml` (post-commit, hook has bumped it)
  5. `git tag <tentacle>-v<N>`
  6. `git push` + `git push --tags`
  7. `mcpCall('wf_apply', { enclave, tentacle, ... }, userToken)`
  8. Record in `deployments` SQLite table (status: success or failed)

`GitOps` interface (`{ exec(args, cwd): string }`) is injectable for testing.
`McpCallFn` type: `(tool, params, userToken?) => Promise<unknown>`.
`realGitOps` uses `execSync` with `{ encoding: 'utf8', cwd }`.

`src/git-state/deployments-db.ts` — `DeploymentDb` class wrapping the
`deployments` SQLite table. Methods: `insert()`, `updateStatus()`,
`getLatestSuccessful()`, `listForEnclave()`, `tagExists()`. Uses
`ORDER BY id DESC` (not `created_at`) to handle same-millisecond inserts.

## D5: Rollback Flow

`src/git-state/rollback.ts` exports `rollback(params, db, mcpCall, git)`:

1. `git rev-list -n 1 <targetTag>` — if empty or throws, return
   `{ ok: false, message: "Tag <tag> does not exist" }`
2. `git checkout <targetTag> -- <tentacleRelPath>` — restore directory tree
3. `git add <tentacleRelPath>`
4. `git commit -m "rollback(<enclave>/<tentacle>): to <targetTag>"`
5. Read new version from `workflow.yaml` (hook bumped it in step 4)
6. `git tag <tentacle>-v<newVersion>`
7. `git push` + `git push --tags`
8. `mcpCall('wf_apply', { enclave, tentacle, ... }, userToken)`
9. Record in `deployments` table with `deploy_type: 'rollback'`

Shares `GitOps`, `McpCallFn`, `WfApplyResult`, and `realGitOps` from
`deploy.ts`.

## D6: Drift Detection Wiring

`src/index.ts` — previously `DriftDetector` was imported but never started.

Changes:
- `mcpCall` updated to accept optional `userToken?: string` and inject
  `Authorization: Bearer <token>` header when provided.
- `DriftDetector` created and started with real adapters:
  - `resolveEmail(userId)` → `slackBot.app.client.users.info({ user: userId })`
  - `listChannelMembers(channelId)` → `slackBot.app.client.conversations.members()`
- `driftDetector.stop()` called in shutdown handler.

The drift detector uses the service MCP URL from config (no user token). This
is the single explicit D6 exception: background drift check has no user context.

## D7: Codex Fixes

### D7(a) Per-Request User-Bound mcpCall

`src/slack/bot.ts` — `userBoundMcpCall` and `userBoundMcpCallConfirm` wrappers
close over the current user's OIDC token and pass it through to `mcpCall`.
Previously the dispatcher used a shared service call for all commands.

### D7(b) Mention Gate Before Command Parse

`src/dispatcher/router.ts` — in bound-channel message handling:

```typescript
const isCommandEligible =
  event.type === 'app_mention' ||
  (event.type === 'message' && !!event.threadTs);
if (isCommandEligible) {
  const command = parseCommand(event.text);
  if (command) return { path: 'deterministic', action: command };
}
```

Top-level `message` events (no bot mention) skip command parsing entirely.
They still pass the mention gate if they contain any `<@...>` mention, but
route to `spawn_and_forward` (forward to team) rather than triggering a
destructive command.

### D7(c) Trailing Text Rejection

`src/dispatcher/router.ts` — `extractMentions()` updated to return `null`
when the token stream contains non-mention, non-filler text after the last
mention. Previously it returned partial results.

Transfer regex anchored at end:
```typescript
/^transfer\s+(?:to\s+)?<@([A-Z0-9]+)>\s*$/i
```

Archive and delete commands already used anchored regexes; no change needed.

## Key TypeScript Constraint

All files compiled with `noUncheckedIndexedAccess: true`. Array element access
requires `!` non-null assertions or index-bounds checks. Examples:
`const line = lines[i]!`, `const wf = workflows[i]!`, `match[1]!`.

## SQLite NULL Handling

better-sqlite3 returns `undefined` (not `null`) for NULL columns. Tests use
`expect(row.field == null).toBe(true)` to handle both.
