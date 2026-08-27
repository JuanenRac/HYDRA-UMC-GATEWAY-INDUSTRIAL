# Changelog

All notable work on **HYDRA-UMC-GATEWAY-INDUSTRIAL** is summarized here, newest first. Full
session-by-session detail (including dates) lives in a private,
unpublished internal log - this file is public, so it intentionally
omits calendar dates.

## Versioning scheme

`scripts/bump-version.mjs` bumps `package.json`'s `version` field
automatically as the first step of every real `npm run build` (same
mechanism HYDRA-UMC-SERVER/HYDRA-UMC-STUDIO already use) - no manual
version edits, no build that silently ships under the previous number.

It follows the ecosystem-wide base-10 "odometer" rule rather than
semantic-versioning judgment calls:

- `PATCH` +1 on every build
- when `PATCH` would exceed 9, it resets to 0 and `MINOR` +1 instead (e.g. `0.0.9` -> `0.1.0`, never `0.0.10`)
- the same carry cascades into `MAJOR` if `MINOR` would exceed 9

---

## Documentation - Real HTTP API reference

- **`docs/API.md`** (new) - `GET /status` documented from the actual
  `server.ts`/`probes.ts` code: full real example response, every field's
  exact meaning, and the env vars that configure each child probe.
  Cross-checked against the existing real integration test suite
  (`tests/server.test.ts`, `tests/probes.test.ts` - 9/9 passing).
  Documentation-only - no code changed, no version bump.

## [0.0.2] - Real reachability checks against all three siblings

- **`src/probes.ts`** - real network probes: `probeTcp()` (a real TCP connect, used for OPC-UA and MQTT - both raw TCP protocols) and `probeHttp()` (a real HTTP GET, used for MTConnect since it's already an HTTP service and a real `/probe` call is a stronger, application-level signal than a bare TCP connect). Neither performs a full protocol handshake yet (a real OPC-UA Hello or MQTT CONNECT) - documented explicitly as real, deferred scope rather than silently implied by the word "reachable".
- **`GET /status` now makes a real, live check on every request** instead of returning the static children list it used to - each child's `reachable`, `latencyMs` and (on failure) `error` come from an actual probe made at request time, not a cached or assumed value. `allReachable` is `true` only when all three real checks pass.
- **Host/port/URL configurable via env vars** (`OPCUA_HOST`/`OPCUA_PORT`, `MQTT_HOST`/`MQTT_PORT`, `MTCONNECT_URL`), defaulting to the exact service names `docker-compose.yml` already uses (`opcua-server`, `mqtt-broker`, `mtconnect-adapter`) so the Docker stack needs zero extra configuration, while local (non-Docker) development can point them at `127.0.0.1`.
- **9 new tests** (`tests/probes.test.ts`, `tests/server.test.ts`) - real TCP/HTTP stand-in servers started and then genuinely closed mid-test, proving `/status` flips a specific child to `reachable:false` on the very next request rather than caching an earlier "all up" result.
- **Real end-to-end integration verified**: all three real siblings (HYDRA-UMC-OPCUA-SERVER, HYDRA-UMC-MQTT-BROKER, HYDRA-UMC-MTCONNECT-ADAPTER) were started for real via `tsx src/server.ts`, this Gateway was pointed at them over real localhost sockets, and `GET /status` correctly reported `allReachable:true`; one sibling was then actually killed and the very next `GET /status` correctly flipped it to `reachable:false` with a real `ECONNREFUSED` error message, while the other two stayed `true`. This is the concrete cross-service proof behind this release, not just unit-level test coverage.
- **`src/version.ts`** - `version` in `GET /status`'s response now reads `package.json`'s real, current version at runtime instead of the hardcoded `"0.0.0"` placeholder string.
- **`build.sh`/`build.bat`** - now run the real test suite (`npm test`) as a required step before compiling; a failing test fails the build.

## [0.0.1] - Automatic version bump on build

- Added `scripts/bump-version.mjs` (copied/adapted from HYDRA-UMC-SERVER's
  own) and wired it into `package.json`'s `build` script - this project
  no longer relies on a manual version edit before each real build, like
  every other Node project in the ecosystem.

## [0.0.0] - Initial scaffolding

- **`src/server.ts`** - minimal real entry point (prints identity/version, exits 0 after a health-check listener comes up). No protocol-translation logic yet - the industrial-gateway routing between OPC-UA/MQTT/MTConnect and this ecosystem's own REST/WebSocket API lands in a later pass.
- **`package.json`** - project metadata, no runtime dependencies yet.
- **`build.sh` / `build.bat`** - `npm install && npm run build`.
- **`dev.sh` / `dev.bat`** - run against source directly (no build step) for local development.
