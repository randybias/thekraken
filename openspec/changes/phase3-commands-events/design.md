# Phase 3: Commands + Channel Events + Personas — Design

**Change ID:** phase3-commands-events
**Status:** DRAFT
**Created:** 2026-04-13
**Author:** Senior Architect
**Branch:** feature/phase3-commands-events

---

## 0. Purpose

Phase 3 fills the stubs left by Phase 0 (`src/enclave/commands.ts`,
`src/enclave/drift.ts`, `src/enclave/provisioning.ts`,
`src/enclave/personas.ts`, `src/slack/events.ts`) and extends the
dispatcher router with the complete command grammar.

### Dependencies

- Phase 0: SQLite schema, Helm chart, Docker
- Phase 1: Dispatcher router, team lifecycle, outbound poller, NDJSON IPC
- Phase 2: OIDC device flow, token store, auth gate, POSIX authz

### Inherited Locked Decisions: D1-D8

Phase 3 introduces ONE documented D6 exception: drift detection (Section 6).

---

## 1. Command Parser

### 1.1 Extended DeterministicAction Type

**File:** `src/dispatcher/router.ts`

```typescript
export type DeterministicAction =
  | { type: 'spawn_and_forward'; enclaveName: string }
  | { type: 'forward_to_active_team'; enclaveName: string }
  | { type: 'enclave_sync_add'; targetUserIds: string[] }      // CHANGED: was singular
  | { type: 'enclave_sync_remove'; targetUserIds: string[] }    // CHANGED: was singular
  | { type: 'enclave_sync_transfer'; targetUserId: string }
  | { type: 'enclave_archive' }
  | { type: 'enclave_delete' }
  | { type: 'enclave_members' }
  | { type: 'enclave_whoami' }
  | { type: 'enclave_help' }
  | { type: 'drift_sync'; channelId: string }
  | { type: 'channel_event'; eventType: ChannelEventType }
  | { type: 'ignore_unbound' }
  | { type: 'ignore_bot' }
  | { type: 'ignore_visitor' }
  | { type: 'ignore_no_mention' };

export type SmartReason =
  | 'dm_query'
  | 'ambiguous_input'     // absorbs former 'novel_phrasing'
  | 'status_check'
  | 'help_request';
```

### 1.2 Mention Extraction

```typescript
const FILLER = /^(and|also|please|then|,)\s*/i;

function extractMentions(afterVerb: string): string[] | null {
  let rest = afterVerb.trim();
  const mentions: string[] = [];
  while (rest.length > 0) {
    const filler = rest.match(FILLER);
    if (filler) { rest = rest.slice(filler[0].length).trim(); continue; }
    const mention = rest.match(/^<@([A-Z0-9]+)>/i);
    if (mention) { mentions.push(mention[1]!); rest = rest.slice(mention[0].length).trim(); continue; }
    if (mentions.length === 0) return null;
    break; // trailing non-mention text after some mentions is OK
  }
  return mentions.length > 0 ? mentions : null;
}
```

### 1.3 parseCommand()

```typescript
export function parseCommand(text: string): DeterministicAction | null {
  const stripped = text.replace(/^<@[A-Z0-9]+>\s*/i, '').trim();

  // Membership: add/remove @user(s)
  const memberMatch = stripped.match(/^(add|remove)\s+(.*)/i);
  if (memberMatch) {
    const verb = memberMatch[1]!.toLowerCase();
    const mentions = extractMentions(memberMatch[2]!);
    if (mentions) {
      return verb === 'add'
        ? { type: 'enclave_sync_add', targetUserIds: mentions }
        : { type: 'enclave_sync_remove', targetUserIds: mentions };
    }
    return null;
  }

  // Transfer: "transfer [to] @user"
  const transfer = stripped.match(/^transfer\s+(?:to\s+)?<@([A-Z0-9]+)>/i);
  if (transfer) return { type: 'enclave_sync_transfer', targetUserId: transfer[1]! };
  if (/^transfer\b/i.test(stripped)) return null;

  // Exact-phrase commands
  if (/^archive\s*$/i.test(stripped)) return { type: 'enclave_archive' };
  if (/^delete\s+enclave\s*$/i.test(stripped)) return { type: 'enclave_delete' };
  if (/^members\s*$/i.test(stripped)) return { type: 'enclave_members' };
  if (/^whoami\s*$/i.test(stripped)) return { type: 'enclave_whoami' };
  if (/^help\s*$/i.test(stripped)) return { type: 'enclave_help' };

  return null;
}
```

### 1.4 Disambiguation Matrix

