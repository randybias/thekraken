# rc.11 — Kraken token reliability + agent session state

**Date:** 2026-05-06
**Status:** approved design; awaiting user spec review before implementation plan
**Origin:** rc.10 nats-weu E2E run produced 9 failures across 6 distinct
bugs (thekraken#18-21). The largest is a smart-path MCP 401 that drops
the LLM into "tool-less mode" and explains M4, C4, I2 (manager appears
to lose tools mid-conversation). Investigation surfaced broader gaps in
the token lifecycle — silent refresh failures, stale snapshots, no
preflight on Keycloak realm config.

## Goals

1. Smart-path never silently degrades to tool-less mode on auth failure.
   It either has tools or it tells the user to re-auth.
2. Background token refresh failures are loud and visible in logs (no
   admin paging mechanism today).
3. Long agent turns survive Keycloak's short access-token TTL without
   401 mid-flight.
4. Misconfigured Keycloak realms (short access-token TTL, unreachable
   issuer) are surfaced loudly at startup but do not crash Kraken.
5. Subprocess agents (manager, dev teams) can read non-sensitive Kraken
   session state directly, and can post to Slack on any channel/thread
   without going through their own MCP path.
6. Sensitive token data is defensively isolated from agent reach.
7. E2E coverage expands to exercise the tentacle CRUD lifecycle end to
   end, so future regressions in deploy/update/delete don't hide.

## Non-goals (out of rc.11)

- Unified `tntc login` + Kraken token store (the double-auth UX). Needs
  its own design — file as a follow-up.
- PGlite or Postgres migration for better RBAC. Cost/benefit doesn't
  pencil out yet — revisit when multi-tenant Kraken is on the roadmap.
- Admin-paging on token-refresh failure. We don't have an admin paging
  channel; the principle is "log loudly and continue."
- Replacing the dispatcher's `ctx.userToken` snapshot with a getter
  upstream of smart-path. Touches more code; the smart-path-side fix
  (refresh-on-entry) is sufficient.

## Architecture

### Today's token lifecycle

```
Slack user
   │
   │ device-auth flow (one-time per ~12h session)
   ▼
Keycloak  ─────────────────────────────────────────────┐
   │                                                   │
   │ access_token (short TTL ~5 min) + refresh_token   │
   ▼                                                   │
SQLite kraken.db / user_tokens row                     │
   │                                                   │
   │ getValidTokenForUser() reads + refreshes-if-stale │
   ├─ smart-path (in-process)        ◄── 401 today     │
   ├─ team-bridge (writes KRAKEN_TOKEN_FILE)           │
   └─ drift sync (enclave owner reconciliation)        │
                                                       │
   background loop every 5 min ──────────────────────► │
   (refreshAllExpiring; failures swallowed today)
```

### rc.11 changes (in priority order)

#### 1. Database split — `kraken-secrets.db`

`user_tokens` migrates out of `kraken.db` into a new SQLite file
`kraken-secrets.db` on the same PVC. POSIX mode `0600`, owned by the
dispatcher's UID. The agent's read access — even if a future bug exposes
raw filesystem to the agent — cannot reach this file at the OS layer.

`kraken.db` keeps everything else (`enclave_bindings`, `deployments`,
`change_summaries`, `thread_sessions`, `outbound_messages`) at mode
`0644`. The agent reads it via the `kraken-db` wrapper.

No data migration: per user direction (2026-05-06), users will re-auth
naturally. Old `user_tokens` table is dropped from `kraken.db` on first
boot.

#### 2. `kraken-db` curated read-only query CLI

Node script in `bin/kraken-db.ts`, baked into the kraken Docker image.
Opens `kraken.db` in SQLite read-only mode (`?mode=ro&immutable=1`).
Hard-coded query catalog — no raw SQL surface:

```
kraken-db lookup-channel <channelId>
   → { enclaveName, ownerEmail, status } | null

kraken-db list-enclaves [--user <slackUserId>]
   → [{ channelId, enclaveName, ownerEmail }, ...]

kraken-db recent-deployments <enclave> [--tentacle <name>] [--limit N]
   → [{ tentacle, version, gitSha, summary, deployedByEmail, ts }, ...]

kraken-db change-summary <enclave> <tentacle>
   → { summary, version, ts } | null
```

Returns JSON to stdout. Errors to stderr with non-zero exit. New
queries go through PR review of the catalog. The wrapper is the only
agent-facing surface; subprocesses never construct SQL.

#### 3. Smart-path 401 fix

`src/dispatcher/smart-path.ts` changes:

- **Refresh on entry.** Before the initial `createMcpConnection`, call
  `input.getFreshToken()`. Use the result if non-null; otherwise fall
  back to `input.userToken` snapshot.
- **Resolve channel name on entry.** If `input.channelName` is missing
  but `input.channelId` is set, look up `enclave_bindings` for the
  channel; pass the enclave name as the channel name. (Bindings table
  is in-process readable.)
- **One retry on 401.** If `createMcpConnection` throws and the error
  is a 401, call `getFreshToken()` once more, retry the connection.
- **Abort on persistent 401.** If both attempts fail with 401, return
  a re-auth message to the user — do NOT fall through to tool-less
  mode. Log at `error` level. Same behavior on token = null after
  refresh.
- **Retain between-turns rotation.** Existing `getFreshToken()` call
  between turns is preserved.

Error message to the user (text returned from `runSmartPath`):
> "Your session has expired. Please re-authenticate with `/login` and
> try again."

#### 4. Background refresh visibility

`src/auth/oidc.ts` `refreshAllExpiring()` changes:

- Per-user refresh failures already log at `warn`. Promote to `error`
  level so they show up in default pod log filters.
- Per-sweep summary log emits at `error` level (not `info`) when any
  failures occurred in the sweep, including counts.
- Add `lastSweepAt`, `lastSweepRefreshed`, `lastSweepFailed`,
  `lastSweepDeleted` module-level vars exposed via a
  `getRefreshLoopStatus()` accessor.

No behavior change to the refresh logic itself — the failure modes are
covered by points 1, 3, 7 below.

#### 5. Team-bridge mid-turn token refresh

`src/teams/bridge.ts` adds a 60s timer that, while the bridge is alive,
calls `opts.getTokenForUser(currentRecord?.userSlackId)` and rewrites
`KRAKEN_TOKEN_FILE`. No-op if no current record (between turns). Timer
is cleared on bridge shutdown.

The subprocess re-reads the file on every `tntc`/MCP call via the
existing bash idiom, so a refresh inside a long turn is picked up
automatically on the next command.

#### 6. Keycloak preflight on startup

`src/auth/oidc.ts` adds `runKeycloakPreflight()`:

- Fetches `${OIDC_ISSUER}/.well-known/openid-configuration`
- Verifies `device_authorization_endpoint` is present (we use device
  auth)
- Verifies `offline_access` is in `scopes_supported` (we request it)
- Validates we can fetch the JWKS

If any check fails, log at `error` level with detail. Continue starting.

For access-token TTL: there's no public endpoint that exposes realm
TTL settings (Keycloak admin API gates this behind admin creds we
don't carry). Instead, we observe TTL implicitly: track the actual
TTL of issued tokens (`expires_in` on every `setUserToken`); on
startup, if any user's last-stored TTL was < 5 min, log a warning
recommending the realm be reconfigured. Not a full preflight, but
honest.

`src/index.ts` calls `runKeycloakPreflight()` once during boot, after
DB init, before bot startup.

#### 7. Health endpoint — refresh-loop liveness

`src/health.ts` `checkHealth()` extension:

- Adds `refreshLoop` field with `lastSweepAt`, ages
- If `lastSweepAt` is unset (loop never ran) → status `degraded`
- If `now - lastSweepAt > 2 * REFRESH_INTERVAL_MS` (10 min) → status
  `degraded`
- Otherwise `ok` for the refresh loop check; overall status remains
  `ok` if DB and refresh-loop are both ok

`degraded` returns HTTP 200 (not 503) — Kubernetes readiness probe
keeps the pod in service. The status is only for observability.

#### 8. Subprocess `post_to_slack` via `outbound.ndjson`

No new mechanism. The dispatcher's `outbound-poller` already reads
`outbound.ndjson` records and posts them to Slack. The system prompt
documents the format and gives the agent a bash idiom for posting to
arbitrary channels:

```bash
printf '{"id":"%s","timestamp":"%s","type":"slack_message","channelId":"%s","threadTs":"%s","text":"%s"}\n' \
  "$(uuidgen)" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$CHANNEL" "$THREAD" "$TEXT" \
  >> "$KRAKEN_TEAM_DIR/outbound.ndjson"
```

`threadTs` may be empty for top-of-channel posts. The poller's existing
deduplication and post logic handles correctness.

#### 9. Prompt guidance — no confabulated denials

System prompts (manager + smart-path) get an explicit clause:

> "If you cannot do something, ask the user. Never claim you don't have
> a capability that you haven't actually attempted to use. Never claim
> structural denial — e.g., 'I don't have access to Slack', 'I can't
> retrieve that', 'I can't post to channels' — without first trying."

#### 10. E2E expansion — tentacle CRUD lifecycle

New scenarios in `test/e2e-slack/scenarios.ts` group F:

- **F-CREATE-1:** "Build a new echo-probe tentacle." → asserts:
  commission, builder/deployer signals, `wf_describe` shows the new
  tentacle deployed, no jargon leak.
- **F-READ-1:** "What's the status of <tentacle>?" → asserts: returns
  prose-formatted status with version/ready/last-deploy, no markdown
  table.
- **F-READ-2:** "Show me the last deploy of <tentacle>." → asserts:
  returns plain-English summary (sourced from `change_summaries`), no
  SHAs or version numbers.
- **F-UPDATE-1:** "Change the schedule on <tentacle> to every hour." →
  asserts: re-deploys, deploy event recorded, new schedule reflected
  in next `wf_describe`.
- **F-DELETE-1:** "Remove <tentacle>." → asserts: confirmation prompt,
  removed from `wf_list`, deploy event records the removal.

Forbidden patterns: same as N group (no markdown tables, no channel
IDs, no SHAs, no version numbers).

These run only when `KRAKEN_E2E_ALLOW_DESTRUCTIVE=1` is set, since
they create + delete tentacles. Default off so dev runs don't churn
the cluster.

## Components

| Component | Files touched | New surface |
|---|---|---|
| DB split | `src/db/schema.ts`, `src/db/migrations.ts`, `src/db/index.ts`, `src/auth/tokens.ts`, `src/index.ts` | `kraken-secrets.db` file |
| Query CLI | new `bin/kraken-db.ts`, `package.json` (bin entry), `Dockerfile` | `kraken-db` binary in image |
| Smart-path fix | `src/dispatcher/smart-path.ts`, `src/index.ts` | refreshed entry path |
| Background refresh visibility | `src/auth/oidc.ts` | `getRefreshLoopStatus()` |
| Team-bridge timer | `src/teams/bridge.ts` | per-bridge timer |
| Keycloak preflight | `src/auth/oidc.ts`, `src/index.ts` | `runKeycloakPreflight()` |
| Health | `src/health.ts` | `refreshLoop` field |
| Subprocess `post_to_slack` doc | `src/agent/system-prompt.ts` | prompt block |
| Prompt guidance | `src/agent/system-prompt.ts`, smart-path prompts | prompt block |
| E2E expansion | `test/e2e-slack/scenarios.ts` | F-CRUD scenarios |

## Data flow — smart-path with rc.11

```
slack message
   │
   ▼
router.routeEvent
   │ ctx.userToken = getValidTokenForUser(userId) [snapshot]
   │ ctx.channelName = (resolved upstream if known)
   ▼
runSmartPath(input)
   │
   │ token = getFreshToken() ?? input.userToken      ← NEW
   │ if !channelName: channelName = lookup_channel(channelId)  ← NEW
   │
   │ try: mcp = createMcpConnection(url, token)
   │ catch 401:
   │   token = getFreshToken()                       ← NEW
   │   if !token: return "Session expired. Re-auth."
   │   try: mcp = createMcpConnection(url, token)
   │   catch 401: return "Session expired. Re-auth."
   │
   │ for turn in 0..MAX_TURNS:
   │   complete(model, ctx)
   │   if toolCall:
   │     getFreshToken() between turns → rotate mcp if changed
   │     execute(toolCall) on mcp
```

## Error handling

- 401 on initial connect → one retry, then re-auth abort
- 401 on between-turns rotation → existing warn; turn continues with
  old `mcp`. Acceptable today; covered by initial-connect retry on
  the next user message.
- Background refresh per-user failure → `error` log, sweep continues
- Background refresh sweep exception → `error` log, loop continues
- Keycloak preflight failure → `error` log, startup continues
- Health endpoint exception → 503 (existing behavior)
- DB split: missing `kraken-secrets.db` on boot → init it; never error.

## Testing

Unit tests:
- `kraken-db lookup-channel` happy path + miss
- `kraken-db recent-deployments` filtering + ordering
- `getValidTokenForUser` returns null after persistent refresh failure
- Smart-path: 401 on initial connect → retry succeeds
- Smart-path: persistent 401 → returns re-auth message string
- Smart-path: channel-name resolution from bindings
- Background refresh: failure counts surfaced via `getRefreshLoopStatus`
- Health: `degraded` when refresh loop hasn't run

E2E (live nats-weu):
- All 9 currently-failing scenarios pass
- New F-CRUD scenarios pass
- N group (manager output hygiene) stays green

## Migration / rollback

- DB split: idempotent. On first boot, if `user_tokens` table exists
  in `kraken.db`, drop it. `kraken-secrets.db` is created fresh.
  Result: every existing user must re-auth once. No data loss because
  the canonical token source is always Keycloak.
- Rollback: pin to `:v0.10.0-rc.10`. The two DB files coexist with the
  old single-file schema (rc.10 just won't see `kraken-secrets.db`).
  Users would re-auth into rc.10's `kraken.db.user_tokens`.

## Risks

- **DB split adds a second file to the PVC.** PVC capacity isn't tight,
  but worth verifying the volume mount config covers the new path.
- **`kraken-db` wrapper is a new binary in PATH.** If subprocess `PATH`
  doesn't include `/usr/local/bin`, the agent can't find it. Verify
  in lifecycle env setup.
- **60s mid-turn refresh timer.** If `getTokenForUser` blocks (e.g.,
  Keycloak slow), the timer queue could pile up. Use non-overlapping
  timer (skip tick if previous still running).
- **Loud-log-and-continue on Keycloak preflight.** If admin doesn't
  read logs, misconfig persists. Acceptable per user direction; we
  don't have an admin notification mechanism.

## Open follow-ups (post rc.11)

- Unified token store with `tntc login` (Gap 6)
- PGlite/Postgres migration evaluation when multi-tenant Kraken arrives
- Snapshot replacement in router so smart-path always gets a fresh
  token at entry from upstream (not just within smart-path)
- Continuous interaction-capture plan (K1-K7, separate doc)
