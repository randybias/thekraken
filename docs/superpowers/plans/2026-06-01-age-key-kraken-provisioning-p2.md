# Age Key Kraken Provisioning (P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision the age private key into the Kraken pod cleanly through the Helm chart, and ship `age`/`age-keygen` in the image, so dev-team `tntc deploy` and Kraken-mediated `tntc secrets` can decrypt/re-encrypt tentacle secrets in-cluster — honoring P1's `TENTACULAR_AGE_KEY_FILE=/app/.age/key.txt` contract exactly, committing no private key, lint + shellcheck + rendered-manifest assertions all green.

**Architecture:** Mirror the existing `git-credentials` mount pattern (operator-created k8s Secret, referenced by name, mounted read-only at `defaultMode: 0400`). A new `ageKey` values block gates a conditional volume/mount + env. The `age` + `age-keygen` binaries are added to the image via a pinned, arch-aware tarball download — mirroring the existing `tntc` download in the Dockerfile. Env flows through the existing ConfigMap → `envFrom` path; the entrypoint is untouched.

**Tech Stack:** Helm (chart `charts/thekraken`), Docker (`node:22` / Debian bookworm base), bash + shellcheck, `age` v1.3.1 (ADR-0001 in `tentacular`).

---

## Contracts honored (from P1 hand-back, do not change)

| Contract | Value |
|---|---|
| Private key path | `TENTACULAR_AGE_KEY_FILE`, default `/app/.age/key.txt` |
| Decrypt tooling | shells out to `age` / `age-keygen` on PATH (ADR-0001) |
| Secret content | k8s Secret with key `key.txt` = the age private key |
| Decrypt-required-but-key-missing | P1 fails loud; P2 only provides the key + binaries |

## Design decisions (locked with operator 2026-06-01)

1. **age install:** pinned binary download (`v1.3.1`), arch-aware, mirroring the `tntc` curl block — not `apt`. Matches P1's tested version, deterministic.
2. **Key Secret:** reference an **operator-created** `existingSecret` (mirrors `git-credentials`). Never create-from-value, never commit the key. Provisioning is a documented ops/release step.
3. **Mount:** mirror `git-credentials` exactly — secret volume, `defaultMode: 0400`, mounted read-only at the **directory** `/app/.age` so the Secret's `key.txt` lands at `/app/.age/key.txt`.
4. **Gating:** a new `ageKey.enabled` (default `false`) so installs without a provisioned key still render/lint/deploy. When disabled, P1's built-in default path applies and decrypt fails loud only if an actual `.age` secret is used.
5. **Per-cluster overlays:** add an **inert** (`enabled: false`) documented `ageKey` block to `values-eastus.yaml` / `values-mirantis.yaml`. Do NOT flip `enabled: true` — that is an ops step after the Secret is provisioned (eastus needs sign-off; nats-weu is validated in P5).

## Scope guardrails

- **No eastus cluster changes** — chart/values files only; no `helm upgrade`, no live Secret creation.
- **No commits or PRs without operator approval** (global CLAUDE.md + design process rule "no auto-merge"). Commit steps below are **user-gated checkpoints**.
- Chart version in `Chart.yaml` is intentionally **not** bumped here — version bumps are a release-process step, out of scope for this feature.
- Backwards compatibility: additive only (new `enabled: false` default → existing installs unchanged). No migration needed.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `scripts/test-chart-age-mount.sh` | Render-assertion test: enabled wiring present + 0400 + env; disabled = inert | Create |
| `charts/thekraken/values.yaml` | New `ageKey` block (defaults, `enabled: false`) | Modify |
| `charts/thekraken/values.schema.json` | Schema for `ageKey` | Modify |
| `charts/thekraken/templates/deployment.yaml` | Conditional `age-key` volume + read-only 0400 mount | Modify |
| `charts/thekraken/templates/configmap.yaml` | Conditional `TENTACULAR_AGE_KEY_FILE` env | Modify |
| `Dockerfile` | Pinned arch-aware `age` + `age-keygen` install | Modify |
| `charts/thekraken/values-eastus.yaml` | Inert documented `ageKey` block | Modify |
| `charts/thekraken/values-mirantis.yaml` | Inert documented `ageKey` block | Modify |
| `charts/thekraken/README.md` | Operator provisioning section | Modify |
| `.github/workflows/ci.yml` | shellcheck new script + run render test | Modify |

