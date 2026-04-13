#!/usr/bin/env bash
set -euo pipefail

# ─── tntc config ───────────────────────────────────────────────
TNTC_HOME="${HOME}/.tentacular"
mkdir -p "${TNTC_HOME}"

if [ -n "${TENTACULAR_MCP_URL:-}" ]; then
  cat > "${TNTC_HOME}/config.yaml" <<EOF
environments:
    default:
        mcp_endpoint: ${TENTACULAR_MCP_URL:-}
        oidc_issuer: ${OIDC_ISSUER:-}
        oidc_client_id: ${OIDC_CLIENT_ID:-}
default_env: default
registry: ${TNTC_REGISTRY:-ghcr.io/randybias}
workspace: /app/data/workspaces
EOF
elif [ ! -f "${TNTC_HOME}/config.yaml" ]; then
  echo "WARNING: TENTACULAR_MCP_URL not set and no existing config found" >&2
fi

mkdir -p /app/data/workspaces

# ─── REMOVED: Claude session symlink (NanoClaw artifact) ──────
# ─── REMOVED: Sender allowlist migration (NanoClaw artifact) ──

# ─── Git-backed state (MANDATORY in v2) ───────────────────────
# No GIT_STATE_ENABLED toggle. Always required.

if [ -z "${GIT_STATE_REPO_URL:-}" ]; then
  echo "FATAL: GIT_STATE_REPO_URL is required but not set. The Kraken refuses to start without git-state." >&2
  exit 1
fi

GIT_STATE_DIR="${GIT_STATE_DIR:-/app/data/git-state}"

git config --global user.name "${GIT_STATE_USER_NAME:-The Kraken}"
git config --global user.email "${GIT_STATE_USER_EMAIL:-kraken@tentacular.dev}"

if [ -f /app/.git-credentials/token ]; then
  # shellcheck disable=SC2016
  # SC2016: Single quotes intentional — git executes this as a shell expression.
  # $(cat ...) must NOT expand here; git evaluates it at credential-prompt time.
  git config --global credential.helper \
    '!f() { echo "username=token"; echo "password=$(cat /app/.git-credentials/token)"; }; f'
fi

if [ -d "${GIT_STATE_DIR}/.git" ]; then
  # Hard fail on pull failure (no stale-copy fallback)
  if ! (cd "${GIT_STATE_DIR}" && git pull --ff-only origin "${GIT_STATE_BRANCH:-main}"); then
    echo "FATAL: git pull failed for state repo. The Kraken refuses to start with stale state." >&2
    exit 1
  fi
else
  # Hard fail on clone failure
  if ! git clone --branch "${GIT_STATE_BRANCH:-main}" "${GIT_STATE_REPO_URL}" "${GIT_STATE_DIR}"; then
    echo "FATAL: git clone failed for ${GIT_STATE_REPO_URL}. The Kraken cannot start." >&2
    exit 1
  fi
fi

# Set hooks path to kraken-hooks (version bump on commit)
git -C "${GIT_STATE_DIR}" config core.hooksPath /app/kraken-hooks

# Append git_state to tntc config
cat >> "${TNTC_HOME}/config.yaml" <<EOF
git_state:
    repo_path: ${GIT_STATE_DIR}
    enabled: true
EOF

exec node dist/index.js "$@"