| Input | Result | Rule |
|-------|--------|------|
| `add @alice` | `enclave_sync_add` | @mention after verb |
| `add @alice and @bob` | `enclave_sync_add` (2) | All non-filler are @mentions |
| `add a new node` | null -> smart | First token not @mention |
| `transfer to @alice` | `enclave_sync_transfer` | "to" optional |
| `transfer my files` | null -> smart | No @mention |
| `delete enclave` | `enclave_delete` | Exact phrase |
| `delete the old tentacle` | null -> smart | Not exact |
| `archive` | `enclave_archive` | Exact keyword |
| `archive my notes` | null -> smart | Extra text |

### 1.5 FN-2: Bound-Channel @mention Requirement

In `routeEvent()`, after binding lookup, before team dispatch:

```typescript
if (binding && event.type === 'message' && event.channelType !== 'im' && !event.threadTs) {
  return { path: 'deterministic', action: { type: 'ignore_no_mention' } };
}
```

---

## 2. Command Execution

### 2.1 Types

**File:** `src/enclave/commands.ts`

```typescript
export interface CommandContext {
  enclaveName: string;
  channelId: string;
  userId: string;
  userEmail: string;
  userToken: string;
  userRole: Role;
  mcpCall: McpCallFn;
  resolveEmail: (slackId: string) => Promise<string | undefined>;
  postEphemeral: (text: string) => Promise<void>;
}

export type McpCallFn = (tool: string, params: Record<string, unknown>) => Promise<unknown>;

export interface CommandResult {
  ok: boolean;
  message: string;
  confirm?: boolean;
  confirmKey?: string;
  transfers?: string;
}

export interface EnclaveSyncResult {
  updated?: string[];
  transfers?: Array<{ tentacle_name: string; from_owner: string; to_owner: string; success: boolean; error?: string }>;
}
```

### 2.2 Handler Signatures

All handlers in `src/enclave/commands.ts`:

| Function | Args | Auth | Behavior |
|----------|------|------|----------|
| `handleAdd(ctx, targetUserIds)` | string[] | owner | Resolve emails, `enclave_sync(add_members)` |
| `handleRemove(ctx, targetUserIds)` | string[] | owner | `enclave_sync(remove_members)`, format transfer report |
| `handleTransfer(ctx, targetUserId)` | string | owner | Return confirmation prompt, `executeTransfer()` on "yes" |
| `handleArchive(ctx)` | -- | owner | `enclave_sync(status=frozen)` + `wf_remove` per tentacle |
| `handleDelete(ctx)` | -- | owner | Return confirmation prompt, `executeDelete()` on "DELETE" |
| `handleMembers(ctx)` | -- | owner/member | `enclave_info`, format owner + members |
| `handleWhoami(ctx)` | -- | any authed | Show email + role |
| `handleHelp()` | -- | none | Static natural-language list (design Section 6a text) |

Owner-only handlers return `{ ok: false, message: "Only the enclave owner..." }` for non-owners. All mutating handlers call `invalidateCache(enclaveName)`.

### 2.3 Transfer Report Formatting

Port `formatOwnershipTransferReport()` from reference. Counts succeeded/failed transfers, returns human-friendly string.

---

## 3. Double-Confirmation Flow

```typescript
interface PendingConfirmation {
  action: 'transfer' | 'delete';
  enclaveName: string;
  userId: string;
  threadTs: string;
  targetEmail?: string;
  confirmKey: string;    // "yes" for transfer, "DELETE" for delete
  expiresAt: number;     // Date.now() + 60_000
}
```

In `bot.ts`:
- `pendingConfirmations = new Map<string, PendingConfirmation>()` keyed by `${channelId}:${userId}`.
- When command returns `confirm: true`: post ephemeral, store pending.
- On next message from same user in same channel: check map. Match confirmKey -> execute. Mismatch -> cancel.
- Clean expired entries on each message arrival.

---

## 4. Channel Event Handlers

**File:** `src/slack/events.ts`

### 4.1 Registration

```typescript
export function registerChannelEvents(app: App, deps: ChannelEventDeps): void {
  app.event('member_joined_channel', ...);   // log visitor, no action
  app.event('member_left_channel', ...);     // remove member if in annotation
  app.event('channel_archive', ...);         // freeze + dehydrate
  app.event('channel_unarchive', ...);       // activate, no auto-rehydrate
  app.event('channel_rename', ...);          // sync new name
}
```

### 4.2 Handler Behaviors

