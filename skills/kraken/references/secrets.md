# Tentacle Secrets — How They Work

This reference covers the end-to-end secrets mechanism for tentacles. Read
this when:

- A builder or deployer needs to provision credentials for a new tentacle
- A tentacle run fails with empty/missing secret values
- You are reviewing tentacle source for hardcoded credentials
- A user asks how to pass an API key or token to a tentacle

---

## The Three Layers

### Layer 1 — Contract declaration (`workflow.yaml`)

Every credential a tentacle needs must be declared in its contract:

```yaml
contract:
  dependencies:
    openai-api:
      protocol: https
      host: api.openai.com
      port: 443
      auth: { type: api-token, secret: openai.api_key }   # group.subkey
    slack:
      protocol: https
      host: slack.com
      port: 443
      auth: { type: api-token, secret: slack.bot_token }
```

The `secret` field is `<group>.<subkey>`. The group names the shared secret
file; the subkey names the JSON field inside it.

### Layer 2 — Per-tentacle `.secrets.yaml`

This file lives inside the tentacle directory in the git-state repo. It is a
**flat map** of `<group>: $shared.<group>` references — nothing else.

```yaml
openai: $shared.openai
slack: $shared.slack
```

Rules that `tntc deploy` enforces:

- Every value MUST be a `$shared.<name>` reference. Direct values (e.g.
  `openai: sk-proj-...`) are **rejected with an error**.
- There is NO `secrets:` wrapper key. The map is flat at the top level.
- Only groups that appear in `workflow.yaml` dependencies need entries.

### Layer 3 — Workspace-root shared values

Shared secrets live at `<workspace>/.secrets/<group>` (workspace = `~/tentacles`,
or wherever `workspace:` points in `~/.tentacular/config.yaml`). These files
are git-ignored and owned `0600`. Each file contains JSON keyed by subkey:

```
~/tentacles/.secrets/openai      -> {"api_key":"sk-proj-..."}
~/tentacles/.secrets/slack       -> {"bot_token":"xoxb-...","webhook_url":"https://..."}
~/tentacles/.secrets/anthropic   -> {"api_key":"sk-ant-..."}
~/tentacles/.secrets/azure       -> {"sas_token":"sv=..."}
```

`tntc deploy` resolves each `$shared.<name>` reference by reading the
corresponding file, JSON-parsing it, and building a Kubernetes Secret with one
key per top-level `.secrets.yaml` entry. The k8s Secret is mounted at
`/app/secrets/` inside the workflow pod.

The engine loads each mounted file and makes it available as a nested object:
`secrets["openai"]["api_key"]`. A JSON file becomes a nested object; a plain
string file becomes `{value: "..."}`.

---

## Correct Node Code Pattern

Read secrets via `ctx.dependency("<dep-name>").secret`. **Never** hardcode a
credential or fall back to a literal value:

```ts
// CORRECT (AGENSYS notify-slack pattern)
const slack = ctx.dependency("slack");
if (!slack.secret) {
  ctx.log.error("No slack.bot_token — check .secrets.yaml and ~/tentacles/.secrets/slack");
  return { success: false, error: "missing slack.bot_token" };
}
await globalThis.fetch("https://slack.com/api/chat.postMessage", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${slack.secret}`,
  },
  body: JSON.stringify({ channel, text }),
});

// WRONG — never do this
const apiKey = process.env.OPENAI_API_KEY || "sk-proj-hardcoded";
```

---

## Posting to Slack from a Tentacle

Declare a `slack` dependency in the contract (see Layer 1 above). In node
code, use `ctx.dependency("slack")` and call `chat.postMessage` directly.

**NEVER write to `outbound.ndjson` from workflow code.** That file is
Kraken-internal (dispatcher to Slack bridge) and is NOT mounted in the
workflow pod. Workflow pods have no access to it, and attempting to write
there silently produces nothing.

---

## Failure Modes to Know

| Symptom | Root cause |
|---------|-----------|
| Node returns `success: true` but does nothing | `ctx.dependency(...).secret` resolved to `undefined` — secret group missing or `.secrets.yaml` wrong |
| `tntc deploy` errors: "all secrets must use $shared" | Direct value in `.secrets.yaml` (e.g. `openai: sk-proj-...`) |
| `tntc deploy` errors: "unknown reference" | `$shared.openai` referenced but `~/tentacles/.secrets/openai` does not exist |
| Secret resolves but subkey is `undefined` | File at `.secrets/openai` is not JSON, or the subkey name doesn't match (e.g. `api-key` vs `api_key`) |
| Slack post silently fails | `outbound.ndjson` path used from workflow code (not mounted) |

---

## Provisioning Checklist (before commissioning a builder)

Before commissioning a dev team for a tentacle that needs credentials, confirm:

1. The workspace-root shared file exists:
   `ls -la ~/tentacles/.secrets/<group>`
2. It contains the expected JSON key:
   `cat ~/tentacles/.secrets/<group> | jq .`
3. The contract `auth.secret` value matches `<group>.<subkey>` exactly
   (case-sensitive, dot-separated, no spaces).
4. The `.secrets.yaml` entry uses `$shared.<group>` (no direct values,
   no `secrets:` wrapper).

If any of these are missing, provision the shared secret BEFORE commissioning
the builder. Ask the user for the credential value; do not invent or guess it.
