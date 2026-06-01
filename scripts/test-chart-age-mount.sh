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
  # existingSecret + oidc satisfy the chart's other required() guards so the
  # render reaches the age wiring under test.
  helm template thekraken "${CHART_DIR}" \
    --set gitState.repoUrl=https://github.com/test/repo.git \
    --set gitState.credentialsSecret=test-git-secret \
    --set secrets.existingSecret=test-secret \
    --set oidc.issuer=https://auth.test/realms/tentacular \
    --set oidc.clientId=thekraken \
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
