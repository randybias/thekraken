# Smart Path Tightening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock smart path down to read-only conversational reasoning so it cannot fabricate workflow telemetry or invoke destructive MCP tools, per `docs/superpowers/specs/2026-05-04-smart-path-tightening-design.md`.

**Architecture:** Static per-mode tool allowlist applied to MCP-advertised tool list before the LLM sees it. Delete dead `enclave` mode from `smart-path.ts` and narrow `SmartContext.mode` in `router.ts`. Replace the deceptive MAX_TURNS bailout that returns stale assistant text with one that surfaces the last tool error or honest exhaustion message.

**Tech Stack:** TypeScript, vitest, pi-mono (`@mariozechner/pi-ai` Context/Message), MCP via `mcp-connection.ts`, Slack Bolt (downstream).

---

## Cross-cutting rules

- **Branch:** `feat/smart-path-tightening` (already created on origin; spec doc landed there).
- **Test runner:** `vitest run` (full) or `vitest run test/unit/<file>` (one file).
- **Pre-push:** `npm test && npx tsc --noEmit && npm run lint && npm run format:check`.
- **Commits:** Conventional Commits, `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` trailer.
- **Stage explicitly.** Never `git add -A` / `git add .`.
- **TDD.** Test → fail → implement → pass → commit, per task. Don't batch.
- **Don't create new directories.** Tests live in `test/unit/`. The single new test file goes there.

## File structure (locked decisions)

| Path | Change | Responsibility |
|---|---|---|
| `src/dispatcher/smart-path.ts` | modify | Delete enclave-mode branch, add allowlist filter, replace bailout, update DM prompt, update provision prompt's prior-turns guard, add `findLastToolError` helper. |
| `src/dispatcher/router.ts` | modify (type-only) | Narrow `SmartContext.mode` to `'dm'`; collapse unreachable ternary. |
| `test/unit/smart-path-allowlist.test.ts` | create | Mode → tool list filtering. |
| `test/unit/smart-path-bailout.test.ts` | create | MAX_TURNS bailout error surfacing. |
| `test/unit/dispatcher-router-basic.test.ts` | (no change expected) | Existing tests already cover team-path routing. |

