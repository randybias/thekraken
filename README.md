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

### Slack Block Kit Layer

All outbound messages use structured Slack Block Kit rather than plain text:

- **Block Kit formatter** (`src/slack/formatter.ts`) — converts Markdown
  agent responses to Block Kit sections, code blocks, tables, and lists.
  Handles 50-block batching for long outputs.
- **Structured cards** (`src/slack/cards.ts`) — purpose-built cards for
  enclave list, workflow status, health summary, and auth prompts.
- **Home Tab** (`src/slack/home-tab.ts`) — Slack App Home surface showing
  the user's enclaves with health indicators, roles, and Chroma deep links.
  Authenticated users see live data; unauthenticated users see a login prompt.

### Git-State Deploy + Rollback

Tentacle deployments are git-backed. The Kraken writes workflow YAML to
the git-state repo, tags it, and calls `wf_apply` on the MCP server.

- **Deploy** (`src/git-state/deploy.ts`) — validates a human-readable
  explanation (10-80 chars, no infra jargon), commits, monotonically tags
  `{tentacle}-v{N}`, calls `wf_apply`, records in SQLite.
- **Rollback** (`src/git-state/rollback.ts`) — checks out a prior tag's
  directory tree, lets the pre-commit hook bump the version, calls `wf_apply`.
- **Deployment tracking** (`src/git-state/deployments-db.ts`) — SQLite
  `deployments` table with status, git SHA, and human summary.

### Drift Detection

The enclave membership drift detector compares MCP enclave member lists
against Slack channel rosters. Active with real Slack adapters as of Phase 4.
Posts ephemeral corrections into affected channels.

### Current Status

Phase 4 complete. The Kraken has a full Block Kit UI layer, git-backed
deploy/rollback flow, drift detection wiring, and a live Slack Home Tab.
The smart path (LLM-powered reasoning) is still a Phase 3 placeholder.

No service token concept in this system (D6). Every MCP call carries the
authenticated user's OIDC token. Drift detection uses the service config
token (the single D6 exception — drift is a background process with no
user-specific action).

## Environment Variables

### Required

| Variable | Purpose |
|----------|---------|
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack signing secret (HTTP mode only) |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-...`, Socket mode only) |
| `OIDC_ISSUER` | Keycloak realm URL |
| `OIDC_CLIENT_ID` | OIDC client ID |
| `TENTACULAR_MCP_URL` | Tentacular MCP server URL |
| `GIT_STATE_REPO_URL` | Git-backed state repository URL (hard requirement) |
| `KRAKEN_TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for encrypting OIDC tokens at rest. Generate: `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | Required if defaultProvider is anthropic |

### Optional

| Variable | Default | Purpose |
|----------|---------|---------|
| `OIDC_CLIENT_SECRET` | _(none)_ | Only needed for confidential Keycloak clients. Public clients (device flow) do not need this. |
| `SLACK_MODE` | `http` | `http` (Events API, production) or `socket` (dev) |
| `GIT_STATE_BRANCH` | `main` | Branch to clone/pull |
| `GIT_STATE_DIR` | `/app/data/git-state` | Local clone directory |
| `KRAKEN_TEAMS_DIR` | `/app/data/teams` | Per-enclave team state directory |
| `AUTHZ_CACHE_TTL_MS` | `60000` | Enclave info cache TTL for authorization |
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
npm test             # 742 tests (unit + integration + scenarios)
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