---

### Task 1: Failing render-assertion test

**Files:**
- Create: `scripts/test-chart-age-mount.sh`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-chart-age-mount.sh`:

```bash
#!/usr/bin/env bash
# Render-assertion test for the age private-key mount (P2).
# Asserts the chart wires the age key Secret -> read-only 0400 mount -> env
# when enabled, and leaves no age artifacts when disabled.
set -euo pipefail

CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../charts/thekraken" && pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

render() {
  helm template thekraken "${CHART_DIR}" \
    --set gitState.repoUrl=https://github.com/test/repo.git \
    --set gitState.credentialsSecret=test-git-secret \
    "$@"
}

# ── Enabled: full age wiring present ──────────────────────────────
enabled_manifest="$(render \
  --set ageKey.enabled=true \
  --set ageKey.existingSecret=tentacle-age-key)"

echo "${enabled_manifest}" | grep -q 'secretName: tentacle-age-key' \
  || fail "age-key volume not referencing existingSecret 'tentacle-age-key'"
echo "${enabled_manifest}" | grep -q 'name: age-key' \
  || fail "age-key volume/mount name missing"
echo "${enabled_manifest}" | grep -q 'mountPath: /app/.age' \
  || fail "age-key not mounted at /app/.age"
echo "${enabled_manifest}" | grep -Eq 'defaultMode: 0?400' \
  || fail "age-key Secret not mode 0400"
echo "${enabled_manifest}" | grep -A2 'name: age-key' | grep -q 'readOnly: true' \
  || fail "age-key mount is not readOnly"
echo "${enabled_manifest}" | grep -q 'TENTACULAR_AGE_KEY_FILE: "/app/.age/key.txt"' \
  || fail "TENTACULAR_AGE_KEY_FILE env not set to /app/.age/key.txt"

# ── Disabled: no age artifacts leak in ────────────────────────────
disabled_manifest="$(render)"
if echo "${disabled_manifest}" | grep -q 'age-key'; then
  fail "age-key artifacts present when ageKey.enabled=false"
fi
if echo "${disabled_manifest}" | grep -q 'TENTACULAR_AGE_KEY_FILE'; then
  fail "TENTACULAR_AGE_KEY_FILE set when ageKey.enabled=false"
fi

echo "PASS: age key mount render assertions"
```

- [ ] **Step 2: Make it executable + shellcheck clean**

Run:
```bash
chmod +x scripts/test-chart-age-mount.sh
shellcheck scripts/test-chart-age-mount.sh
```
Expected: shellcheck exits 0 (no findings).

- [ ] **Step 3: Run the test to verify it FAILS**

Run: `bash scripts/test-chart-age-mount.sh`
Expected: `FAIL: age-key volume not referencing existingSecret 'tentacle-age-key'` (chart has no `ageKey` support yet), exit 1.

- [ ] **Step 4: User-gated checkpoint — stage**

```bash
git add scripts/test-chart-age-mount.sh
```
Do NOT commit yet (global CLAUDE.md: commits only on operator approval). Commit grouped with Task 2 once green, when approved.

---

### Task 2: Chart wiring (volume + mount + env + values + schema)

**Files:**
- Modify: `charts/thekraken/values.yaml`
- Modify: `charts/thekraken/values.schema.json`
- Modify: `charts/thekraken/templates/deployment.yaml`
- Modify: `charts/thekraken/templates/configmap.yaml`
- Test: `scripts/test-chart-age-mount.sh`

- [ ] **Step 1: Add `ageKey` block to `values.yaml`**

Insert after the `gitState:` block (after `dir: '/app/data/git-state'`, currently line 119):

```yaml
# Age private key for tentacle-secret decryption (raw age, ADR-0001).
# The Kraken is the trusted agent and decrypts/re-encrypts $shared secrets
# in-pod. Provisioned as an operator/release step (k8s Secret), NEVER committed
# and NEVER set via Helm value. See README "Age private-key provisioning".
ageKey:
  enabled: false # flip true per-cluster ONLY after the Secret is provisioned
  existingSecret: '' # operator-created Secret; MUST contain key 'key.txt'
  # File path the key is mounted to; also TENTACULAR_AGE_KEY_FILE (P1 contract).
  # The mount dir is dirname(mountPath); the Secret's 'key.txt' lands here.
  mountPath: '/app/.age/key.txt'