No `internal-ops.ts` change needed (its tools are not exposed via smart path — they're internal dispatcher ops). No `index.ts` change beyond what falls out of mode-type narrowing (the `mode: ctx.mode` passthrough still compiles).

---

## Task 1: Tighten `SmartPathInput.mode` type and delete dead enclave branch

**Files:**
- Modify: `src/dispatcher/smart-path.ts:46-82` (interface), `:101-116` (system-prompt selection), `:111` (`buildManagerPrompt` import), `:234-244` (auto-inject-enclave logic).

- [ ] **Step 1: Read the current `SmartPathInput` and the system-prompt selection block to confirm the lines above**

```bash
sed -n '46,82p' src/dispatcher/smart-path.ts
sed -n '101,116p' src/dispatcher/smart-path.ts
```

- [ ] **Step 2: Narrow `SmartPathInput.mode`**

In `src/dispatcher/smart-path.ts`, change:
```ts
  /** Dispatch mode: 'enclave' (default), 'dm', or 'provision'. */
  mode?: 'enclave' | 'dm' | 'provision';
```
to:
```ts
  /** Dispatch mode: 'dm' (DM with no enclave) or 'provision' (unbound channel). */
  mode: 'dm' | 'provision';
```

Note the field becomes **required** — the previous `'enclave' (default)` semantic is gone.

- [ ] **Step 3: Add `SmartPathMode` exported type for tests + downstream use**

Above the interface, add:
```ts
export type SmartPathMode = 'dm' | 'provision';
```

Then change the interface field to:
```ts
  /** Dispatch mode: 'dm' (DM with no enclave) or 'provision' (unbound channel). */
  mode: SmartPathMode;
```

- [ ] **Step 4: Replace the system-prompt selection block**

Locate (around line 101):
```ts
  const systemPrompt =
    input.mode === 'provision'
      ? buildProvisioningPrompt(
          userEmail,
          userSub,
          input.channelId ?? '',
          input.channelName ?? 'unknown-channel',
        )
      : input.enclaveName
        ? buildManagerPrompt({
            enclaveName: input.enclaveName,
            userSlackId: input.userSlackId,
            userEmail,
          })
        : buildDmSystemPrompt(userEmail);
```

Replace with:
```ts
  const systemPrompt =
    input.mode === 'provision'
      ? buildProvisioningPrompt(
          userEmail,
          userSub,
          input.channelId ?? '',
          input.channelName ?? 'unknown-channel',
        )
      : buildDmSystemPrompt(userEmail);
```

- [ ] **Step 5: Remove the `buildManagerPrompt` import**

At the top of the file (around line 26):
```ts
import { buildManagerPrompt } from '../agent/system-prompt.js';
```
Delete the line. (No other code in this file references `buildManagerPrompt` after Step 4.)

- [ ] **Step 6: Delete the auto-inject-enclave logic**

Locate (around line 234):
```ts
        // Auto-inject enclave when the tool's input schema accepts it.
        const args: Record<string, unknown> = {
          ...(toolCall.arguments as Record<string, unknown>),
        };
        if (
          input.enclaveName &&
          toolAcceptsEnclave(tool) &&
          args['enclave'] === undefined
        ) {
          args['enclave'] = input.enclaveName;
        }
```

Replace with:
```ts
        const args: Record<string, unknown> = {
          ...(toolCall.arguments as Record<string, unknown>),
        };
```

Then delete the `toolAcceptsEnclave` helper at the bottom of the file (around line 326):
```ts
function toolAcceptsEnclave(tool: { parameters: unknown }): boolean {
  const schema = tool.parameters as
    | { properties?: Record<string, unknown> }
    | undefined;
  return Boolean(schema?.properties && 'enclave' in schema.properties);
}
```

The `enclaveName` field on `SmartPathInput` stays for now — it's still useful for logging context, even though tools can't be auto-injected anymore. (We don't aggressively prune it because deleting it would touch `index.ts` and tests. YAGNI.)

- [ ] **Step 7: Run TypeScript compiler to confirm narrowing surfaces remaining issues**

```bash
npx tsc --noEmit
```

Expected: errors will surface in `router.ts` (the unreachable `'enclave'` ternary branch creates a type mismatch) and possibly `index.ts` if `ctx.mode` is typed widely. Note them — fixed in Tasks 2 and 3.

- [ ] **Step 8: Commit**

```bash
git add src/dispatcher/smart-path.ts
git commit -m "refactor(smart-path): delete dead enclave mode and narrow mode type

The router stopped sending mode: 'enclave' a while ago (router.ts:211
A4 comment: ALL enclave-bound traffic routes to the team subprocess).
Delete the dead branch, narrow SmartPathMode to 'dm' | 'provision',
remove the buildManagerPrompt import and the now-unused
toolAcceptsEnclave / auto-inject-enclave logic.

Spec: docs/superpowers/specs/2026-05-04-smart-path-tightening-design.md

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Narrow router `SmartContext.mode` and collapse unreachable ternary

**Files:**
- Modify: `src/dispatcher/router.ts:48-57` (SmartContext type), `:232-244` (return statement).

- [ ] **Step 1: Narrow `SmartContext.mode`**

In `src/dispatcher/router.ts`, change:
```ts
export interface SmartContext {
  eventType: string;
  channelId: string;
  threadTs: string;
  userId: string;
  text: string;
  enclaveName: string | null;
  mode: 'enclave' | 'dm';
}
```

To:
```ts
import type { SmartPathMode } from './smart-path.js';

export interface SmartContext {
  eventType: string;
  channelId: string;
  threadTs: string;
  userId: string;
  text: string;
  enclaveName: string | null;
  mode: Extract<SmartPathMode, 'dm'>;
}
```

The `Extract<SmartPathMode, 'dm'>` makes the type relationship explicit: the router only ever produces DM mode; provision mode is set elsewhere (`bot.ts:368`).

- [ ] **Step 2: Collapse the unreachable ternary**

Around line 242:
```ts
      mode: event.channelType === 'im' ? 'dm' : 'enclave',
```

Replace with:
```ts
      mode: 'dm',
```

(Since this code is only reached when `channelType === 'im'` — the only way to hit `path: 'smart'` per the criteria above.)

- [ ] **Step 3: TypeScript compile clean**

```bash
npx tsc --noEmit
```

Expected: clean for router.ts and smart-path.ts. If `index.ts` errors, see Task 3.

- [ ] **Step 4: Run existing routing tests to confirm no regression**

```bash
npx vitest run test/unit/dispatcher-router-basic.test.ts test/unit/router-classifier.test.ts
```

Expected: PASS. The narrowing is type-only; runtime behavior identical.

- [ ] **Step 5: Commit**

```bash
git add src/dispatcher/router.ts
git commit -m "refactor(router): narrow SmartContext.mode to 'dm' only

The 'enclave' branch in the channelType ternary is unreachable
(router never produces path: 'smart' for non-DM channels — they're
either ignore_unbound or forwarded to the team). Tighten the type
to match the runtime invariant.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Fix any `index.ts` type fallout from narrowing

**Files:**
- Possibly modify: `src/index.ts:123-141`.

- [ ] **Step 1: Compile to see remaining errors**

```bash
npx tsc --noEmit
```

If clean, **skip to Step 4** (no commit needed).

- [ ] **Step 2: If `index.ts` errors on `mode: ctx.mode` passthrough**

Inspect the surrounding code. The fix is likely to type `ctx.mode` as `'dm' | 'provision'` rather than the wider union. Update the local interface (or wherever `ctx` is typed) so its `mode` field is `SmartPathMode`.

Read the relevant block:
```bash
sed -n '90,145p' src/index.ts
```

Apply the minimum-scope edit: import `SmartPathMode`, retype the field. Do not refactor unrelated code.

- [ ] **Step 3: Compile clean**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit if changes were made**

```bash
git add src/index.ts
git commit -m "refactor(index): align ctx.mode type with narrowed SmartPathMode

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

If no changes, no commit.

---

## Task 4: Add per-mode tool allowlist

**Files:**
- Modify: `src/dispatcher/smart-path.ts:151-155` (Context build).
- Create: `test/unit/smart-path-allowlist.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/smart-path-allowlist.test.ts`:
```ts
/**
 * Smart-path tool allowlist enforcement.
 *
 * The 2026-05-04 incident exposed that smart-path exposes the entire
 * MCP tool catalog to the LLM. This file proves the allowlist is the
 * single source of truth for what the LLM can call, regardless of
 * what MCP advertises.
 */
import { describe, it, expect } from 'vitest';
import {
  MODE_TOOL_ALLOWLIST,
  filterToolsForMode,
  type SmartPathMode,
} from '../../src/dispatcher/smart-path.js';

interface FakeTool {
  name: string;
}

const ALL_TOOLS: FakeTool[] = [
  { name: 'enclave_list' },
  { name: 'enclave_info' },
  { name: 'enclave_provision' },
  { name: 'enclave_deprovision' },
  { name: 'wf_list' },
  { name: 'wf_apply' },
  { name: 'wf_run' },
  { name: 'wf_describe' },
  { name: 'wf_status' },
];

describe('MODE_TOOL_ALLOWLIST', () => {
  it('exposes only enclave_list in dm mode', () => {
    expect(MODE_TOOL_ALLOWLIST.dm).toEqual(['enclave_list']);
  });

  it('exposes only enclave_provision in provision mode', () => {
    expect(MODE_TOOL_ALLOWLIST.provision).toEqual(['enclave_provision']);
  });
});

describe('filterToolsForMode', () => {
  for (const mode of ['dm', 'provision'] as SmartPathMode[]) {
    it(`drops every tool not in MODE_TOOL_ALLOWLIST.${mode}`, () => {
      const filtered = filterToolsForMode(ALL_TOOLS, mode);
      const allowed = MODE_TOOL_ALLOWLIST[mode];
      expect(filtered.map((t) => t.name)).toEqual(allowed as string[]);
    });
  }

  it('returns empty list when MCP advertises nothing', () => {
    expect(filterToolsForMode([], 'dm')).toEqual([]);
  });

  it('returns empty list when MCP advertises only disallowed tools', () => {
    const onlyDisallowed: FakeTool[] = [
      { name: 'wf_apply' },
      { name: 'enclave_deprovision' },
    ];
    expect(filterToolsForMode(onlyDisallowed, 'dm')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to confirm fail**

```bash
npx vitest run test/unit/smart-path-allowlist.test.ts
```

Expected: FAIL — `MODE_TOOL_ALLOWLIST` and `filterToolsForMode` not exported from `smart-path.ts`.

- [ ] **Step 3: Implement the allowlist + filter helper**

In `src/dispatcher/smart-path.ts`, near the top of the file (just below the imports and the `log` declaration around line 33), add:
```ts
/**
 * Static per-mode allowlist of MCP tool names exposed to the LLM.
 *
 * The 2026-05-04 incident showed that exposing the entire MCP tool
 * catalog to a chat-only LLM lets it confabulate plus mutate cluster
 * state without the user's explicit consent. The allowlist is the
 * single source of truth for what the LLM can call. Mutations live
 * on the team-manager path (D2/D7) — never here.
 *
 * Spec: docs/superpowers/specs/2026-05-04-smart-path-tightening-design.md
 */
export const MODE_TOOL_ALLOWLIST: Record<SmartPathMode, ReadonlyArray<string>> =
  {
    dm: ['enclave_list'],
    provision: ['enclave_provision'],
  };

/**
 * Filter an MCP-advertised tool list down to the per-mode allowlist.
 * Pure function — no side effects, easy to test.
 */
export function filterToolsForMode<T extends { name: string }>(
  tools: ReadonlyArray<T>,
  mode: SmartPathMode,
): T[] {
  const allowed = MODE_TOOL_ALLOWLIST[mode];
  return tools.filter((t) => allowed.includes(t.name));
}
```

- [ ] **Step 4: Wire the filter into `runSmartPath`**

Find the Context build (around line 151):
```ts
  const baseContext: Context = {
    systemPrompt,
    messages,
    tools: mcp?.tools ?? [],
  };
```

Replace with:
```ts
  const baseContext: Context = {
    systemPrompt,
    messages,
    tools: filterToolsForMode(mcp?.tools ?? [], input.mode),
  };
```

Also update the in-loop refresh path (around line 204) so a refreshed MCP connection's tools also get filtered. Find:
```ts
            mcp = await createMcpConnection(input.mcpUrl, fresh);
            baseContext.tools = mcp.tools;
```

Replace with:
```ts
            mcp = await createMcpConnection(input.mcpUrl, fresh);
            baseContext.tools = filterToolsForMode(mcp.tools, input.mode);
```

- [ ] **Step 5: Run the allowlist test to confirm pass**

```bash
npx vitest run test/unit/smart-path-allowlist.test.ts
```

Expected: PASS (all 5 cases).

- [ ] **Step 6: Run the full smart-path-adjacent suite to confirm no regression**

```bash
npx vitest run test/unit/dispatcher-router-basic.test.ts test/unit/router-classifier.test.ts test/unit/mode-prompts.test.ts test/unit/dispatcher-tools.test.ts test/unit/provisioning.test.ts
```

Expected: PASS for all.

- [ ] **Step 7: Commit**

```bash
git add src/dispatcher/smart-path.ts test/unit/smart-path-allowlist.test.ts
git commit -m "feat(smart-path): per-mode tool allowlist enforcement

Static MODE_TOOL_ALLOWLIST gates which MCP tools the LLM sees:
  dm:        [enclave_list]
  provision: [enclave_provision]

Enforced in code, not in prompt. Filter applies at Context build
time and on every MCP-connection refresh, so token rotation cannot
re-broaden the tool surface.

Closes the floor of the 2026-05-04 incident — DM-mode smart path
can no longer call wf_apply, wf_run, enclave_deprovision, etc.
regardless of what the user asks.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Replace deceptive MAX_TURNS bailout

**Files:**
- Modify: `src/dispatcher/smart-path.ts:281-309` (the salvage block).
- Create: `test/unit/smart-path-bailout.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/smart-path-bailout.test.ts`:
```ts
/**
 * Smart-path MAX_TURNS bailout error surfacing.
 *
 * The 2026-05-04 incident: smart-path hit MAX_TURNS after wf_run
 * timed out, then returned the *previous* assistant utterance
 * ("Deployed. Now triggering a manual run.") as the user-facing
 * answer. The bailout must surface the actual tool error instead.
 */
import { describe, it, expect } from 'vitest';
import { findLastToolError } from '../../src/dispatcher/smart-path.js';

interface AssistantMsg {
  role: 'assistant';
  content: Array<{ type: string; text?: string }>;
}
interface ToolResultMsg {
  role: 'toolResult';
  toolName: string;
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

type Msg = AssistantMsg | ToolResultMsg;

describe('findLastToolError', () => {
  it('returns null when no tool errors are present', () => {
    const messages: Msg[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'toolResult',
        toolName: 'wf_list',
        content: [{ type: 'text', text: '{"workflows":[]}' }],
        isError: false,
      },
    ];
    expect(findLastToolError(messages)).toBeNull();
  });

  it('returns the most recent tool error in the message list', () => {
    const messages: Msg[] = [
      {
        role: 'toolResult',
        toolName: 'enclave_list',
        content: [{ type: 'text', text: 'first error' }],
        isError: true,
      },
      { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] },
      {
        role: 'toolResult',
        toolName: 'enclave_provision',
        content: [{ type: 'text', text: 'second error' }],
        isError: true,
      },
      { role: 'assistant', content: [{ type: 'text', text: 'final thought' }] },
    ];
    const result = findLastToolError(messages);
    expect(result?.toolName).toBe('enclave_provision');
    expect(result?.content[0]?.text).toBe('second error');
  });

  it('ignores successful tool results', () => {
    const messages: Msg[] = [
      {
        role: 'toolResult',
        toolName: 'enclave_list',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    expect(findLastToolError(messages)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to confirm fail**

```bash
npx vitest run test/unit/smart-path-bailout.test.ts
```

Expected: FAIL — `findLastToolError` not exported from `smart-path.ts`.

- [ ] **Step 3: Add `findLastToolError` and replace the bailout**

In `src/dispatcher/smart-path.ts`, near the bottom (next to the existing helpers), add:
```ts
/**
 * Walk a message list in reverse, returning the most recent tool
 * result with isError === true, or null if none exist.
 *
 * Used by the MAX_TURNS bailout to surface a real tool error to the
 * user rather than replaying a stale assistant utterance.
 */
export function findLastToolError(
  messages: ReadonlyArray<unknown>,
): { toolName: string; content: Array<{ type: string; text: string }> } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as
      | { role: string; toolName?: string; content?: unknown; isError?: boolean }
      | undefined;
    if (m && m.role === 'toolResult' && m.isError === true) {
      return {
        toolName: String(m.toolName ?? 'unknown'),
        content: (m.content as Array<{ type: string; text: string }>) ?? [],
      };
    }
  }
  return null;
}

/** Truncate a string for safe inclusion in a user-facing message. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
```

Then locate the salvage block (around line 281):
```ts
    // If we exhausted MAX_TURNS without a terminal text response,
    // salvage text from any assistant message in the history so the
    // user at least sees the agent's partial thinking rather than
    // the generic fallback.
    if (!finalText) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'assistant') {
          const text = (
            m as { content: Array<{ type: string; text?: string }> }
          ).content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text as string)
            .join('')
            .trim();
          if (text) {
            log.warn(
              { turns: MAX_TURNS },
              'smart-path: MAX_TURNS reached, returning last assistant text',
            );
            finalText = text;
            break;
          }
        }
      }
    }
```

Replace with:
```ts
    // MAX_TURNS exhausted without a terminal text response. Surface
    // the most recent tool error if one exists — replaying a stale
    // assistant utterance produced the misleading "Deployed. Now
    // triggering a manual run." message in the 2026-05-04 incident.
    if (!finalText) {
      const lastErr = findLastToolError(messages);
      if (lastErr) {
        const errText = lastErr.content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('')
          .trim();
        finalText = `I couldn't complete this. The last tool I tried (\`${lastErr.toolName}\`) returned: ${truncate(errText, 500)}`;
      } else {
        finalText =
          "I ran out of steps trying to answer this and don't have a final result. Please re-ask, or @mention me in your enclave channel for a longer-running answer.";
      }
      log.warn(
        { turns: MAX_TURNS, hadToolError: Boolean(lastErr) },
        'smart-path: budget exhausted',
      );
    }
```

- [ ] **Step 4: Run the bailout test to confirm pass**

```bash
npx vitest run test/unit/smart-path-bailout.test.ts
```

Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/dispatcher/smart-path.ts test/unit/smart-path-bailout.test.ts
git commit -m "fix(smart-path): surface tool errors at MAX_TURNS, drop stale-text salvage

Old bailout returned the most recent assistant text, which produced
'Deployed. Now triggering a manual run.' as the answer in the
2026-05-04 incident even though the followup wf_run had errored.

New bailout walks back to the last tool result with isError=true,
reports the tool name and (truncated) error content. If no tool
errors are in the transcript, returns an honest exhaustion message
that points the user to the team path for longer work.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Update DM and provision system prompts

**Files:**
- Modify: `src/dispatcher/smart-path.ts:333-346` (`buildDmSystemPrompt`), `:348-387` (`buildProvisioningPrompt`).

- [ ] **Step 1: Replace `buildDmSystemPrompt`**

Locate (around line 333):
```ts
function buildDmSystemPrompt(userEmail: string): string {
  return [
    '# Role: The Kraken (DM mode)',
    '',
    'You are The Kraken, a conversational assistant for the Tentacular platform.',
    'The user is currently messaging you in a direct message (no enclave context).',
    `User email: ${userEmail}`,
    '',
    '## Response Style',
    '- Respond directly in first person. Never narrate your own actions.',
    '- Be concise and technical. Users are engineers.',
    '- If the user asks about workflows/tentacles, remind them those live inside enclave channels.',
  ].join('\n');
}
```

Replace with:
```ts
function buildDmSystemPrompt(userEmail: string): string {
  return [
    '# Role: The Kraken (DM mode)',
    '',
    `You are answering a direct message from ${userEmail}. You DO NOT`,
    "have access to any enclave's workflows, deployments, logs, or state.",
    'The only thing you can query is `enclave_list` — to remind the user',
    "which enclaves they're a member of.",
    '',
    '## What you can do',
    '- Answer general questions about Tentacular (concepts, scaffolds, skill).',
    "- List the user's enclaves and direct them to the right channel.",
    '- Help the user provision a new enclave (you will be re-prompted in',
    "  provision mode if they're in an unbound channel).",
    '',
    '## What you must NOT do',
    '- Claim anything about a specific workflow, deployment, run history,',
    '  log line, or status. You cannot see these in DM. If asked, say:',
    '  "Ask me from inside #<enclave-name> and I will answer with real data."',
    '- Invent telemetry, uptimes, run counts, error rates, or workflow',
    '  names. If you do not have a fact in front of you (from `enclave_list`',
    '  or the user message), it does not exist.',
    '',
    '## Prior thread context',
    'Earlier replies in this thread are shown to you for continuity. Do',
    'NOT treat your own prior replies as facts. If a prior reply mentioned',
    'specific telemetry, run history, or workflow state, that information',
    'is no longer available — restate only if the user re-asks and',
    'disclose you cannot verify.',
    '',
    '## Tool errors',
    'If a tool call returns an error, report the error verbatim and stop.',
    'Do not retry, do not invent a workaround, do not paper over.',
    '',
    '## Style',
    '- First person. Concise. Engineers reading.',
    '- If you do not know, say so.',
  ].join('\n');
}
```

- [ ] **Step 2: Add prior-turns guard to `buildProvisioningPrompt`**

Locate the trailing `## Rules` block (around line 381):
```ts
    '## Rules',
    '- Be conversational and concise. Users are engineers.',
    '- Do NOT ask for owner_email, owner_sub, channel_id, or platform — you already have those.',
    '- Only ask for name and description.',
    '- NEVER mention kubectl, namespace, or pod.',
  ].join('\n');
```

Insert one new section before `## Rules`:
```ts
    '## Prior thread context',
    'Earlier replies in this thread are shown to you for continuity. Do',
    'NOT treat your own prior replies as facts. Continue the provisioning',
    'flow from wherever the user is now, not from what you previously',
    'claimed had happened.',
    '',
    '## Rules',
    '- Be conversational and concise. Users are engineers.',
    '- Do NOT ask for owner_email, owner_sub, channel_id, or platform — you already have those.',
    '- Only ask for name and description.',
    '- NEVER mention kubectl, namespace, or pod.',
  ].join('\n');
```

- [ ] **Step 3: Run prompt tests**

```bash
npx vitest run test/unit/mode-prompts.test.ts
```

Expected: depending on what `mode-prompts.test.ts` asserts, this may PASS unchanged or FAIL on a substring match. If it fails because it asserts old prompt strings:
- If the old assertion is a structural check ("contains 'DM mode'"): keep it; new prompt still includes "DM mode".
- If the old assertion is a substring of removed text ("contains 'Be concise and technical'"): update the assertion to match the new prompt structure (e.g., "contains 'Concise. Engineers reading.'").

Make minimum-scope edits. Do not rewrite the test file.

- [ ] **Step 4: Run the full unit suite**

```bash
npm test
```

Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add src/dispatcher/smart-path.ts test/unit/mode-prompts.test.ts
git commit -m "feat(smart-path): explicit DM and provision prompts with grounding rules

DM prompt is now explicit about scope (no enclave access, only
enclave_list) and forbids fabricating telemetry, run history, or
workflow state. Adds a prior-turns guard so a fabricated earlier
reply cannot be re-anchored as fact.

Provision prompt picks up the same prior-turns guard.

Tool-error handling rule added to DM prompt: report verbatim, do
not retry or paper over.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Pre-push verification + open PR

- [ ] **Step 1: Run the full pre-push checklist**

```bash
cd ~/code/tentacular-main/thekraken
npm test
npx tsc --noEmit
npm run lint
npm run format:check
```

Expected: all four PASS / clean.

If `format:check` fails, run `npm run format` and re-stage / amend the most recent commit with the formatting changes (or commit them separately as `chore: format`). Do not skip.

- [ ] **Step 2: Push the branch**

```bash
git push origin feat/smart-path-tightening
```

(Already tracked from the spec doc commit. This is just the catch-up push.)

- [ ] **Step 3: Open PR**

```bash
gh pr create \
  --title "feat(smart-path): tighten to read-only, no destructive ops" \
  --body "$(cat <<'EOF'
## Summary

Locks smart path down to read-only conversational reasoning. Implements the design at \`docs/superpowers/specs/2026-05-04-smart-path-tightening-design.md\`.

## What changed

- **Per-mode tool allowlist** (\`MODE_TOOL_ALLOWLIST\` in \`src/dispatcher/smart-path.ts\`): DM mode = \`[enclave_list]\`, provision mode = \`[enclave_provision]\`. Filter applied at Context build time and on every token-refresh, so the LLM cannot call destructive tools regardless of what the prompt or its prior replies say.
- **Dead enclave-mode branch deleted.** Router already routes all enclave-bound traffic to the team subprocess (router.ts:211); only smart-path.ts had stale code referencing \`mode: 'enclave'\` and \`buildManagerPrompt\`. Cleaned up. \`SmartPathMode = 'dm' | 'provision'\` enforces this at compile time.
- **MAX_TURNS bailout no longer returns stale assistant text.** New \`findLastToolError\` walks the transcript for the most recent error and surfaces it to the user (\`I couldn't complete this. The last tool I tried (\\\`wf_run\\\`) returned: ...\`). Drops the misleading \"Deployed. Now triggering a manual run.\" pattern that produced the user-visible incident.
- **Prompts rewritten** for DM and provision modes to forbid fabricating telemetry/run history/workflow state, and to disclose un-verifiability for prior-turn claims.

## Why

2026-05-04 ai-news-digest incident — smart-path in DM mode hallucinated workflow telemetry, then called \`wf_apply\` with a fabricated spec, then \`wf_run\` timed out (PSA admission failure on the bypass-builder spec), then MAX_TURNS bailout swallowed the error and surfaced a stale optimistic message.

Full incident analysis: \`scratch/smart-path-redesign.md\` and \`scratch/kraken-incident-2026-05-04.log\`.

## Tests

- \`test/unit/smart-path-allowlist.test.ts\` (new) — mode → tool list filtering.
- \`test/unit/smart-path-bailout.test.ts\` (new) — \`findLastToolError\` + bailout error surfacing.
- \`test/unit/mode-prompts.test.ts\` (updated) — substring assertions aligned with new prompts.
- Existing routing tests unchanged — router was already correct.

## Out of scope

- Server-side PSA validation in \`wf_apply\` — \`tentacular-mcp#115\` (defense-in-depth).
- Team-manager grounding audit — separate task.
- Slash command expansion (\`/redeploy\`, \`/run\`) — orthogonal UX.

Ships in \`v0.10.0-rc.10\` lockstep.
EOF
)"
```

- [ ] **Step 4: Watch CI to green**

```bash
gh pr checks <PR#> -R randybias/thekraken
```

Wait until all checks complete. If any fail, fix and push a follow-up commit. **Do not merge.** The orchestrator will admin-merge after review.

- [ ] **Step 5: Report PR URL and CI status to caller**

---

## Self-review

**Spec coverage:**
- Section "Architecture" → Tasks 1, 2 (delete enclave-mode + narrow types).
- Section "Components → smart-path.ts" → Tasks 1, 4 (allowlist), 6 (prompts).
- Section "Components → router.ts" → Task 2 (type narrowing only, per corrected spec).
- Section "Behavior per mode → DM" → Tasks 4 (allowlist), 6 (prompt).
- Section "Behavior per mode → Provision" → Tasks 4 (allowlist), 6 (prior-turns guard).
- Section "Behavior per mode → Enclave" → Task 1 (deletion).
- Section "Thread memory" → Task 6 (prior-turns guard in both prompts).
- Section "MAX_TURNS" → no change required (stays at 8 per spec).
- Section "Error handling" → Task 5 (`findLastToolError` + bailout replacement).
- Section "Testing" → Tasks 4, 5, 6 (allowlist test, bailout test, prompt test alignment).
- Section "Acceptance criteria" #1 (no `mode === 'enclave'`) → Task 1.
- Section "Acceptance criteria" #2 (DM tools.length === 1, `enclave_list`) → Task 4 test.
- Section "Acceptance criteria" #3 (Provision tools.length === 1, `enclave_provision`) → Task 4 test.
- Section "Acceptance criteria" #4 (router test: in-enclave → team) → already covered by existing routing tests; Task 2 verifies they still pass.
- Section "Acceptance criteria" #5 (MAX_TURNS error surface) → Task 5 test.
- Section "Acceptance criteria" #6 (incident replay: DM "tell me about ai-news-digest" → no fabrication) → covered by allowlist (no `wf_*` tools) + prompt (forbid claims). End-to-end Slack replay belongs in `test/scenarios/` if needed; spec lists it as an acceptance criterion but doesn't mandate a test artifact, so it's verified manually post-deploy.

**Placeholder scan:** clean. No TBD/TODO. Every code step has full code. Every test has full assertions.

**Type consistency:** `SmartPathMode` exported from smart-path.ts in Task 1, used by Task 2 (router import), Task 4 (allowlist test). `findLastToolError` defined and tested in Task 5 (with consistent return type).
