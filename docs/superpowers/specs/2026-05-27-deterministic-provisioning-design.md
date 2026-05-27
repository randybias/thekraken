# Deterministic Provisioning + Thread Participation — Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:writing-plans` next to create the implementation plan. After approval, use `superpowers:subagent-driven-development` to execute.

**Goal:** Replace the broken LLM-driven enclave provisioning flow with a deterministic command. Add thread-participation tracking so non-@-mention thread replies reach the Kraken when (and only when) the thread was started by an @-mention of the bot.

**Status:** approved 2026-05-27 by rbias. Targets v0.10.1 lockstep release.

**Architecture:** Pull `provision` out of `smart-path.ts` (LLM agent loop) into `commands.ts` (deterministic regex command). Smart-path keeps DM + ambiguous-query duties — L group E2E and DM functionality remain unchanged. Add SQLite-backed `kraken_threads` table tracking threads where the bot was @-mentioned at the top level; the message handler at `bot.ts:694` forwards non-@-mention replies only when the thread is tracked.

**Tech stack:** TypeScript + better-sqlite3 + Slack Bolt (existing). No new dependencies.

---

## Why this is needed

The 2026-05-26 production transcript on eastus showed three regressions in the same provisioning attempt:

1. **Thread replies dropped.** `bot.ts:694` filters non-DM messages to only those in *bound* channels with `isBoundChannel && isThreadReply`. During provisioning the channel isn't bound yet — every thread reply without an explicit `@The Kraken` mention is silently dropped.
2. **Bot asks for a name despite directive that channel name be the default.** `buildProvisioningPrompt` instructs the LLM to ask "what should the enclave be called" with a channel-name suggestion. User directive (verbatim): *"The default is supposed to be the same as the channel name. That's ALSO a regression."*
3. **Smart-path is stateless across turns.** Each @-mention triggers a fresh `runSmartPath` call. Prior thread context is supposed to give continuity but the LLM ignores it — same provisioning attempt produced three identical "this channel isn't set up as an enclave yet" replies to consecutive @-mentions in the same thread.

E2E missed these because the existing scenarios pack the whole intent into the first message (`@Kraken provision this channel as an enclave named e2e-test`), never testing the multi-turn conversational path.

User's directive: *"The whole so-called 'smart path' has seemed pretty fucked the entire time."* The fix is to stop using an LLM for provisioning entirely.

---

## Components

### Component 1: Deterministic `provision` command

**Files:**
- Modify: `src/enclave/commands.ts` — extend `parseCommand` regex to accept `provision`
- Modify or extend: `src/enclave/handlers/provisioning.ts` (create if not present) — `handleProvision(args, ctx)`

**Grammar (parsed by `parseCommand`):**
```
^provision(?:\s+(?:as\s+(\S+))?(?:\s+description\s+(.+))?)?$
```

Examples that match:
- `provision` — both defaults
- `provision as my-enclave` — override name only
- `provision description Test enclave` — override description only
- `provision as my-enclave description Test enclave` — override both

Examples that do NOT match (fall through to non-command paths):
- `provision this channel as foo` — no `as` keyword by itself
- `please provision` — leading filler

Note: the grammar is strict on purpose. The dispatcher's existing top-level pattern `PROVISION_PATTERN` (regex in `bot.ts`) can stay loose for *detecting* provision intent in unbound channels, but the deterministic command requires the precise grammar above.

**Defaults (when args omitted):**
- `name` = the Slack `conversations.info(channelId).name` value, validated against `^[a-z0-9-]{1,63}$`. If the channel name doesn't validate, REJECT with a clear message — DO NOT silently kebab-case. The user must use `as <name>` to override.
- `description` = `conversations.info(channelId).topic.value` when non-empty; else `Workflow channel for #<channelName>`.

**Execution flow inside `handleProvision`:**
1. Resolve `channelName` via `conversations.info(channelId)` (Slack API; already used elsewhere in `bot.ts`).
2. Compute `name` and `description` per the rules above. If name validation fails, send error reply and abort.
3. Check if a binding already exists for this channel via `bindings.lookupEnclave(channelId)`. If yes, send "This channel is already enclave `<name>`. Use `@kraken status` to see what's there." and abort.
4. Call MCP `enclave_provision` with `{ name, description, owner_email: ctx.userEmail, owner_sub: ctx.userSub, platform: "slack", channel_id: channelId, channel_name: channelName }`.
5. On success: insert binding via `bindings.insertBinding(channelId, name, ctx.senderSlackId)`. Insert kraken_threads row for the provision's own thread so any user follow-ups stay in-band. Reply with `Done. Enclave \`<name>\` is live. Anyone in this channel can now @kraken to interact.`
6. On MCP failure: echo the error message verbatim.

