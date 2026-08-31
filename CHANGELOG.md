# Changelog

All notable public work on **HYDRA-UMC-GATEWAY-INDUSTRIAL** is summarized
here, newest first. This changelog intentionally omits calendar dates and
internal work-session detail.

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

## [Unreleased]

- **Timeout-safe backpressure:** a `POST /command` timeout now ends only the
  caller's response budget. Its in-flight capacity stays reserved until the
  real executor settles, so an uncooperative downstream cannot create
  unbounded abandoned work by repeatedly timing out. Late executor failures
  are observed and cannot become unhandled promise rejections.
- **API contract clarification:** `docs/API.md` now documents the exact
  `504` boundary and the intentionally read-oriented v0 command surface.

## Documentation - Real HTTP API reference

- **`docs/API.md`** (new) - `GET /status` documented from the actual
  `server.ts`/`probes.ts` code: full real example response, every field's
  exact meaning, and the env vars that configure each child probe.
  Cross-checked against the existing real integration test suite
  (`tests/server.test.ts`, `tests/probes.test.ts` - 9/9 passing).
  Documentation-only - no code changed, no version bump.

## [0.0.8] - Fixed the Docker image: MODULE_NOT_FOUND on every real run

- **`Dockerfile`'s runtime stage never installed dependencies** - real bug
  found live building and running this image (and its 3 real children -
  HYDRA-UMC-OPCUA-SERVER, HYDRA-UMC-MQTT-BROKER,
  HYDRA-UMC-MTCONNECT-ADAPTER, same fix applied to each) for the first
  time via this repo's own `docker-compose.yml`: the build stage bundles
  with esbuild's own `--packages=external` (deliberate - keeps real npm
  dependencies as real `require()` calls rather than inlining them), so
  the runtime stage needed them installed separately - it never was, so
  every container crashed immediately with `MODULE_NOT_FOUND` on every
  real start. Now copies `package-lock.json` too and runs
  `npm ci --omit=dev` in the runtime stage, the same pattern
  HYDRA-UMC-OS's own `install_server.sh` already uses for
  HYDRA-UMC-SERVER (also esbuild + `--packages=external`). Verified
  live: `docker compose up -d --build` now brings up all 4 containers
  and stays up, and this repo's own `GET /status` reports
  `"allReachable":true` for all 3 children with real measured
  latencies.

## [0.0.7] - Fast /health, separate from the real deep /status diagnostic

- **`GET /health`** (new) - answers 200 immediately, with no downstream
  child probes. Found live while running the whole ecosystem to check it
  end-to-end: `/status` is a genuine deep diagnostic (a real reachability
  probe against every configured child, each with its own real connect
  timeout that legitimately takes ~2s when a child is down) - pointed at
  that as its `health_path`, HYDRA-UMC-SERVER's own ecosystem-wide
  `/api/ecosystem/status` scanner (which budgets only 800ms per probe)
  reported this gateway as DOWN whenever its children were unreachable,
  even though the gateway process itself was perfectly healthy. `/status`
  itself is unchanged - still the real per-child diagnostic, just no
  longer doing double duty as a liveness probe too.
- `hydra-umc.project.json`'s own `service.health_path` updated from
  `/status` to `/health` to match.
- Verified: 2 new tests (`tests/server.test.ts`, one proving `/health`
  answers in well under the scanner's own 800ms budget, one proving it
  stays 200 with every child stand-in closed) - 33/33 passing. Also
  verified live against a real running instance: `/api/ecosystem/status`
  flipped from `live: false` to `live: true` for this project after the
  fix, with no other project's probe affected.

## [0.0.6] - Fixed a real version drift, again

- Re-hit the exact same class of bug 0.0.3's own changelog entry already
  documented and fixed in `build.sh`/`build.bat`: calling
  `bump_manifest_version.py` directly (bypassing those scripts) before
  ever running a real `npm run build` left `package.json` one step
  behind once `npm run build`'s own wired-in `scripts/bump-version.mjs`
  ran and bumped it again. Reconciled with `bump_manifest_version.py
  --sync`, matching the real intended order those build scripts already
  encode. 30/30 tests still passing.

## [0.0.5] - Real ecosystem live-status opt-in