| Event | Action | MCP Call | Cache |
|-------|--------|---------|-------|
| `member_joined_channel` | Log, no action (visitor) | None | -- |
| `member_left_channel` | Resolve email, check membership, remove if member | `enclave_sync(remove_members)` | Invalidate |
| `channel_archive` | Freeze + dehydrate (wf_remove per tentacle) | `enclave_sync(status=frozen)` + `wf_remove` | Invalidate |
| `channel_unarchive` | Activate (no auto-rehydrate) | `enclave_sync(status=active)` | Invalidate |
| `channel_rename` | Sync channel name | `enclave_sync(new_channel_name)` | -- |

Bot self-events filtered. Unbound channels ignored. All handlers best-effort (failures logged, drift catches up).

### 4.3 Dehydration via wf_remove

No `wf_stop` or `wf_scale` tool exists. Dehydration uses `wf_remove` (deletes K8s resources). Git-state repo preserves source. Rehydration requires manual redeployment (Phase 4 deploy flow will simplify this).

---

## 5. Enclave Provisioning Flow

### 5.1 State Machine

```
DM intent -> [authenticating] -> [verifying_owner] -> [naming] -> [describing] -> [provisioning] -> [done]
                  |                    |
              no token ->         not owner ->
              device flow          deny + msg
```

### 5.2 ProvisioningFlow Class

**File:** `src/enclave/provisioning.ts`

```typescript
export type ProvisioningState =
  | 'idle' | 'authenticating' | 'verifying_owner'
  | 'naming' | 'describing' | 'provisioning' | 'done' | 'failed';

export interface ProvisioningSession {
  state: ProvisioningState;
  userId: string;
  targetChannelId: string;
  targetChannelName: string;
  proposedName: string;
  description?: string;
  startedAt: number;
}

export class ProvisioningFlow {
  private sessions = new Map<string, ProvisioningSession>();
  // 10-minute timeout per session

  isProvisioningIntent(text: string): boolean;   // regex: set up|create|provision + enclave|channel
  hasActiveSession(userId: string): boolean;
  async handleMessage(userId: string, text: string, deps: ProvisioningDeps): Promise<string>;
}
```

### 5.3 Dependencies

```typescript
export interface ProvisioningDeps {
  tokenStore: UserTokenStore;
  oidcConfig: OidcConfig;
  mcpCall: McpCallFn;
  slackClient: { conversations: { info(...) }, chat: { postMessage(...) } };
  inferPersona: (description: string) => Persona | null;
  writeMemory: (enclaveName: string, content: string) => Promise<void>;
}
```

### 5.4 Channel Ownership

Verify via `conversations.info(channelId).creator === userId`. Fallback: deny and ask user to retry from the correct account.

### 5.5 Defaults

| Parameter | Value |
|-----------|-------|
| `quota_preset` | `medium` |
| `enclave_mode` | `rwxrwxr--` |
| `tentacle_mode` | `rwxr-x---` |

Hardcoded. No user questions about sizing or permissions.

---

## 6. Drift Detection

### 6.1 D6 Exception

Drift detection is the ONE documented exception to D6 (user identity hard partition). It runs on a timer with no user initiating the action.

**Why acceptable:** Only reads membership and removes stale members. Never creates/deploys/modifies tentacles. Logged as `system:drift-detection`. Service token has narrow scope.

**Why user token impossible:** No user initiated the check. Using any specific user's token would violate D6.

### 6.2 DriftDetector Class

**File:** `src/enclave/drift.ts`

```typescript
export interface DriftConfig {
  intervalMs: number;           // default: 300_000
  maxChannelsPerCycle: number;  // default: 5
  serviceToken: string;
}

export class DriftDetector {
  private cycleOffset = 0;
  start(): void;
  stop(): void;
  async runCycle(): Promise<void>;     // list enclaves -> batch -> check each
  private async checkEnclave(e: EnclaveListItem): Promise<void>;
    // Skip frozen. Resolve Slack emails. Compare. Remove stale. Never owner. Never auto-add.
}
```

Round-robin: `cycleOffset` advances by `maxChannelsPerCycle` each cycle, wraps modulo total enclaves. Ensures all enclaves are checked within `ceil(total/batchSize)` cycles.

---

## 7. Persona Inference

### 7.1 Archetypes

**File:** `src/enclave/personas.ts`

```typescript
export interface Persona {
  name: string;
  languageLevel: 'non-technical' | 'semi-technical' | 'technical' | 'highly-technical';
  technicalDetail: 'low' | 'medium' | 'high';
  suggestedScaffolds: string[];
  keywords: string[];
}

export const ARCHETYPES: Persona[] = [
  // 11 entries: Marketing, Sales, Customer Support, Operations, IT,
  // Software Development, Architecture, Finance, HR, Legal, Executive
  // Each with ~10 keywords, languageLevel, suggestedScaffolds
];
```

