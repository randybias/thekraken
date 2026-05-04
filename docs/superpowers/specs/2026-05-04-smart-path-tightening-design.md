# Smart Path Tightening — Design

**Date:** 2026-05-04
**Status:** approved (brainstorming complete, awaiting spec review and implementation plan)
**Owner:** rbias
**Ships in:** v0.10.0-rc.10 lockstep
**Related:**
- Incident analysis: `~/code/tentacular-main/scratch/smart-path-redesign.md`
- Master plan: `~/.claude/plans/2026-05-04-eastus-stabilization-rc10.md` (Task #5)
- Defense-in-depth follow-up: `tentacular-mcp#115` (server-side PSA validation in `wf_apply`)

## Problem

`src/dispatcher/smart-path.ts` was conceived as the conversational
half of D4's hybrid dispatcher: deterministic for commands, smart for
ambiguous input. As built, it became something else — a fully
tool-using LLM agent with the entire MCP tool catalog exposed
(`smart-path.ts:154`: `tools: mcp?.tools ?? []`), authorized by the
user's OIDC token, with no scope enforcement beyond a system prompt.

On 2026-05-04 a single Slack DM thread exposed three compounded
failure modes:

1. **Confabulation under empty tool results.** Smart path claimed
   `ai-news-digest` was running healthy with 31 events and ~19.7
   days uptime. The workflow doesn't exist in the
   `tentacular-agensys` enclave. `wf_status` returned an empty
   resource list; smart path invented a satisfying narrative.
2. **DM mode allowed a destructive mutation.** The DM system prompt
   says "remind users that workflows live in enclave channels."
   Smart path then invoked `wf_apply` to create a brand-new
   deployment named `daily-news-digest` from a hand-rolled spec.
   The prompt is advice; the tool list is authority.
3. **Errors swallowed at MAX_TURNS.** `wf_run` returned a real
   `MCP error -32001: Request timed out` (the new pod was crash-
   looping on PSA admission). The MAX_TURNS bailout returned the
   *previous* assistant utterance as truth ("Deployed. Now
   triggering a manual run."). The user never saw the error.

The root cause is scope, not guardrails. Smart path was a parallel,
weaker version of the per-enclave team manager — full tool access,
but without the Kraken skill loaded, without per-enclave memory,
without the manager/builder/deployer separation, without confirmation
gates. Tightening it (rate-limiting, MAX_TURNS reduction, prompt
hardening) treats the symptoms.

## Decision summary

Three decisions taken during brainstorming:

| # | Question | Choice |
|---|---|---|
| 1 | When the user asks Kraken (in smart path) to do something destructive, what should happen? | **Smart path never invokes destructive tools.** Punt to the enclave manager team, which has the right context and confirmation flow. |
| 2 | What's left of smart path? | **Delete enclave mode entirely.** Keep DM mode and provision mode, both narrowly scoped. Anything in an enclave channel routes to the team manager. |
| 3 | DM-mode tool access? | **One tool: `enclave_list`** (filtered to user's memberships). Everything else unavailable. |

## Architecture

```
@mention in enclave channel    →  team manager subprocess (D2/D7)
@mention or DM, no enclave     →  smart path (DM mode or provision mode)
deterministic command          →  direct MCP call (unchanged)
```

`smart-path.ts` shrinks to a chat-only LLM with a tiny static tool
allowlist per mode. The enclave-mode code path is deleted. The
manager prompt import goes with it. The team manager subprocess
becomes the only place where conversational mutations occur, and
those flow through the existing manager → builder → deployer
separation with the Kraken skill loaded.

### Components

**`src/dispatcher/smart-path.ts`**

Modes simplify from `'enclave' | 'dm' | 'provision'` to
`'dm' | 'provision'`. Single source of truth for tool exposure:

```ts
const MODE_TOOL_ALLOWLIST: Record<SmartPathMode, ReadonlyArray<string>> = {
  dm:        ['enclave_list'],
  provision: ['enclave_provision'],
};
```

The LLM context build filters MCP's advertised tools through this
table:

```ts
const allowed = MODE_TOOL_ALLOWLIST[input.mode];
const filteredTools = (mcp?.tools ?? []).filter(t => allowed.includes(t.name));
const baseContext: Context = { systemPrompt, messages, tools: filteredTools };
```

The auto-inject-enclave logic (`toolAcceptsEnclave`) and the per-turn
token rotation are deleted with the enclave-mode branch — neither
remaining mode needs them.

**`src/dispatcher/router.ts`**

Today: in-enclave @mention with non-command text → smart path. Change:
in-enclave @mention with non-command text → team manager dispatch
(via `lifecycle.ts` spawn-or-send, the same path that already handles
build/deploy work). DMs and unbound-channel mentions continue to flow
to smart path.

If team-manager spawn fails, return an honest error to the user
("I couldn't spawn the manager team for this enclave: <reason>"). No
silent fall-back to smart path.

### Behavior per mode

**DM mode**

Tool allowlist: `[enclave_list]`. The system prompt is rewritten to
be explicit about scope:

```
# Role: The Kraken (DM mode)

You are answering a direct message from <user_email>. You DO NOT
have access to any enclave's workflows, deployments, logs, or state.
The only thing you can query is `enclave_list` — to remind the user
which enclaves they're a member of.

## What you can do
- Answer general questions about Tentacular (concepts, scaffolds, skill).
- List the user's enclaves and direct them to the right channel.
- Help the user provision a new enclave (you'll be re-prompted in
  provision mode if they're in an unbound channel).

## What you must NOT do
- Claim anything about a specific workflow, deployment, run history,
  log line, or status. You cannot see these in DM. If asked, say:
  "Ask me from inside #<enclave-name> and I'll answer with real data."
- Invent telemetry, uptimes, run counts, error rates, or workflow
  names. If you don't have a fact in front of you (from `enclave_list`
  or the user's message), it does not exist.

## Tool errors
If a tool call returns an error, report the error verbatim and stop.
Do not retry, do not invent a workaround, do not paper over.

## Style
- First person. Concise. Engineers reading.
- If you don't know, say so.
```

**Provision mode**

Tool allowlist: `[enclave_provision]`. Existing
`buildProvisioningPrompt` (`smart-path.ts:348`) is already narrow —
keep its content unchanged. The single change is the allowlist
enforcement.

**Enclave mode**

Deleted. The router never sets `mode: 'enclave'` again. The
`SmartPathInput.mode` field's TypeScript union narrows from
`'enclave' | 'dm' | 'provision'` to `'dm' | 'provision'` so the
compiler will catch any leftover references.

### Thread memory

`priorTurns` survives in DM and provision modes. The system prompt
(both modes) gains a guard against re-anchoring stale assistant
claims:

```
## Prior thread context
Earlier replies in this thread are shown to you for continuity. Do
NOT treat your own prior replies as facts. If a prior reply mentioned
specific telemetry, run history, or workflow state, that information
is no longer available — restate only if the user re-asks and
disclose you can't verify.
```

This addresses the second-order risk that was visible in the
incident: a fabricated earlier turn becoming the basis for a later
"correction" that compounds the error.

### MAX_TURNS

Stays at 8. With single-tool allowlists, neither remaining mode can
realistically run away. Revisit only if production data shows
otherwise.

## Error handling

The MAX_TURNS bailout (`smart-path.ts:285-306`) currently returns
the most recent assistant text from anywhere in the conversation —
the path that produced "Deployed. Now triggering a manual run." as
the user-facing answer when the actual `wf_run` had errored.

New bailout:

```ts
if (!finalText) {
  const lastErr = findLastToolError(messages);
  finalText = lastErr
    ? `I couldn't complete this. The last tool I tried (\`${lastErr.toolName}\`) returned: ${truncate(lastErr.content, 500)}`
    : `I ran out of steps trying to answer this and don't have a final result. Please re-ask, or @mention me in your enclave channel for a longer-running answer.`;
  log.warn({ turns: MAX_TURNS, hadToolError: Boolean(lastErr) }, 'smart-path: budget exhausted');
}
```

`findLastToolError(messages)` walks `messages` in reverse, returning
the first `toolResult` with `isError: true`. `truncate` is a tiny
helper to bound the user-facing error length.

Mid-loop tool errors continue to surface via the existing per-tool
catch block (returns `toolResult { isError: true, content: ... }`)
— unchanged. The system prompt addition above tells the LLM to
report rather than retry.

## Testing

All tests live in `thekraken/src/dispatcher/`.

**`smart-path.allowlist.test.ts`** (new) — table-driven. For each
mode, assert the resolved tool list passed to the LLM is exactly
the allowlist regardless of what MCP advertises. Mock MCP to return
the full tool catalog; assert the filter dropped everything outside
the allowlist.

**`smart-path.modes.test.ts`** (new) — TypeScript-level: confirm
`SmartPathMode = 'dm' | 'provision'` (compile-time enforcement).
Runtime: assert provision mode only fires when channel is unbound;
DM mode only fires for DM channels.

**`smart-path.bailout.test.ts`** (new) — simulate MAX_TURNS
exhaustion with and without tool errors. Assert returned text
matches the new error format, never a stale assistant claim.

**`router.test.ts`** (modify) — case for in-enclave @mention with
non-command text now expects route descriptor `{ kind: 'team' }`,
not `{ kind: 'smart' }`.

Pre-existing smart-path tests for enclave mode are deleted with the
code path.

Lint clean (`npm run lint`), formatter clean (`npm run format:check`),
type-check clean (`npx tsc --noEmit`), unit tests pass (`npm test`).

## Rollout

Single-repo change in `thekraken`. Ships in the lockstep
`v0.10.0-rc.10` cut (Phase 5 of the master plan). No data migration,
no schema change, no MCP-server change, no Helm chart change.
Existing per-enclave team subprocesses continue running across the
Kraken pod restart and respawn on next engagement. The user-visible
change is: in-enclave @mentions now consistently go through the
team manager rather than sometimes through smart path.

## Out of scope

- **Server-side PSA validation in `wf_apply`** — defense-in-depth
  filed as `tentacular-mcp#115`. Independent of this design;
  complementary.
- **Team manager grounding audit** — the manager prompt says
  "describe before claiming" via the Kraken skill, but a dedicated
  audit of the manager's own confabulation behavior is a separate
  task.
- **Slash command expansion** for common destructive ops
  (`/redeploy`, `/run`) — orthogonal UX work. If team-spawn cost
  feels high in production after this lands, that's the next move.
- **Tool allowlist promoted to MCP-schema-driven** — keep in mind,
  don't do now. The static table is the YAGNI answer until we have
  more than ~5 modes or want a different scoping unit.

## Acceptance criteria

1. `smart-path.ts` no longer references `mode === 'enclave'` or the
   manager-prompt builder. TypeScript compile fails any leftover.
2. DM mode invocation with the full MCP tool catalog advertised
   produces a `Context.tools` of length 1 (`enclave_list`).
3. Provision mode produces a `Context.tools` of length 1
   (`enclave_provision`).
4. Router test: in-enclave @mention with `tell me about ai-news-digest`
   resolves to `{ kind: 'team' }` not smart path.
5. MAX_TURNS exhaustion test with a `wf_apply` tool error in the
   transcript returns a user-facing message that includes the tool
   name and the error string, NOT a stale assistant claim.
6. End-to-end: replay the 2026-05-04 incident scenario (DM
   `tell me about ai-news-digest`) — Kraken now responds with at
   most a list of the user's enclaves and a request to ask from
   the right channel, never with fabricated workflow telemetry.
