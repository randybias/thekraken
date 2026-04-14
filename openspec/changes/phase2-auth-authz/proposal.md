# Phase 2: Auth + Authz — OIDC Device Flow, POSIX Mode, Tool Scoping

**Change ID:** phase2-auth-authz
**Status:** DRAFT
**Created:** 2026-04-13
**Author:** Senior Product Manager
**Branch:** feature/phase2-auth-authz

---

## Why Phase 2 Exists

Phase 1 delivered a working dispatcher + per-enclave team architecture.
Every user interaction flows through the deterministic/smart routing paths,
teams spawn on first engagement, and NDJSON IPC works. But every userToken
field is an empty string. The Kraken cannot authenticate users, cannot
enforce who may do what, and cannot scope MCP tools to enclave boundaries.

Without Phase 2, the Kraken is an open door: any Slack user in an enclave
channel can invoke any MCP tool against any namespace. The identity hard
partition (D6) is structurally present but carries no real tokens.

Phase 2 fills the empty strings with real OIDC tokens, gates every action
on POSIX mode bits, and constrains MCP tool calls to the correct enclave.

---

## Deliverables

### D1: Keycloak OIDC Device Authorization Flow
Per-user device flow auth. Ephemeral auth card in channel. Public client
(no client_secret). Token storage with encryption. 12-hour session window.

### D2: Token Lifecycle Management
Proactive refresh at 75% of expiry. 12-hour absolute session window.
Refresh failure marks token expired.

### D3: Token-at-Rest Encryption (F6)
AES-256-GCM for access_token + refresh_token in SQLite. Key from K8s Secret.

### D4: POSIX Mode Authorization Engine
Mode bits, role resolution, frozen enclave enforcement, human-friendly denials.

### D5: MCP Tool Scoping (Pi Extension)
Four categories enforced via beforeToolCall. Namespace injection. Cross-enclave blocking.

### D6: Per-User Token Propagation
Real tokens in mailbox records. Auth gate before team dispatch. Expiry handling.

### D7: Followup Cleanup (F2, F3, F5)
Enclave name validation, mailbox cleanup on shutdown, OIDC_CLIENT_SECRET optional.

---

## Phase 2 Does NOT Deliver
- @kraken commands (Phase 3)
- Channel lifecycle events (Phase 3)
- Enclave provisioning (Phase 3)
- Block Kit cards beyond auth card (Phase 4)
- Slack Home Tab (Phase 4)
- Deploy/rollback flow (Phase 4)
- Jargon filter (Phase 3)

## Dependencies
- Phase 1 merged to main (DONE)
- Keycloak PUBLIC client with device flow enabled (operator responsibility)
- No cross-repo changes

## Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| Pi extension beforeToolCall API | Tool scoping blocked | Architect verifies before T09 |
| Mock Keycloak complexity | Test reliability | Simple HTTP mock, not full container |
| Token refresh race | Stale token | SQLite atomic read at send time |
| Key rotation | Tokens unreadable | Single-key Phase 2; rotation Phase 5 |
