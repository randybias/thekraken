# Permissions Reference

## Model

Tentacular uses a POSIX-like owner/group/mode permission model, enforced at
the MCP layer. Namespaces are like directories; tentacles are like files.

## Entities

| Entity | Analogy | Notes |
|--------|---------|-------|
| Enclave (namespace) | Directory | Has owner, group, mode |
| Tentacle (workflow) | File | Has owner, group, mode |
| Owner | File owner | The user who created the resource |
| Group | File group | Members of the enclave |
| Mode | chmod bits | rwx for owner, group, others |

## Permission Bits

Three triples: owner / group / others. Each triple: read (r), write (w),
execute (x).

For tentacles:
- **r** (read) — can describe, view logs, view health
- **w** (write) — can modify, redeploy, remove
- **x** (execute) — can run, restart

## Common Presets

| Mode string | Human description |
|-------------|------------------|
| `rwxrwx---` | Full access for owner and group members |
| `rwxr-x---` | Owner: full; group: read and run only |
| `rwx------` | Owner-only — no group access |
| `rwxrwxr--` | Owner + group: full; others: read-only |

**Always translate mode strings to plain English when responding to users.**
Never show `rwxrwx---` verbatim.

## MCP Tools

| Tool | What it does |
|------|-------------|
| `permissions_get` | Get owner, group, and mode for a workflow |
| `permissions_set` | Set group or mode (owner-only operation) |
| `ns_permissions_get` | Get permissions for an enclave (namespace) |
| `ns_permissions_set` | Set permissions for an enclave (owner-only) |

## Enclave Membership

Enclave members are users who have been added to the enclave's group via
`enclave_sync`. Members get read/run access to workflows in team mode
(`rwxr-x---`). The enclave owner retains full access regardless of mode.

Membership is managed via deterministic Slack commands:
- `@kraken add @user` — adds user to enclave group (owner-only)
- `@kraken remove @user` — removes user from enclave group (owner-only)
- `@kraken transfer @user` — transfers ownership to another user

## RBAC

The MCP server enforces permissions on every tool call. A non-owner calling
a write tool on an owner-only resource receives a 403. The manager must
relay this as a clear permission error to the user — not a generic failure.
