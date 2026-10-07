# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv

# The skipped check reads the "TOKEN" in TOKEN_MONITOR_* as a credential. The
# variables set below are a port, a bind address and a path; the one real secret
# is passed at run time and never baked into a layer. (Directives have to be the
# first lines in the file, which is why this note follows them.)

# Container image for the company hub: hub/server.js (upstream's
# src/hub/server.js + the overlay: store, dashboard, reports). The build
# context is the root of this repository, and the image keeps its layout —
# the overlay at /app, upstream's hub code under /app/upstream — so upstream.js
# resolves upstream exactly as it does in a checkout. Build it with
# `docker build -f docker/Dockerfile -t token-monitor-hub .` from the repository
# root; see docs/docker.md.

FROM node:22-alpine AS deps

WORKDIR /deps

# Runtime dependencies from this repository's lockfile, exactly as `npm ci`
# installs them in a checkout: dotenv (the one npm package upstream's hub
# loads, pinned to the version upstream's lockfile resolves) and the database
# driver. Nothing of upstream's own package.json is installed, which keeps
# electron-updater and the koffi / tokscale native binaries out of the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund


FROM node:22-alpine

ENV NODE_ENV=production

# pg_dump for the hub's own backups (hub/backups.js). Its major version must be
# at least the server's, and compose.yml runs postgres:18-alpine.
RUN apk add --no-cache postgresql18-client \
 && pg_dump --version | grep -q 'PostgreSQL) 18\.'

# Read by the hub's CLI bootstrap and the overlay. The data file and the
# backups live outside /app so they survive an image rebuild; see the volumes
# below.
ENV TOKEN_MONITOR_PORT=17321 \
    TOKEN_MONITOR_HOST=0.0.0.0 \
    TOKEN_MONITOR_DATA_FILE=/data/devices.json \
    TOKEN_MONITOR_BACKUP_DIR=/backups

WORKDIR /app

COPY --from=deps /deps/node_modules ./node_modules
COPY package.json upstream.js ./
# The upstream code the hub runs: its hub and the shared modules it requires.
COPY upstream/package.json ./upstream/package.json
COPY upstream/src/shared ./upstream/src/shared
COPY upstream/src/hub ./upstream/src/hub
# The overlay: entry point, dashboard, store, reports and the SQL migrations.
COPY hub ./hub

# Owned by the unprivileged user the image runs as, so the hub can write its
# store into a named volume without a startup chown. A bind mount arrives with
# the host's ownership instead and may need `chown 1000:1000` on the host.
# /cache is where a hub with a database store keeps upstream's JSON file, on a
# tmpfs (compose.yml); /backups is where it writes its pg_dump files.
RUN mkdir -p /data /cache /backups && chown -R node:node /data /cache /backups

VOLUME ["/data", "/backups"]

USER node

EXPOSE 17321

# No curl or wget in the image, and none is needed: /api/health answers without
# the shared secret (so do the overlay's dashboard paths, but health is the
# route meant for this).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.TOKEN_MONITOR_PORT || 17321) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Remember TOKEN_MONITOR_SECRET: without one the hub clamps its bind address to
# loopback *inside the container*, and the published port answers nothing.
CMD ["node", "hub/server.js"]