**parseCommand integration:** add `provision` to the alternation in the existing regex. The command requires NO `<@USER>` mention (unlike `add`/`remove`); the existing post-match `if (command === 'add' || command === 'remove')` guard does NOT extend to `provision`.

### Component 2: Thread-participation tracking

**Files:**
- Modify: `src/db/schema.ts` — add `kraken_threads` table to the SCHEMA bump
- Create: `src/db/kraken-threads.ts` — `recordKrakenThread`, `isKrakenThread`, `pruneOldKrakenThreads` helpers
- Modify: `src/slack/bot.ts` — populate the table on top-level `app_mention`; consult it in the `message` handler

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS kraken_threads (
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);
CREATE INDEX IF NOT EXISTS idx_kraken_threads_created_at ON kraken_threads(created_at);
```

This is **SCHEMA_VN+1** — bump the version constant in `src/db/schema.ts` so existing pods migrate cleanly.

**Population rule (in `app_mention` handler, near `bot.ts` line 297-510):**
```typescript
const isTopLevelMention =
  !threadTs ||                     // truly top-level
  threadTs === (event as { ts: string }).ts;  // @mention started the thread
if (isTopLevelMention) {
  recordKrakenThread(channelId, (event as { ts: string }).ts);
}
```

The recorded `thread_ts` is the parent message's `ts`, which is what Slack will set on every reply's `event.thread_ts`.

**Consumption rule (in `message` handler at `bot.ts:694`, replacing the existing gate):**
```typescript
// Forward to dispatcher if:
//   - This is a DM (channelType === 'im'), OR
//   - This is a reply in a thread the Kraken is participating in
//     (the top-level message of that thread was an @-mention of the bot)
const isThreadReply = !!threadTs && threadTs !== (event as { ts: string }).ts;
const isOwnedThread =
  isThreadReply && isKrakenThread(channelId, threadTs);
if (channelType !== 'im' && !isOwnedThread) return;
```

This eliminates the `isBoundChannel` gate entirely. Bound-channel app_mentions still come through the `app_mention` handler (which already routes them to the enclave team). Bound-channel thread replies route through this new `isKrakenThread` check — works because the @-mention that opened the thread populated the table.

**Pruning:** out of scope for this design. Add `pruneOldKrakenThreads(maxAgeSeconds = 7*24*3600)` helper and call it once at boot from `src/index.ts`. Future work: schedule it daily.

### Component 3: Remove `provision` mode from smart-path; run parseCommand for unbound channels too

**Files:**
- Modify: `src/dispatcher/smart-path.ts` — remove `mode: 'provision'` branch from `buildProvisioningPrompt` (delete the function or rename it `buildDmSystemPrompt`-only), `MODE_TOOL_ALLOWLIST`, and the `'provision'` member of the `SmartPathMode` type. Rename runtime doc/comments to drop provision references.
- Modify: `src/dispatcher/router.ts` — remove the `provision` `SmartReason` variant. `routeEvent` for an unbound channel returns `ignore_unbound` for any non-provision message; for provision-pattern messages it returns a new deterministic action `provision_command` (or just lets `app_mention` handle parsing directly).
- Modify: `src/slack/bot.ts` — restructure the unbound-channel branch of the `app_mention` handler (currently lines ~322-398, the block guarded by `if (!binding)`):
  1. **First**, run `parseCommand(text)`. If it returns a command and that command is `provision`, immediately dispatch to `handleProvision(args, ctx)`. NO binding lookup needed — provision creates the binding.
  2. **Otherwise**, if the message contains `PROVISION_PATTERN` (loose detection — provision-ish wording without the strict command grammar), reply with a usage hint: `To provision this channel as an enclave, say \`@The Kraken provision\` (uses channel name #<channelName>) or \`@The Kraken provision as my-enclave\` to choose a different name.`
  3. **Otherwise**, reply with the existing terse non-enclave message: `This channel isn't set up as an enclave yet. To get started, say \`@Kraken provision\`.`
  4. Delete the `if (deps.onSmartPath) { ... mode: 'provision' ... }` block entirely. The lazy-reconstitute call (`lookupEnclaveWithReconstitute`) stays — it's still useful when MCP has a binding the local cache doesn't.

