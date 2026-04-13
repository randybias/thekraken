# Single-stage: node:22 (bookworm) — needed for better-sqlite3 native compilation
# Multi-stage would save image size but ARM64 cross-compilation of native modules
# is fragile. Single-stage is reliable on both amd64 and arm64.
FROM node:22

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Disable husky (not used in v2, but prevents accidental npm lifecycle issues)
ENV HUSKY=0

COPY package*.json ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

# Prune to production deps only (keeps compiled .node native modules)
RUN npm prune --omit=dev

# Remove source and dev artifacts
RUN rm -rf src/ tsconfig.json

# Download tntc CLI binary (arch-aware via Docker TARGETARCH build arg)
ARG TNTC_VERSION=latest
ARG TARGETARCH
RUN if [ "$TNTC_VERSION" = "latest" ]; then \
      TNTC_VERSION=$(curl -fsSL https://api.github.com/repos/randybias/tentacular/releases/latest | grep '"tag_name"' | sed 's/.*"tag_name": *"\(.*\)".*/\1/'); \
    fi \
  && TNTC_ARCH="${TARGETARCH}" \
  && curl -fsSL "https://github.com/randybias/tentacular/releases/download/${TNTC_VERSION}/tntc_linux_${TNTC_ARCH}" -o /usr/local/bin/tntc \
  && chmod +x /usr/local/bin/tntc

# Bundle skills
COPY skills/ /app/skills/

# Entrypoint + hooks
COPY scripts/entrypoint.sh /app/scripts/entrypoint.sh
RUN chmod +x /app/scripts/entrypoint.sh
COPY kraken-hooks/ /app/kraken-hooks/
RUN chmod +x /app/kraken-hooks/pre-commit

# Data directory — owned by node user
RUN mkdir -p /app/data /app/data/workspaces && chown -R node:node /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Run as non-root node user (UID 1000)
USER node

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
