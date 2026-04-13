# The Kraken v2

**Status: Experimental** — Pi-based enclave-centric Slack bot for Tentacular.

The Kraken v2 is a specialized [pi-coding-agent](https://github.com/mariozechner/pi-mono)
running in a custom "Slack mode" for the [Tentacular](https://github.com/randybias/tentacular)
platform. ~50% of its job is writing tentacles (TypeScript workflow code).
The rest is managing enclaves (Slack channels bound to K8s namespaces) and
deploying those workflows to a Kubernetes cluster.

## Architecture

### Dispatcher + Per-Enclave Teams

```
Dispatcher (singleton, Kraken main process)
  - Holds Slack Bolt socket (HTTP Events API or Socket Mode)
  - Hybrid routing: deterministic path for clear events, smart path for ambiguous
  - Owns all Slack I/O (teams never post to Slack directly)
  - Spawns and garbage-collects per-enclave teams

Per-Enclave Team (spawned on first engagement, 30-min idle timeout)
  - Manager subprocess (pi, long-lived): accumulates MEMORY.md, holds thread context
  - Builder subprocess (pi, task-scoped): writes tentacle code, runs tests
  - Deployer subprocess (pi, task-scoped): runs git-state deploy flow + MCP wf_apply
```

**Communication:** Filesystem NDJSON files per team:
- `mailbox.ndjson` — dispatcher writes, manager reads (carries user token, 0600 perms)
- `outbound.ndjson` — manager writes, dispatcher reads and posts to Slack
- `signals.ndjson` — builder/deployer write progress, manager reads for heartbeats

**Identity:** Every spawned subprocess carries the initiating user's OIDC token.
No service identities for enclave work. Token expires mid-task = fail cleanly
and prompt re-auth.

### Phase 1 Status

Phase 1 delivers the core dispatcher loop with team spawning infrastructure.
The "smart path" (LLM-powered reasoning) is a placeholder returning static
responses — it will be wired to a real pi `AgentSession` in Phase 2+.
Per-user OIDC tokens are Phase 2; Phase 1 uses `MCP_SERVICE_TOKEN` as a
placeholder in mailbox records.

## Environment Variables

### Required

| Variable | Purpose |
|----------|---------|
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack signing secret (HTTP mode only) |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-...`, Socket mode only) |
| `OIDC_ISSUER` | Keycloak realm URL |
| `OIDC_CLIENT_ID` | OIDC client ID |
| `OIDC_CLIENT_SECRET` | OIDC client secret |
| `TENTACULAR_MCP_URL` | Tentacular MCP server URL |
| `MCP_SERVICE_TOKEN` | Service token for MCP calls (Phase 1 placeholder; replaced by per-user tokens in Phase 2) |
| `GIT_STATE_REPO_URL` | Git-backed state repository URL (hard requirement) |
| `ANTHROPIC_API_KEY` | Required if defaultProvider is anthropic |

### Optional

| Variable | Default | Purpose |
|----------|---------|---------|
| `SLACK_MODE` | `http` | `http` (Events API, production) or `socket` (dev) |
| `GIT_STATE_BRANCH` | `main` | Branch to clone/pull |
| `GIT_STATE_DIR` | `/app/data/git-state` | Local clone directory |
| `KRAKEN_TEAMS_DIR` | `/app/data/teams` | Per-enclave team state directory |
| `LLM_DEFAULT_PROVIDER` | `anthropic` | `anthropic`, `openai`, or `google` |
| `LLM_DEFAULT_MODEL` | `claude-sonnet-4-6` | Model ID from pi-ai registry |
| `LLM_ALLOWED_PROVIDERS` | `anthropic,openai,google` | Comma-separated |
| `LLM_DISALLOWED_MODELS` | `gpt-4o,o3,o4-mini,...` | Quality-gated denylist |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _(empty = disabled)_ | OTLP HTTP endpoint for OTel traces |
| `LOG_LEVEL` | `info` | Pino log level |
| `OPENAI_API_KEY` | | Required if openai in allowedProviders |
| `GEMINI_API_KEY` | | Required if google in allowedProviders |
| `PORT` | `3000` | HTTP server port |
| `MCP_PORT` | `8080` | MCP server port |

## Development

```bash
npm ci
npm run build        # Compile TypeScript
npm test             # 234 tests (unit + integration + scenarios)
npx tsc --noEmit     # Type check
npm run lint         # ESLint
npm run format:check # Prettier
```

## Kubernetes Deployment

```bash
helm install thekraken ./charts/thekraken \
  --namespace tentacular-kraken --create-namespace \
  --set secrets.slackBotToken=xoxb-... \
  --set secrets.slackSigningSecret=... \
  --set secrets.anthropicApiKey=sk-ant-... \
  --set secrets.mcpServiceToken=... \
  --set mcp.url=http://tentacular-mcp:8080 \
  --set oidc.issuer=https://keycloak.example.com/realms/tentacular \
  --set oidc.clientId=thekraken \
  --set secrets.oidcClientSecret=... \
  --set gitState.repoUrl=https://github.com/org/tentacle-workflows.git \
  --set gitState.credentialsSecret=thekraken-git-state
```

For Mirantis deployment, use the overlay:
```bash
helm install thekraken ./charts/thekraken \
  -f charts/thekraken/values-mirantis.yaml \
  --namespace tentacular-kraken --create-namespace \
  --set secrets.slackBotToken=... \
  ...
```

## Design Documents

- **Execution plan:** `~/.claude/plans/delightful-riding-shamir.md`
- **Phase 1 design (authoritative):** `openspec/changes/phase1-core-loop/design.md`
- **Detailed design (pre-pivot + pivot notice):** `scratch/kraken-pi-rewrite-plan.md`
- **Followups:** `scratch/kraken-v2-followups.md`
