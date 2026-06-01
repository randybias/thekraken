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
| `ageKey.enabled`             | `false`                   | Mount the age private key (see below)         |
| `ageKey.existingSecret`      | _(empty)_                 | Operator-created Secret with key `key.txt`    |
| `ageKey.mountPath`           | `/app/.age/key.txt`       | In-pod key path; also `TENTACULAR_AGE_KEY_FILE` |
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

## Age private-key provisioning (tentacle secrets)

The Kraken decrypts tentacle `$shared` secrets in-pod using raw `age`
(ADR-0001 in `tentacular`). This requires the git-state repo's **private**
age key mounted into the pod. The key is **never committed** and **never set
via a Helm value** — provision it as an operator/release step:

1. Create the Secret (one per cluster; it must decrypt to the recipient
   committed at `.age/recipients.txt` in the git-state repo). The Secret
   **must** contain a key named `key.txt`:

   ```bash
   kubectl create secret generic tentacle-age-key \
     --from-file=key.txt=/path/to/age-private-key.txt \
     -n <kraken-namespace>
   ```

2. Enable the mount in your per-cluster values:

   ```yaml
   ageKey:
     enabled: true
     existingSecret: tentacle-age-key
   ```

The chart mounts the Secret read-only (`0400`) at `/app/.age/key.txt` and sets
`TENTACULAR_AGE_KEY_FILE` to match, so `tntc deploy` / `tntc secrets` can
decrypt/re-encrypt in-pod. When `ageKey.enabled` is false the key is absent and
decryption fails loud only if an encrypted secret is actually used.

The `age` and `age-keygen` binaries are baked into the image (pinned
`v1.3.1`), which `tntc` shells out to (ADR-0001).
