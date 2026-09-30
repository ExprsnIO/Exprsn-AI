# syntax=docker/dockerfile:1.7
# Exprsn-AI application server. Build from the repository root:
#   docker build -f deploy/docker/Dockerfile -t exprsn-ai:dev .

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
WORKDIR /app
# Toolchain for the native modules (argon2, better-sqlite3) when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --workspaces --include-workspace-root --no-audit --no-fund
COPY server/tsconfig.json server/tsconfig.build.json server/
COPY server/src server/src
RUN npm run build -w server \
 && npm prune --omit=dev --workspaces --include-workspace-root --no-audit --no-fund \
 && mkdir -p server/node_modules

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    WEB_ROOT=/app/web \
    SQLITE_FILENAME=/var/lib/exprsn-ai/exprsn-ai.sqlite \
    BLOB_DIR=/var/lib/exprsn-ai/blobs
WORKDIR /app
# The server never runs npm, yarn or corepack, so they and their bundled dependencies leave the runtime image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /var/lib/exprsn-ai \
 && chown node:node /var/lib/exprsn-ai
COPY --from=build --chown=root:root /app/package.json /app/package.json
COPY --from=build --chown=root:root /app/node_modules /app/node_modules
COPY --from=build --chown=root:root /app/server/package.json /app/server/package.json
COPY --from=build --chown=root:root /app/server/node_modules /app/server/node_modules
COPY --from=build --chown=root:root /app/server/dist /app/server/dist
COPY --chown=root:root web /app/web
# Application files are root-owned and read-only to the service user; only /var/lib/exprsn-ai is writable.
USER node
VOLUME ["/var/lib/exprsn-ai"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
