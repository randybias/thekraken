# thekraken Helm Chart

Deploys The Kraken to Kubernetes.

## Required Values

These values must be set. `helm install` or `helm template` will fail with
a clear error if any are missing.

| Value                        | Source       | Notes                                        |
| ---------------------------- | ------------ | -------------------------------------------- |
| `gitState.repoUrl`           | ConfigMap    | Git-backed state repo URL (mandatory)        |
| `gitState.credentialsSecret` | Volume mount | K8s Secret name with key `token` (HTTPS PAT) |
| `secrets.slackBotToken`      | Secret       | Slack bot OAuth token (`xoxb-...`)           |
| `secrets.slackSigningSecret` | Secret       | Required when `slack.mode=http`              |
| `secrets.slackAppToken`      | Secret       | Required when `slack.mode=socket`            |
| `mcp.url`                    | ConfigMap    | Tentacular MCP server URL                    |
| `oidc.issuer`                | ConfigMap    | Keycloak realm URL                           |
| `oidc.clientId`              | ConfigMap    | OIDC client ID                               |

## Optional Values

| Value                        | Default                   | Notes                                         |
| ---------------------------- | ------------------------- | --------------------------------------------- |
| `slack.mode`                 | `http`                    | `http` (Events API) or `socket` (Socket Mode) |
| `gitState.branch`            | `main`                    | Git branch to clone/pull                      |
| `gitState.dir`               | `/app/data/git-state`     | Local clone path                              |
| `gitState.userName`          | `The Kraken`              | Git commit identity                           |
| `gitState.userEmail`         | `kraken@tentacular.dev`   | Git commit email                              |
| `teamsDir`                   | `/app/data/teams`         | Per-enclave team state directory              |
| `llm.defaultProvider`        | `anthropic`               | `anthropic`, `openai`, `google`               |
| `llm.defaultModel`           | `claude-sonnet-4-6`       | Default LLM model                             |
| `llm.allowedProviders`       | `anthropic,openai,google` | Comma-separated                               |
| `llm.disallowedModels`       | `gpt-4o,o3,...`           | Quality-gated denylist                        |
| `observability.otlpEndpoint` | _(empty)_                 | OTLP HTTP endpoint (empty = OTel disabled)    |
| `observability.logLevel`     | `info`                    | Pino log level                                |
| `replicaCount`               | `1`                       | Single pod (no HA)                            |
| `persistence.size`           | `1Gi`                     | PVC size for data + teams + git-state         |

## Installation

```bash
helm install thekraken ./charts/thekraken \
  --namespace tentacular-kraken --create-namespace \
  --set secrets.slackBotToken=xoxb-... \
  --set secrets.slackSigningSecret=... \
  --set secrets.anthropicApiKey=sk-ant-... \
  --set mcp.url=http://tentacular-mcp:8080 \
  --set oidc.issuer=https://keycloak/realms/tentacular \
  --set oidc.clientId=thekraken \
  --set secrets.oidcClientSecret=... \
  --set gitState.repoUrl=https://github.com/org/workflows.git \
  --set gitState.credentialsSecret=thekraken-git-state
```

For Mirantis deployment:

```bash
helm install thekraken ./charts/thekraken \
  -f charts/thekraken/values-mirantis.yaml \
  --namespace tentacular-kraken --create-namespace \
  --set secrets.slackBotToken=... ...
```

## Validation

```bash
helm lint charts/thekraken \
  --set gitState.repoUrl=https://github.com/x/y.git \
  --set gitState.credentialsSecret=test-secret \
  --set secrets.slackBotToken=xoxb-x \
  --set secrets.slackSigningSecret=x \
  --set oidc.issuer=https://kc \
  --set oidc.clientId=k \
  --set mcp.url=http://mcp:8080 \
```
