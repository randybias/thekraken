#!/usr/bin/env bash
# Run the e2e-slack test suite against the nats-weu Kraken deployment.
#
# Naming note: "nats-weu" is the development support cluster hosted on the
# rdev `nats-westeurope` VM (8-core, runs NATS server + tentacular platform).
# Distinct from the rdev `westeurope` VM (4-core dev box, no platform).
# The DNS subdomain `westeurope-dev1.ospo-dev.miralabs.dev` is the historical
# domain for the platform on this VM and stays as-is.
#
# Usage:
#   ./scripts/run-e2e-nats-weu.sh              # run all scenarios
#   ./scripts/run-e2e-nats-weu.sh A1            # run a single scenario
#   KRAKEN_E2E_DRY_RUN=1 ./scripts/run-e2e-nats-weu.sh  # dry-run (no real Slack)
#
# Prerequisites:
#   - ~/.kube/configs/nats-admin.kubeconfig must exist (nats-westeurope cluster)
#   - secrets CLI must be available with tentacular/nats-weu/* secrets populated
#   - The Kraken OIDC session for the e2e user must be active
#     (re-auth by messaging @Kraken in Slack if tests time out with 0 replies)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

export KRAKEN_E2E_USER_SECRET="tentacular/nats-weu/e2e-user-token"
export KRAKEN_E2E_BOT_SECRET="tentacular/nats-weu/kraken-slack-bot-token"
export KUBECONFIG="${KUBECONFIG:-${HOME}/.kube/configs/nats-admin.kubeconfig}"

# Pass through optional single-scenario argument
if [[ $# -gt 0 ]]; then
  export KRAKEN_E2E_SCENARIO="$1"
fi

cd "${REPO_DIR}"
exec npm run test:e2e-slack -- ${KRAKEN_E2E_SCENARIO:+--scenario "${KRAKEN_E2E_SCENARIO}"}
