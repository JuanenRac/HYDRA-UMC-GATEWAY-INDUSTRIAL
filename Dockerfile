# =============================================================================
# HYDRA-UMC GATEWAY INDUSTRIAL - Container Build: Dockerfile
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
# GPL-3.0-or-later - see LICENSE
# =============================================================================
# Same two-stage shape used by every Node/TypeScript project in this batch
# (see HYDRA-UMC-OPCUA-SERVER, HYDRA-UMC-MQTT-BROKER and
# HYDRA-UMC-MTCONNECT-ADAPTER for the identical pattern applied to each
# child) - build stage installs from the lockfile and bundles with esbuild
# into dist/server.cjs (`npm run bundle`: the version bump of `npm run build`
# belongs to a release, not to every image build, so the image reports the
# version of the repository it was built from), runtime stage ships only the
# bundle plus package.json, no dev dependencies, no TypeScript compiler. See docker-compose.yml at this
# repo's root for how this image and its three children are wired
# together.

FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run bundle

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Inside a container the published port is only reachable if the process listens on every interface.
ENV GATEWAY_BIND_HOST=0.0.0.0
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json /app/package-lock.json ./
# Real bug found live on this image's first real run: `npm run build`
# bundles with esbuild's own `--packages=external` (see package.json's
# own build script), which deliberately does NOT inline npm dependencies
# into dist/server.cjs - they stay real require() calls expecting
# node_modules to exist at runtime. This stage never installed them,
# so every real run crashed immediately with MODULE_NOT_FOUND. Same
# `npm ci --omit=dev` pattern HYDRA-UMC-OS's own install_server.sh
# already uses for HYDRA-UMC-SERVER (also esbuild + --packages=external).
RUN npm ci --omit=dev
# The audit trail (logs/command-audit.log) is written next to the bundle: the unprivileged user needs to own the directory.
RUN mkdir -p /app/logs && chown node:node /app/logs
USER node
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.cjs"]