The `parseCommand` invocation for ADDED commands (`provision`) thus happens in BOTH branches of the binding check. The existing bound-channel parseCommand at bot.ts:421 stays untouched (it never sees `provision` because bound channels don't need provisioning).

**Smart-path post-change responsibilities:** DMs only (`mode: 'dm'`). Status checks and help requests already route through smart-path with non-provision reasons — those are unchanged.

### Component 4: Kraken skill + system prompt updates

**Files:**
- Modify: `skills/kraken/SKILL.md` — remove `enclave_provision` from Path 1 manager tools. Add: "Provisioning is a dispatcher-level command, not a manager responsibility. The manager runs inside a channel that is already a bound enclave."
- Modify: `skills/kraken/references/thread-model.md` — document the new thread-participation rule
- Modify: `skills/kraken/references/slack-ux.md` — add `@kraken provision` command syntax (defaults + overrides)
- Modify: `src/agent/system-prompt.ts` — remove `enclave_provision` from the manager's "Path 1: direct MCP calls" list in `buildManagerPrompt`

### Component 5: E2E scenarios

**Files:**
- Modify: `test/e2e-slack/scenarios.ts` — adjust E2 to use new command syntax; add E6-E9
- Modify: `test/e2e-platform/scenarios.ts` — adjust PLAT-LIFECYCLE-1 step 0 message to the new command syntax

**New scenarios:**

| ID | Group | Channel | Message | Asserts |
|----|-------|---------|---------|---------|
| **E2** (revised) | E | test channel (unbound) | `@Kraken provision as e2e-test` | enclave created, binding active, "Done. Enclave `e2e-test`" in reply |
| **E6** | E | test channel (unbound) | `@Kraken provision` | enclave created with channel name as enclave name |
| **E7** | E | test channel (unbound) | `@Kraken provision as e2e-foo description Test enclave from E7` | enclave created with name=e2e-foo and description set |
| **E8** | E | bound enclave channel | thread: `@Kraken status` then `quick follow-up?` (no @mention) | both messages reach the bot; second message gets a reply |
| **E9** | E | bound enclave channel | top-level NON-@mention then in-thread `random chatter` (no @mention) | neither message reaches the bot; no replies |

E6 and E2 must run on distinct channels (or E2 cleanup must run first) since both try to provision; E5 cleanup remains as-is. E7 cleans up by deprovisioning the e2e-foo enclave at the end of its scenario or in a shared cleanup phase.

E8 + E9 are the regression tests for the thread-participation rule itself; they don't need a fresh cluster.

---

## Data flow

```
@kraken provision in unbound channel
  → bot.ts app_mention handler
  → recordKrakenThread(channelId, thread_ts)   ← any @mention starts an owned thread
  → checkAuthOrPrompt (device flow if needed)
  → parseCommand → matches "provision"
  → handleProvision(args, ctx)
    → client.conversations.info(channelId)     → channelName, topic
    → compute name (default = channelName) + description (default = topic | "Workflow channel for #X")
    → validate name against ^[a-z0-9-]{1,63}$, reject if bad
    → lookupEnclave(channelId), reject if already bound
    → mcpCall("enclave_provision", { name, description, owner_email, owner_sub, platform, channel_id, channel_name })
    → on success: insertBinding(channelId, name, ctx.senderSlackId)
    → reply: "Done. Enclave `<name>` is live..."
```

Thread participation flow:
```
@kraken status in bound channel (top-level)
  → bot.ts app_mention
  → recordKrakenThread(channelId, ts)          ← THIS thread is owned
  → routeEvent → forward_to_active_team
  → enclave team replies in same thread
…then…
user types "quick follow-up?" in same thread (NO @mention)
  → Slack delivers message event (not app_mention)
  → bot.ts message handler
  → isKrakenThread(channelId, threadTs) → true
  → routeEvent → forward_to_active_team
  → enclave team replies
```

---

## Error handling

| Failure | Response |
|---------|----------|
| Channel name fails `^[a-z0-9-]{1,63}$` validation | `\`<name>\` isn't a valid enclave name. Use \`@kraken provision as my-enclave\` to specify one.` |
| `@kraken provision` in already-bound channel | `This channel is already enclave \`<name>\`. Use \`@kraken status\` to see what's there.` |
| MCP `enclave_provision` returns 4xx/5xx | Echo the error message verbatim, with `Provisioning failed: <err>` prefix |
| User not authenticated when issuing the command | Existing `checkAuthOrPrompt` device-flow prompt fires; on success, the command is retried (or user re-issues). |
| `conversations.info` fails | Reply: `Couldn't read this channel's info from Slack. Try again or use \`@kraken provision as <name>\` to specify the enclave name explicitly.` |

---

## Testing

### Unit tests
- **`test/unit/enclave/commands.test.ts`** — parseCommand cases for the four grammars above; rejection of bad names; default behavior when args omitted
- **`test/unit/db/kraken-threads.test.ts`** — schema migration, insert, lookup, prune
- **`test/unit/dispatcher-router.test.ts`** — update routing matrix table: `provision` SmartReason is gone; unbound-channel + provision-message returns `ignore_unbound` (the actual provision-command parse happens in `app_mention` post-routing)
- **`test/unit/slack-bot.test.ts`** — message handler gate now consults `isKrakenThread`, NOT `isBoundChannel`. Top-level app_mention records a thread; subsequent non-@-mention thread reply is forwarded; non-thread non-mention is dropped

### E2E tests (E6-E9 detailed above)
- E2 (revised): provision via new command syntax
- E6: provision with no args (channel-name default)
- E7: provision with both overrides
- E8: thread participation positive case
- E9: thread participation negative case (random thread chatter ignored)

### Manual smoke test (after deploy to nats-weu)
1. In a NEW unbound channel: `@Kraken provision`. Confirm: enclave appears in Chroma at expected URL with channel-name as enclave name.
2. In the SAME thread the bot replied in, say `thanks!` (no @mention). Confirm: the bot receives and either acknowledges or stays silent depending on enclave manager's discretion (not the dispatcher's; we just verified the message reached the dispatcher).
3. Start a new thread in a bound channel WITHOUT mentioning the bot. Confirm: the bot does not interject.