```

- [ ] **Step 2: Add `ageKey` to `values.schema.json`**

Insert a new property after the `gitState` block (after its closing `}` at line 75, before `"llm"`):

```json
    "ageKey": {
      "type": "object",
      "description": "Age private key mount for tentacle-secret decryption. Key is operator-provisioned, never committed.",
      "properties": {
        "enabled": { "type": "boolean" },
        "existingSecret": {
          "type": "string",
          "description": "Operator-created Secret containing key 'key.txt'. Required when enabled."
        },
        "mountPath": {
          "type": "string",
          "description": "In-pod path for the private key; also TENTACULAR_AGE_KEY_FILE."
        }
      }
    },
```

- [ ] **Step 3: Add the conditional volume + mount to `deployment.yaml`**

In the `volumeMounts:` list (after the `git-credentials` mount, currently lines 59–61), add:

```yaml
            {{- if .Values.ageKey.enabled }}
            - name: age-key
              mountPath: {{ dir .Values.ageKey.mountPath | default "/app/.age" }}
              readOnly: true
            {{- end }}
```

In the `volumes:` list (after the `git-credentials` volume, currently lines 70–73), add:

```yaml
        {{- if .Values.ageKey.enabled }}
        - name: age-key
          secret:
            secretName: {{ required "ageKey.existingSecret is required when ageKey.enabled=true" .Values.ageKey.existingSecret }}
            defaultMode: 0400
        {{- end }}
```

- [ ] **Step 4: Add the conditional env to `configmap.yaml`**

At the end of the `data:` map (after `LOG_LEVEL`, currently line 42), add:

```yaml
  # Age private-key path — tntc reads the mounted key here to decrypt
  # $shared tentacle secrets (P1 contract). Only set when the key is mounted.
  {{- if .Values.ageKey.enabled }}
  TENTACULAR_AGE_KEY_FILE: {{ .Values.ageKey.mountPath | default "/app/.age/key.txt" | quote }}
  {{- end }}
```

- [ ] **Step 5: Run the render-assertion test to verify it PASSES**

Run: `bash scripts/test-chart-age-mount.sh`
Expected: `PASS: age key mount render assertions`

- [ ] **Step 6: Run helm lint (both default and enabled)**

Run:
```bash
helm lint charts/thekraken \
  --set gitState.repoUrl=https://github.com/test/repo.git \
  --set gitState.credentialsSecret=test-secret
helm lint charts/thekraken \
  --set gitState.repoUrl=https://github.com/test/repo.git \
  --set gitState.credentialsSecret=test-secret \
  --set ageKey.enabled=true --set ageKey.existingSecret=tentacle-age-key
```
Expected: both `1 chart(s) linted, 0 chart(s) failed`.

- [ ] **Step 7: Verify `required()` fires when enabled without a Secret**

Run:
```bash
helm template thekraken charts/thekraken \
  --set gitState.repoUrl=https://github.com/test/repo.git \
  --set gitState.credentialsSecret=test-secret \
  --set ageKey.enabled=true 2>&1 | grep -q 'ageKey.existingSecret is required' \
  && echo "OK: required() fires" || echo "MISSING required() guard"
```
Expected: `OK: required() fires`.

- [ ] **Step 8: User-gated checkpoint — stage + commit (on approval)**

```bash
git add charts/thekraken/values.yaml charts/thekraken/values.schema.json \
  charts/thekraken/templates/deployment.yaml charts/thekraken/templates/configmap.yaml \
  scripts/test-chart-age-mount.sh