- **`hydra-umc.project.json`** declares its real `service.port` (8000)
  and `health_path` (`/status`) - HYDRA-UMC-SERVER's ecosystem status
  endpoint now does a real HTTP GET against it (expecting 2xx) instead
  of only reporting static manifest metadata.

## [0.0.4] - Ecosystem bug audit: masked-timeout fix and a dangling private-file reference

- **`src/command.ts`** - fixed `withTimeout()`: the `promise.then((value) => {...})` chain had no rejection handler and the wrapping `new Promise((resolve) => {...})` never called `reject`, so an executor that throws/rejects instead of resolving would hang silently until `timeoutMs` elapsed (masking a real executor error as `status: "timeout"`) and would also leave an unhandled promise rejection - which crashes the process by default under modern Node. `withTimeout()` now uses `promise.then(onResolve, onReject)` so whichever of the executor or the timer settles first resolves/rejects the returned promise, and the other becomes a no-op rather than firing late. `CommandDispatcher.dispatch()` now catches a rejecting executor and reports it as a new `"executor_error"` outcome (mapped to HTTP `500` in `server.ts`) instead of letting the exception propagate. The current default executor (`probeTcp`/`probeHttp`-backed, see `probes.ts`) never actually rejects today, so this was latent - but it is exactly the failure mode a future real protocol-level write executor would hit.
- **3 new tests** (`tests/command.test.ts`) using a deliberately-throwing executor: asserts the outcome is `"executor_error"` (never `"timeout"`), asserts no `unhandledRejection` fires via a real `process.on("unhandledRejection", ...)` listener, and asserts the in-flight capacity slot is still freed after the executor rejects. 30 tests total, all passing.
- **`src/probes.ts`** - reworded two comments to remove dead references and
  make their technical scope self-contained, without changing behaviour.
- Both issues were found during a live ecosystem-wide bug audit across the HYDRA-UMC repos, not from a user-reported failure.

## [0.0.3] - Real v0: command allowlist, backpressure and timeout

- **`src/command.ts`** (new) - `CommandDispatcher`: the real decision layer in front of relaying a command to a protocol bridge. `DEFAULT_ALLOWLIST` is default-deny per protocol - v0 only allows read-like/publish operations (`OPC-UA: read`, `MQTT: publish`, `MTConnect: read`); nothing that could alter a live PLC's state is allowlisted yet. `dispatch()` checks authorization first (never influenced by load), then enforces backpressure (no more than `maxConcurrent`, default 4, commands run at once - anything beyond that is rejected immediately, never queued unboundedly), then runs the command's executor under a timeout (default 2000ms). The default executor (wired in `server.ts`) reuses this project's own real reachability probes (`probes.ts`) - a command cannot be relayed to a child that isn't there; honest about not yet performing an actual protocol-level write.
- **`src/server.ts`** - new `POST /command` endpoint: validates `{ protocol, operation, target, timeoutMs? }`, dispatches through a single app-scoped `CommandDispatcher` (shared across requests, so backpressure means something), and maps the outcome to real HTTP status codes (`200` accepted, `403` unauthorized, `429` backpressure, `504` timeout, `502` downstream unreachable, `400` malformed body). `buildApp()` accepts an injectable `commandDispatcher` for tests.
- 18 new tests (12 unit tests for `CommandDispatcher` covering authorization precedence over capacity, backpressure claiming/freeing slots, timeout freeing its slot without leaking capacity, and downstream failure reporting; 6 integration tests for `POST /command` including a real reachability probe against a live/dead child and a real concurrent-request backpressure race). 27 tests total.
- Fixed `build.sh`/`build.bat`: both called `bump_manifest_version.py` (no `--sync`) before `npm run build`, which bumps `package.json`'s native version a second time via `scripts/bump-version.mjs` - left native one step ahead of the manifest. Reordered: `npm run build` bumps the native version first, then `bump_manifest_version.py --sync` runs after.
- Real verification beyond the test suite: ran the compiled `dist/server.cjs` and issued real `POST /command` requests - an allowlisted `OPC-UA read` against a not-actually-running child correctly returned `502 downstream_unreachable` (real TCP timeout), an `OPC-UA write` correctly returned `403 rejected_unauthorized`, and a malformed body correctly returned `400`.

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