---

## Compatibility

- **Existing bound channels:** zero behavioral change for the enclave manager team (Path 1 just loses `enclave_provision`, which the manager never executes anyway since it's already inside a bound channel).
- **DMs and L group:** smart-path's `dm` mode untouched. L1-L4 still pass.
- **M group:** smart-path's git-state vocabulary lockdown is in the manager prompt, not smart-path's provision branch. Untouched.
- **F group:** unaffected — operates inside bound channels via the manager team.
- **AGENSYS production tentacles:** zero impact. They're inside an already-bound channel.

---

## Risk

- **MCP `enclave_provision` failure modes:** if MCP returns ambiguous errors (e.g. RBAC), the user sees the raw text. Acceptable — better than the LLM hallucinating an interpretation.
- **kraken_threads table growth:** unbounded until pruning is implemented. At observed rates (a few @-mentions per day per user), 7 days × ~50 active channels × ~5 threads each ≈ 1750 rows. Trivial.
- **Slack `conversations.info` rate limits:** Slack allows ~100 req/min for tier-3. Provisioning is rare. No risk.
- **Existing `PROVISION_PATTERN` regex in `bot.ts`:** it's used to *detect* provision intent in unbound channels (currently routes to smart-path provision mode). After this change, that regex becomes a hint for the usage message. If you @-mention provision-like wording without matching the deterministic command grammar, the bot replies with a usage hint instead of attempting a half-broken LLM provisioning flow.

---

## Out of scope

- Daily pruning cron for `kraken_threads` (helper exists; scheduler wiring is followup)
- Replacing smart-path's DM behavior (separate concern)
- Replacing smart-path's status-check/help-request mode (separate concern)
- The Pre-flight Keycloak validator design we discussed earlier (separate spec)

---

## References

- Production transcript (Slack, 2026-05-26, eastus): `Voyager Agentic Flows` channel — three failed provisioning attempts
- `src/dispatcher/router.ts` — current routing matrix
- `src/dispatcher/smart-path.ts` — current LLM-driven provision branch
- `src/slack/bot.ts:694` — the `isBoundChannel && isThreadReply` gate to be replaced
- `src/enclave/commands.ts` — existing deterministic command parser pattern to mirror
- AGENTS.md → Deployment Verification Checklist — v0.10.1 lockstep release process
