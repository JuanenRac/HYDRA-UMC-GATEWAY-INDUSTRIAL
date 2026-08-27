# =============================================================================
# HYDRA-UMC GATEWAY INDUSTRIAL - Container Build: Dockerfile
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
# GPL-3.0 - see LICENSE
# =============================================================================
# Same two-stage shape used by every Node/TypeScript project in this batch
# (see HYDRA-UMC-OPCUA-SERVER, HYDRA-UMC-MQTT-BROKER and
# HYDRA-UMC-MTCONNECT-ADAPTER for the identical pattern applied to each
# child) - build stage runs the same `npm run build` a developer would run
# locally (bumps the version, bundles with esbuild into dist/server.cjs),
# runtime stage ships only the bundle plus package.json, no dev
# dependencies, no TypeScript compiler. See docker-compose.yml at this
# repo's root for how this image and its three children are wired
# together.

FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
EXPOSE 8000
CMD ["node", "dist/server.cjs"]
