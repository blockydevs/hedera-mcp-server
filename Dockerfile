FROM node:24.22.1-trixie-slim AS builder

WORKDIR /app

COPY package.json package-lock.json /app/

RUN npm ci

# Copy source and build
COPY . /app/
RUN npm run build && npm prune --omit=dev


FROM node:24.22.1-trixie-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Node bundles its own Brotli, so the pinned base is the CVE-2026-111497 fix. The upgrade picks up
# patched Debian libraries (libbrotli1 among them) that the base image may predate.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# Copy built assets and production dependencies
COPY --chown=node:node --from=builder /app/package.json /app/package-lock.json /app/
COPY --chown=node:node --from=builder /app/dist /app/dist
COPY --chown=node:node --from=builder /app/node_modules /app/node_modules
COPY --chown=node:node --from=builder /app/LICENSE /app/NOTICE /app/
COPY --chown=node:node --from=builder /app/licenses /app/licenses
COPY --chown=node:node --from=builder /app/assets/fonts/OFL.txt /app/assets/fonts/README.md /app/assets/fonts/

# /app is created by WORKDIR as root; the process runs as `node`. Give the unprivileged user
# ownership of the workdir (state lives in Postgres, not on disk).
RUN chown -R node:node /app

USER node

# Expose the default MCP port
EXPOSE 3001

# Schema is owned by migrations (synchronize is off by default). Either run them as a separate
# deploy step (`docker run --rm --entrypoint npm <image> run typeorm migration:run`, or a k8s Job /
# initContainer), or set DB_MIGRATIONS_RUN=true to apply pending migrations at startup
# (single-instance only).

# Start the server in returnBytes mode as per the package.json start script
ENTRYPOINT ["node", "dist/main.js", "--agent-mode=returnBytes"]
CMD ["--ledger-id=testnet"]
