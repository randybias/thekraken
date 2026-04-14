# thekraken

**Status: Experimental** — Pi-based Kraken v2, active rewrite.

The Kraken v2 is a specialized [pi-coding-agent](https://github.com/mariozechner/pi-mono)
running in a custom "Slack mode" — it is NOT a daemon; it is a coding agent
whose primary interface is Slack instead of the TUI. ~50% of its job is
writing tentacles (TypeScript workflow code).

## Architecture (Post-Pivot, 2026-04-13)

**Dispatcher + per-enclave teams.** One singleton dispatcher process owns all
Slack I/O. Per-enclave teams (manager + builder + deployer) are spawned as
pi subprocesses on first engagement. Teams communicate via filesystem NDJSON
(mailbox, outbound, signals). 30-minute idle timeout on teams.

**User identity hard partition (D6).** Every spawned subprocess carries the
initiating user's OIDC token. No service identities for enclave work. Token
expires mid-task = fail + re-auth, never fallback.

**Hybrid dispatcher routing (D4).** Two clearly named paths:
- **Deterministic:** @mention in enclave -> team dispatch; commands -> direct MCP call. No LLM.
- **Smart:** DMs, status checks, ambiguous input -> dispatcher's own pi AgentSession reasoning.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Dispatcher entry: config -> OTel -> SQLite -> teams -> outbound poller -> Slack bot |
| `src/dispatcher/router.ts` | routeEvent() — deterministic vs smart path routing |
| `src/teams/lifecycle.ts` | TeamLifecycleManager: spawn/monitor/idle-timeout/GC |
| `src/teams/outbound-poller.ts` | Polls team outbound.ndjson, posts to Slack |
| `src/teams/ndjson.ts` | Append-only NDJSON writer + reader with byte-offset cursor |
| `src/dispatcher/internal-ops.ts` | spawn_enclave_team, send_to_team, check_team_status, post_to_slack (internal ops, NOT MCP tools) |
| `src/slack/bot.ts` | Slack Bolt dual-mode (HTTP + Socket), event handlers call routeEvent() |
| `src/agent/system-prompt.ts` | Per-role prompt builders (manager, builder, deployer) |
| `src/config.ts` | All config: Slack, OIDC, MCP, LLM allowlists, git-state, teams, observability |
| `src/db/schema.ts` | SQLite schema (5 tables, FK cascade on enclave_bindings) |
| `charts/thekraken/` | Helm chart with mandatory gitState, values-mirantis.yaml overlay |
| `scripts/entrypoint.sh` | Git-state clone/pull, tntc config, hard-fail on missing git config |
| `kraken-hooks/pre-commit` | Monotonic version bump in workflow.yaml (idempotent) |

## Locked Decisions (D1-D8)

These are documented in `openspec/changes/phase1-core-loop/design.md` and
must not be relitigated without user approval:

- D1: Slack mode is Kraken-internal, never upstreamed to pi-mono
- D2: Per-enclave team (not per-thread); thread isolation within manager
- D3: Dispatcher owns all Slack I/O; teams write outbound.ndjson
- D4: Hybrid dispatcher = deterministic + smart, clearly named paths
- D5: Heartbeat-only progress (30-60s floor, friendly human-addressed)
- D6: User identity hard partition (no service identities for enclave work)
- D7: Pod restart = teams die, fresh spawn, 7-day stale dir GC
- D8: Extensions are standard pi-coding-agent extensions

## Development

```bash
npm ci && npm test && npx tsc --noEmit && npm run lint && npm run format:check
helm lint charts/thekraken --set gitState.repoUrl=... --set gitState.credentialsSecret=...
shellcheck scripts/entrypoint.sh kraken-hooks/pre-commit
```

## Phase Status

- **Phase 0:** COMPLETE (scaffold, schema, git-state infra, Helm, Docker, CI)
- **Phase 1:** Implementation complete, reviews in progress (dispatcher + teams)
- **Phase 2:** Auth + authz (OIDC device flow, POSIX mode, tool scoping)
- **Phase 3:** Commands + channel events + personas
- **Phase 4:** Polish + deploy (Block Kit, Home Tab, git-state deploy flow, MCP cross-repo)
- **Phase 5:** Hardening (restart resilience, consistency validation, observability)

## References

- Execution plan: `~/.claude/plans/delightful-riding-shamir.md` (also at `../scratch/kraken-v2-plan-v0.10.0.md`)
- Detailed design: `../scratch/kraken-pi-rewrite-plan.md` (pre-pivot + pivot notice)
- Phase 1 design (authoritative): `openspec/changes/phase1-core-loop/design.md`
- D6 (user identity hard partition): every subprocess carries the user's OIDC token, no service identities
- D4 (hybrid dispatcher routing): deterministic path for commands, smart path for conversations
