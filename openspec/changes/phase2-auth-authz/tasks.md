# Phase 2: Auth + Authz — Tasks

**Change ID:** phase2-auth-authz
**Status:** DRAFT
**Created:** 2026-04-13
**Author:** Senior Product Manager
**Branch:** feature/phase2-auth-authz

---

## Execution Order

Wave 1 [PARALLEL]: T01, T02, T03+T04, T07, T08
Wave 2: T05 (depends T01-T04)
Wave 3 [PARALLEL]: T06, T09, T11, T12
Wave 4: T10 (depends T05, T06, T07)
Wave 5: T13 (depends T05, T10)
Wave 6 [PARALLEL]: T14, T15, T16, T17
Wave 7: R01-R05

---

### T01: Make OIDC_CLIENT_SECRET Optional (F5)
**Owner:** Developer
Remove required() for OIDC_CLIENT_SECRET. Add KRAKEN_TOKEN_ENCRYPTION_KEY as required.
**DoD:**
- [ ] OidcConfig.clientSecret -> string | undefined
- [ ] .env.example updated
- [ ] KRAKEN_TOKEN_ENCRYPTION_KEY added to config as required
- [ ] Tests pass

### T02: Token Encryption Module [PARALLEL]
**Owner:** Developer
Implement src/auth/crypto.ts — AES-256-GCM column-level encryption.
**DoD:**
- [ ] encrypt/decrypt functions with random IV per call
- [ ] Tamper detection via auth tag
- [ ] Unit tests: roundtrip, tamper, bad key length
- [ ] Tests pass

### T03: Token Storage Layer [PARALLEL]
**Owner:** Developer
Implement src/auth/tokens.ts with encrypted CRUD.
**DoD:**
- [ ] storeUserToken, getValidTokenForUser, getRefreshableTokens, deleteUserToken, markTokenExpired
- [ ] 12-hour session window enforcement
- [ ] All reads/writes use crypto module
- [ ] Tests pass

### T04: Schema Migration for created_at
**Owner:** Developer
Add created_at to user_tokens for session window.
**DoD:**
- [ ] SCHEMA_V1 updated
- [ ] Tests pass

### T05: OIDC Device Flow Implementation
**Owner:** Developer | Depends: T01-T04
Implement src/auth/oidc.ts — public client device flow.
**DoD:**
- [ ] initiateDeviceAuth, pollForToken, refreshAccessToken
- [ ] No getServiceToken, no client_credentials
- [ ] Scope: openid email offline_access
- [ ] Mock HTTP tests: success, denied, expired, slow_down, refresh
- [ ] Tests pass

### T06: Token Refresh Background Loop
**Owner:** Developer | Depends: T03, T05
**DoD:**
- [ ] startTokenRefreshLoop/stopTokenRefreshLoop
- [ ] Refresh at 75% of lifetime
- [ ] Failed refresh -> markTokenExpired
- [ ] Concurrent refresh skip
- [ ] 12-hour window check
- [ ] Tests with fake timers
- [ ] Tests pass

### T07: POSIX Mode Authorization Engine [PARALLEL]
**Owner:** Developer
Implement src/enclave/authz.ts — port from reference.
**DoD:**
- [ ] resolveRole, checkModeBit, checkAccess
- [ ] Frozen enclave enforcement
- [ ] 60s enclave_info cache with invalidation
- [ ] Human-friendly denial messages
- [ ] Tests: owner bypass, member bits, visitor r--, frozen, cache
- [ ] Tests pass

### T08: Enclave Name Validation (F2) [PARALLEL]
**Owner:** Developer
**DoD:**
- [ ] isValidEnclaveName with /^[a-z0-9][a-z0-9-]{0,62}$/
- [ ] Enforced in binding.ts and router.ts
- [ ] Tests: path traversal, uppercase, dash-start, empty, >63 chars
- [ ] Tests pass

### T09: MCP Tool Scoping Extension
**Owner:** Developer | Depends: T07
Implement src/extensions/tool-scoping.ts as pi extension.
**DoD:**
- [ ] Four category maps: ENCLAVE_SCOPED, BLOCKED_IN_ENCLAVE, DM_ALLOWED, ALWAYS_ALLOWED
- [ ] evaluateToolCall pure function
- [ ] Namespace auto-injection, cross-enclave blocking, DM read-only
- [ ] Unknown tools blocked
- [ ] Loaded by teams, not dispatcher
- [ ] Tests pass

### T10: Dispatcher Auth Gate
**Owner:** Developer | Depends: T05, T06, T07
Wire auth + authz into dispatcher routing.
**DoD:**
- [ ] getValidTokenForUser before forward; null -> auth card, no forward
- [ ] checkAccess before forward; denied -> denial message
- [ ] Real tokens in mailbox records (replace empty strings)
- [ ] Real tokens in spawnTeam TNTC_ACCESS_TOKEN
- [ ] classifyOperation heuristic (default: read)
- [ ] Tests: unauthed, authed, denied, token refresh
- [ ] Tests pass

### T11: Mailbox Token Cleanup on Shutdown (F3)
**Owner:** Developer | Depends: T10
**DoD:**
- [ ] Truncate mailbox.ndjson to 0 bytes after team exits
- [ ] Do not delete the file
- [ ] Signals/outbound not truncated
- [ ] Tests pass

### T12: Helm Chart Updates for Token Encryption
**Owner:** Developer | Depends: T02
**DoD:**
- [ ] tokenEncryption.secretName + key in values.yaml
- [ ] Deployment mounts KRAKEN_TOKEN_ENCRYPTION_KEY
- [ ] OIDC_CLIENT_SECRET conditional
- [ ] Chart README updated
- [ ] helm lint passes

### T13: Auth Card Ephemeral Posting
**Owner:** Developer | Depends: T05, T10
**DoD:**
- [ ] postAuthCard with chat.postEphemeral
- [ ] Verification URI + user code + instructions
- [ ] Success confirmation after token poll
- [ ] Timeout message if expires_in elapsed
- [ ] Tests with mock Slack client

### T14: Integration Test — Full Auth Flow
**Owner:** QA/Developer | Depends: T10, T13
**DoD:**
- [ ] Unauthed -> auth card -> complete auth -> token stored -> forwarded
- [ ] Expired token -> re-auth card -> fresh token
- [ ] Valid token -> no card, immediate forward
- [ ] Denied by authz -> denial message

### T15: Integration Test — Tool Scoping
**Owner:** QA/Developer | Depends: T09
**DoD:**
- [ ] Enclave mode: namespace injected, wrong namespace blocked, admin tool blocked
- [ ] DM mode: read-only allowed, write blocked

### T16: Integration Test — Cross-User Token Isolation
**Owner:** QA/Developer | Depends: T10
**DoD:**
- [ ] Two users same enclave, separate tokens in mailbox
- [ ] User A token never in User B mailbox record
- [ ] User A expiry doesn't affect User B

### T17: Update CLAUDE.md and README
**Owner:** Tech Writer | Depends: T01-T13

### R01: Code Review
### R02: Security Review (critical for this phase)
### R03: QA Review
### R04: Tech Writer Review
### R05: Codex Review (skippable if unreachable)
