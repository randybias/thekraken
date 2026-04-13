# The Kraken v2

**Status: Experimental** — Pi-based enclave-centric Slack bot for Tentacular.

The Kraken v2 is a complete rewrite of the Slack integration for the
[Tentacular](https://github.com/randybias/tentacular) platform, built on the
[pi agent toolkit](https://github.com/mariozechner/pi-mono). Every conversation
is scoped to an enclave (Kubernetes namespace + Slack channel + exoskeleton
workspace).

## Key Features

- Built on pi (`@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`,
  `@mariozechner/pi-coding-agent` v0.66.1)
- Enclave-centric: every conversation is scoped to an enclave
- Single OIDC auth via Keycloak device flow
- Git-backed state (hard requirement): every tentacle deploy is a monotonic
  integer version with git commit + tag
- LLM-agnostic: Anthropic Sonnet 4.6 default, OpenAI, Google Gemini supported

## Requirements

- Node.js 22+
- `GIT_STATE_REPO_URL` — required (Kraken refuses to start without it)

## Development

```bash
npm ci
npm run build
npm test
npx tsc --noEmit
npm run lint
npm run format:check
```

## Kubernetes Deployment

```bash
helm install thekraken ./charts/thekraken \
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

## Git-State Requirement

The Kraken v2 **requires** a git-backed state repository. Set
`GIT_STATE_REPO_URL` to a git repository URL. The Kraken will clone this repo
on startup and use it to track tentacle deployments with monotonic versioning.

## Architecture

See the design documents under `openspec/changes/` for full architectural
details.