Full keyword lists in the implementation. See design doc Section 3 for the complete table.

### 7.2 Inference

```typescript
export function inferPersona(description: string): Persona | null;
  // Tokenize description, count keyword matches per archetype.
  // Highest count wins. Ties: first in ARCHETYPES order.
  // Returns null for no matches.

export function formatPersonaForMemory(persona: Persona): string;
  // Markdown block for MEMORY.md:
  // ## Team Persona: {name}
  // Language level: {languageLevel}
  // Technical detail: {technicalDetail}
  // Suggested scaffolds: {suggestedScaffolds}
```

---

## 8. Jargon Filter

### 8.1 Vocabulary

**File:** `src/extensions/jargon-filter.ts`

Port from `thekraken-reference/src/jargon-filter.ts` (20+ substitutions):

| Pattern | Replacement |
|---------|-------------|
| `namespace(s)` | `enclave(s)` |
| `DAG` | `workflow` |
| `pod(s)` | `service(s)` |
| `container(s)` | `service(s)` |
| `gVisor` | `secure sandbox` |
| `rustfs` | `file storage` |
| `postgres(ql)` | `database` |
| `NATS` | `messaging service` |
| `replica(s)` | `instance(s)` |
| `ConfigMap` | `configuration` |
| `` `kubectl ...` `` | `_(system command)_` |
| `` `tntc ...` `` | `_(system command)_` |

### 8.2 Code Block Protection

Split text on triple-backtick fences. Apply substitutions only to non-code segments. Rejoin.

### 8.3 Narration Filter

Port from reference: strip third-person narration lines and bot emoji signatures.

### 8.4 Integration Point

In `OutboundPoller.processRecord()`, apply `filterOutput(text)` before Slack posting for `slack_message` type only.

---

## 9. Wiring Summary

### 9.1 New Files

| File | Purpose |
|------|---------|
| `src/enclave/commands.ts` | Command handlers (replaces stub) |
| `src/enclave/drift.ts` | Drift detection (replaces stub) |
| `src/enclave/provisioning.ts` | Provisioning flow (replaces stub) |
| `src/enclave/personas.ts` | Persona inference (replaces stub) |
| `src/slack/events.ts` | Channel event handlers (replaces stub) |
| `src/extensions/jargon-filter.ts` | Jargon + narration filter |

### 9.2 Modified Files

| File | Changes |
|------|---------|
| `src/dispatcher/router.ts` | Extended types, full parseCommand(), remove novel_phrasing, add ignore_no_mention |
| `src/slack/bot.ts` | Command execution, channel events, confirmation flow |
| `src/teams/outbound-poller.ts` | Jargon filter in processRecord() |
| `src/config.ts` | Add DriftConfig |
| `src/index.ts` | Start drift detector, wire GC |
| `charts/thekraken/values.yaml` | Drift config values |
| `charts/thekraken/templates/secret.yaml` | Drift service token |

### 9.3 Boot Sequence Additions (src/index.ts)

After `bot.start()`:
1. Start DriftDetector (if service token configured, else warn).
2. Run `teams.gcStaleTeams()` once.
3. Schedule hourly GC: `setInterval(() => teams.gcStaleTeams(), 3_600_000).unref()`.

---

## 10. Design Decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| DD-1 | Parser in router.ts, handlers in commands.ts | Centralized routing, separate testable handlers |
| DD-2 | Jargon filter in outbound poller, not pi extension | Single funnel, no per-subprocess loading |
| DD-3 | Provisioning state in-memory (not SQLite) | Short flow, rare operation, pod restart = user restarts conversation |
| DD-4 | channel_unarchive does NOT auto-rehydrate | No wf_stop/wf_scale, archive used wf_remove, matches F1 position |
| DD-5 | Drift uses service token (D6 exception) | No user initiated, narrow scope, audit logged, Security review required |
| DD-6 | add/remove plural targetUserIds | Supports multi-mention, breaking change from Phase 1 (update call sites) |
| DD-7 | Dehydration via wf_remove | Only destructive tool available, git-state preserves source |

---

## 11. Security Considerations

1. **Command auth:** All commands except `help` require OIDC token. Destructive commands owner-only.
2. **Double-confirm:** `transfer` requires "yes", `delete enclave` requires "DELETE". Prevents accidental destruction.
3. **Drift service token:** Narrow Keycloak RBAC (enclave_info, enclave_list, enclave_sync only). NOT propagated to teams.
4. **Ephemeral responses:** All command results visible only to the commanding user.
5. **Provisioning ownership:** Verified via Slack API `conversations.info.creator`.