# On operator approval:
git commit -m "feat(chart): mount operator-provisioned age key for tentacle-secret decryption"
```

---

### Task 3: Ship `age` + `age-keygen` in the image

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Add the pinned age install block**

Insert after the `tntc` download block (currently ends line 38, before `# Bundle skills`):

```dockerfile
# Download age + age-keygen (arch-aware, pinned). P1 shells out to these
# (ADR-0001 in tentacular) to encrypt/decrypt tentacle secrets in-pod; the
# Kraken pod's `tntc deploy`/`tntc secrets` fail loud without them on PATH.
ARG AGE_VERSION=v1.3.1
RUN AGE_ARCH="${TARGETARCH}" \
  && curl -fsSL "https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/age-${AGE_VERSION}-linux-${AGE_ARCH}.tar.gz" -o /tmp/age.tar.gz \
  && tar -xzf /tmp/age.tar.gz -C /tmp \
  && install -m 0755 /tmp/age/age /usr/local/bin/age \
  && install -m 0755 /tmp/age/age-keygen /usr/local/bin/age-keygen \
  && rm -rf /tmp/age /tmp/age.tar.gz \
  && age --version && age-keygen --version
```

(`TARGETARCH` is already declared as an `ARG` earlier for the tntc download and remains in scope for this single-stage build.)

- [ ] **Step 2: Build smoke test (single-arch, local)**

> Heavy step (~minutes: npm ci + tsc). Operator may run this in a separate window and report back.

Run:
```bash
docker build \
  --build-arg TARGETARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
  -t thekraken-age-smoke .
docker run --rm --entrypoint age thekraken-age-smoke --version
docker run --rm --entrypoint age-keygen thekraken-age-smoke --version
```
Expected: build succeeds; both commands print a version line (e.g. `v1.3.1`).

- [ ] **Step 3: User-gated checkpoint — stage + commit (on approval)**

```bash
git add Dockerfile
# On operator approval:
git commit -m "feat(image): ship age + age-keygen for in-pod tentacle-secret crypto"
```

---

### Task 4: Per-cluster overlays + operator README

**Files:**
- Modify: `charts/thekraken/values-eastus.yaml`
- Modify: `charts/thekraken/values-mirantis.yaml`
- Modify: `charts/thekraken/README.md`

- [ ] **Step 1: Add inert `ageKey` block to `values-eastus.yaml`**

Append:

```yaml
# Age private key for tentacle-secret decryption. INERT until ops provisions
# the Secret with sign-off (eastus is production). After creating the
# 'tentacle-age-key' Secret (key 'key.txt'), flip enabled: true.
ageKey:
  enabled: false
  existingSecret: 'tentacle-age-key'
```

- [ ] **Step 2: Add inert `ageKey` block to `values-mirantis.yaml`**

Append:

```yaml
# Age private key for tentacle-secret decryption. INERT until ops provisions
# the 'tentacle-age-key' Secret (key 'key.txt'), then flip enabled: true.
# nats-weu (E2E) is validated first (P5), eastus only after sign-off.
ageKey:
  enabled: false
  existingSecret: 'tentacle-age-key'
```

- [ ] **Step 3: Add operator provisioning section to `charts/thekraken/README.md`**

Add a new section (place near the gitState/secrets documentation):

```markdown
### Age private-key provisioning (tentacle secrets)

The Kraken decrypts tentacle `$shared` secrets in-pod using raw `age`
(ADR-0001 in `tentacular`). This requires the git-state repo's **private**
age key mounted into the pod. The key is **never committed** and **never set
via a Helm value** — provision it as an operator/release step:

1. Create the Secret (one per cluster; encrypts to the recipient committed at
   `.age/recipients.txt` in the git-state repo). The Secret **must** contain a
   key named `key.txt`:

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
```

- [ ] **Step 4: Re-run helm lint with each overlay**

