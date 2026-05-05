# Thread Model Reference

## Overview

Each enclave has one long-lived manager subprocess (pi in RPC mode). The
manager accumulates conversation context across turns in a single Slack
channel. All messages to the enclave channel are routed through the manager.

## IPC Files (per enclave, in `$KRAKEN_TEAM_DIR`)

| File | Direction | Purpose |
|------|-----------|---------|
| `mailbox.ndjson` | dispatcher → manager | inbound user messages |
| `outbound.ndjson` | manager → poller | replies to post to Slack |
| `signals-out.ndjson` | manager → bridge | commission/terminate dev teams |
| `signals-in.ndjson` | bridge → manager | dev team progress signals |

## Message Flow

```
Slack @mention
  → dispatcher (router.ts) — deterministic admission criteria
  → enclave binding lookup (SQLite cache, lazy MCP reconstitution)
  → spawn_and_forward or forward_to_active_team
  → mailbox.ndjson record appended
  → bridge polls mailbox (1s interval)
  → bridge sends {type:"prompt"} to pi RPC stdin
  → pi processes turn, tool calls, produces assistant text
  → bridge reads assistant text, writes outbound.ndjson record
  → outbound poller reads outbound.ndjson, posts to Slack thread
```

## Router Admission Criteria (deterministic, no LLM)

1. Bot message → ignore
2. Message in unbound channel (non-DM) → ignore
3. `@kraken add @user` → enclave_sync_add (deterministic)
4. `@kraken remove @user` → enclave_sync_remove (deterministic)
5. `@kraken transfer @user` → enclave_sync_transfer (deterministic)
6. `member_left_channel` in bound channel → drift_sync
7. @mention in bound channel, team active → forward_to_active_team
8. @mention in bound channel, no team → spawn_and_forward

DMs and everything else → smart path (LLM, DM assistant mode).

## Enclave Binding

Channel-to-enclave mapping stored in SQLite `enclave_bindings` table. On
cache miss, the bridge performs lazy reconstitution via `enclave_list` +
`enclave_info` MCP calls. Once a binding is found, it's cached so future
messages hit SQLite directly.

## Token Handling per Turn

The bridge writes a fresh `token.json` to the team dir before each mailbox
turn. The manager subprocess reads it via `$KRAKEN_TOKEN_FILE`. Dev team
subprocesses get their own task-scoped `token.json` in `tasks/<taskId>/`.

If no valid token exists (OIDC session expired), the bridge:
1. Writes an outbound re-auth prompt to the user
2. Throws — the mailbox turn is aborted

OIDC token expiry manifests as 0-reply turns (not errors). The user must
re-authenticate via the Slack device code flow before work can continue.

## Dev Team Subprocess Lifecycle

```
manager writes commission_dev_team → signals-out.ndjson
bridge polls signals-out, spawns pi --print <goal>
bridge writes task_started → signals-in.ndjson
HeartbeatController emits heartbeats as progress arrives
dev team writes task_completed/task_failed → signals-in.ndjson
bridge emits final heartbeat
dev team process exits
```

If the dev team exits without writing a terminal signal, the bridge
synthesizes a `task_failed` (premature exit).

## Idle Timeout

The bridge waits up to 10 minutes for `agent_end` per mailbox turn
(`IDLE_TIMEOUT_MS = 10 * 60 * 1000`). Build turns routinely take 10-15
minutes; do not expect fast completion for F-group scenarios.
