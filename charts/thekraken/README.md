# thekraken Helm Chart

Deploys The Kraken v2 to Kubernetes.

## Required Values

These values must be set. `helm install` or `helm template` will fail with
a clear error if any are missing.

| Value | Source | Notes |
|-------|--------|-------|
| `gitState.repoUrl` | ConfigMap | Git-backed state repo URL (mandatory) |
| `gitState.credentialsSecret` | Volume mount | K8s Secret name with key `token` (HTTPS PAT) |
| `secrets.slackBotToken` | Secret | Slack bot OAuth token (`xoxb-...`) |
| `secrets.slackSigningSecret` | Secret | Required when `slack.mode=http` |
| `secrets.slackAppToken` | Secret | Required when `slack.mode=socket` |
| `mcp.url` | ConfigMap | Tentacular MCP server URL |
| `oidc.issuer` | ConfigMap | Keycloak realm URL |
| `oidc.clientId` | ConfigMap | OIDC client ID |
| `tokenEncryption.secretName` | Secret ref | K8s Secret containing the AES-256-GCM encryption key for OIDC tokens at rest |

## Token Encryption Setup

The Kraken encrypts OIDC tokens at rest in SQLite. You must provide a
32-byte AES-256-GCM key via a Kubernetes Secret.

```bash
# Generate a 32-byte hex key
KEY=$(openssl rand -hex 32)

# Store the key in your organization's secrets management system
# (this is YOUR infrastructure — Tentacular does not manage this key)

# Create the K8s Secret
kubectl create secret generic thekraken-token-encryption \
  --from-literal=token-encryption-key="$KEY" \
  -n tentacular-kraken

# Verify the secret exists
kubectl get secret thekraken-token-encryption -n tentacular-kraken
```

Then in your Helm values:
```yaml
tokenEncryption:
  secretName: thekraken-token-encryption
  key: token-encryption-key
```

### Key Recovery Warning

**If you lose this key, all stored OIDC tokens become unreadable.** Users
will need to re-authenticate via the device flow. The key does NOT live in
the Kraken repo, the PVC, or the SQLite database — it exists only in:

1. Your secrets management system (e.g., `secrets get thekraken/encryption/token-key`)
2. The K8s Secret in the cluster

**Back up the key** to your secrets system (or wherever your organization
stores infrastructure credentials). This is NOT a Tentacular or Kraken
concern — it is operator infrastructure, like TLS certificates or database
passwords. Tentacular and the Kraken never manage this key; they only
consume it at runtime.

If the key is lost and users need to re-authenticate, the impact is:
- All cached OIDC tokens are invalidated (users get re-auth prompts)
- No data loss (tentacle source is in git, enclave metadata is in K8s)
- No security incident (the old tokens are encrypted with a key nobody has)

## Optional Values

| Value | Default | Notes |
|-------|---------|-------|
| `slack.mode` | `http` | `http` (Events API) or `socket` (Socket Mode) |
| `gitState.branch` | `main` | Git branch to clone/pull |
| `gitState.dir` | `/app/data/git-state` | Local clone path |
| `gitState.userName` | `The Kraken` | Git commit identity |
| `gitState.userEmail` | `kraken@tentacular.dev` | Git commit email |
| `teamsDir` | `/app/data/teams` | Per-enclave team state directory |
| `llm.defaultProvider` | `anthropic` | `anthropic`, `openai`, `google` |
| `llm.defaultModel` | `claude-sonnet-4-6` | Default LLM model |
| `llm.allowedProviders` | `anthropic,openai,google` | Comma-separated |
| `llm.disallowedModels` | `gpt-4o,o3,...` | Quality-gated denylist |
| `observability.otlpEndpoint` | _(empty)_ | OTLP HTTP endpoint (empty = OTel disabled) |
| `observability.logLevel` | `info` | Pino log level |
| `replicaCount` | `1` | Single pod (no HA) |
| `persistence.size` | `1Gi` | PVC size for data + teams + git-state |

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