Run:
```bash
helm lint charts/thekraken -f charts/thekraken/values-eastus.yaml \
  --set gitState.repoUrl=https://github.com/test/repo.git \
  --set gitState.credentialsSecret=test-secret
helm lint charts/thekraken -f charts/thekraken/values-mirantis.yaml \
  --set gitState.repoUrl=https://github.com/test/repo.git \
  --set gitState.credentialsSecret=test-secret
```
Expected: both `0 chart(s) failed`.

- [ ] **Step 5: User-gated checkpoint — stage + commit (on approval)**

```bash
git add charts/thekraken/values-eastus.yaml charts/thekraken/values-mirantis.yaml \
  charts/thekraken/README.md
# On operator approval:
git commit -m "docs(chart): document age key provisioning + stage per-cluster overlays"
```

---

### Task 5: CI wiring + full verification sweep

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the render test + shellcheck to CI**

In `.github/workflows/ci.yml`, extend the Shellcheck step (currently lines 39–42) to include the new script, and add a render-assertion step after the existing `helm lint` (line 37):

```yaml
      - name: Helm chart render assertions
        run: bash scripts/test-chart-age-mount.sh
```

Update the shellcheck line to:
```yaml
          shellcheck scripts/entrypoint.sh kraken-hooks/pre-commit scripts/test-chart-age-mount.sh
```

- [ ] **Step 2: Full local verification sweep**

Run (all must be green):
```bash
shellcheck scripts/entrypoint.sh kraken-hooks/pre-commit scripts/test-chart-age-mount.sh
bash scripts/test-chart-age-mount.sh
helm lint charts/thekraken \
  --set gitState.repoUrl=https://github.com/test/repo.git \
  --set gitState.credentialsSecret=test-secret
```
Expected: shellcheck 0 findings; `PASS: age key mount render assertions`; `0 chart(s) failed`.

- [ ] **Step 3: User-gated checkpoint — stage + commit (on approval)**

```bash
git add .github/workflows/ci.yml
# On operator approval:
git commit -m "ci: lint + run age key chart render assertions"
```

- [ ] **Step 4: Hand back to ops**

Use `randyb-handoff` to write a return doc to `scratch/handoffs/` recording: the Secret name (`tentacle-age-key`) + key (`key.txt`), mount path (`/app/.age/key.txt`), env var (`TENTACULAR_AGE_KEY_FILE`), the `ageKey.enabled`/`existingSecret` values knobs, the age version pinned (`v1.3.1`), and the exact `kubectl create secret` provisioning command ops must run on nats-weu (then eastus with sign-off). PR open is operator-gated — do not auto-open.

---

## Self-Review

**Spec coverage (handoff deliverables 0–5):**
- D0 (ship `age`/`age-keygen`) → Task 3.
- D1 (k8s Secret holding the key) → operator-provisioned `existingSecret`; chart references it (Task 2 volume) + README documents creation (Task 4).
- D2 (read-only 0400 mount at `/app/.age/key.txt`) → Task 2 Step 3 + asserted Task 1.
- D3 (`TENTACULAR_AGE_KEY_FILE`) → Task 2 Step 4 + asserted Task 1.
- D4 (per-cluster values + documented provisioning) → Task 4.
- D5 (no private key committed) → existingSecret reference; README explicit. No key material anywhere in the diff.
- Testing (helm lint, shellcheck, render assertions) → Tasks 1, 2, 4, 5.

**Type/name consistency:** volume + mount name `age-key`; values keys `ageKey.enabled` / `ageKey.existingSecret` / `ageKey.mountPath`; Secret key `key.txt`; env `TENTACULAR_AGE_KEY_FILE` = `/app/.age/key.txt`; age `v1.3.1`. Consistent across all tasks and the test assertions.

**Placeholder scan:** none — every step has concrete code/commands and expected output.

**Open risk to confirm at execution:** `helm template` emits the literal `defaultMode: 0400` from the template text (not reserialized), so the `0?400` regex matches; if a future helm reserializes to `256`, the regex already covers `400` but not `256` — revisit only if the assertion fails.
