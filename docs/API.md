# HTTP API Reference

Real Express server implemented in
[`src/server.ts`](../src/server.ts). One endpoint, one job: aggregate a
live reachability check of the three protocol bridges this Gateway
fronts (HYDRA-UMC-OPCUA-SERVER, HYDRA-UMC-MQTT-BROKER,
HYDRA-UMC-MTCONNECT-ADAPTER) into a single status surface.

Listens on `0.0.0.0:8000` by default (`PORT` env var to override).
`GET /health` and `GET /status` have no application-level authentication
(internal/same-network use, real TLS/mTLS below is this gateway's own
transport-level control instead). `POST /command` additionally supports
opt-in per-caller JWT authentication - see below.

---

## Security: TLS / mutual TLS

Plain HTTP by default (fine for local development or a deployment behind
its own reverse proxy/VPN). Setting `TLS_CERT_PATH`/`TLS_KEY_PATH`
switches this server to real HTTPS; additionally setting
`TLS_CLIENT_CA_PATH` turns that into real mutual TLS - the TLS handshake
itself is refused for any client that doesn't present a certificate
signed by that CA, before any request is even parsed. See
[`src/tls.ts`](../src/tls.ts) for the real implementation and
[`.env.example`](../.env.example) for the three variables. A configured-
but-unreadable path is a real startup error, never a silent fall-back to
plaintext HTTP - see the real startup banner's own `SECURITY:` line for
which of the three modes (plain HTTP / TLS / mutual TLS) is active.

---

## Security: per-command caller authentication (`POST /command`)

Opt-in via `GATEWAY_JWT_SECRET`. Unset (the default), `POST /command`
has no caller authentication beyond `src/command.ts`'s own allowlist -
the startup banner's `COMMAND AUTH:` line says so in plain text. Set,
every `POST /command` request must carry `Authorization: Bearer <token>`,
a JWT signed with that same secret using HS256 (the algorithm is pinned
explicitly in [`src/auth.ts`](../src/auth.ts), never left to the
library's default, as defense-in-depth against algorithm-confusion
attacks). Missing header is `401`; an invalid, expired, or wrong-algorithm
token is `403` - both checked before the request ever reaches the
allowlist. This is independent of mTLS: mTLS (when configured) identifies
the TLS peer, this identifies who issued the specific command.

---

## `GET /health`

A fast liveness probe, deliberately separate from `/status` below: it answers
"is the gateway process itself up" and never waits on a child. No downstream
probe is made, so it stays fast (well under the ~800ms budget
HYDRA-UMC-SERVER's ecosystem-wide `/api/ecosystem/status` scanner allows per
project) even when all three children are unreachable - `hydra-umc.project.json`'s
own `service.health_path` points at this route rather than `/status` for
exactly that reason.

**Response** - always `200`:

```json
{ "gateway": "HYDRA-UMC-GATEWAY-INDUSTRIAL", "version": "X.Y.Z", "status": "ok" }
```

---

## `GET /status`

Runs a **real network probe** against each child - a TCP connect for OPC-UA/MQTT (`probeTcp()`), a real HTTP `GET` for MTConnect (`probeHttp()`), both in [`src/probes.ts`](../src/probes.ts). It is not a static list - kill a child process and the next probe round reflects it. Every probe round opens a connection to each child, so an answer is reused for `GATEWAY_STATUS_CACHE_MS` (default 1500 ms) and callers that arrive while a round is running share its answer: a loop of requests cannot turn into a connection flood against the plant services. The answer names the children's hosts and ports and the underlying error text, and the route has no authentication of its own: keep the port on a trusted network.

**Response** - always `200`:

```json
{
  "gateway": "HYDRA-UMC-GATEWAY-INDUSTRIAL",
  "version": "X.Y.Z",
  "allReachable": true,
  "children": [
    {
      "name": "HYDRA-UMC-OPCUA-SERVER",
      "protocol": "OPC-UA",
      "endpoint": "opc.tcp://opcua-server:4840/HYDRA-UMC-OPCUA-SERVER",
      "reachable": true,
      "latencyMs": 4
    },
    {
      "name": "HYDRA-UMC-MQTT-BROKER",
      "protocol": "MQTT",
      "endpoint": "mqtt://mqtt-broker:1883",
      "reachable": true,
      "latencyMs": 2
    },
    {
      "name": "HYDRA-UMC-MTCONNECT-ADAPTER",
      "protocol": "MTConnect",
      "endpoint": "http://mtconnect-adapter:5000/probe",
      "reachable": false,
      "latencyMs": 2001,
      "error": "connect ECONNREFUSED"
    }
  ]
}
```

**Fields**

- `gateway` - fixed identity string.
- `version` - this service's own `package.json` version.
- `allReachable` - `true` only if every child's `reachable` is `true`.
- `children[]` - one entry per bridge, in this fixed order (OPC-UA, MQTT, MTConnect):
  - `name` - the sibling repo's name.
  - `protocol` - `"OPC-UA"` / `"MQTT"` / `"MTConnect"`.
  - `endpoint` - the exact address probed (host/port/URL - configurable per child, see below).
  - `reachable` - result of the real probe for *this* request.
  - `latencyMs` - how long the probe took; on a timeout this is close to `PROBE_TIMEOUT_MS` (default `2000`).
  - `error` - present only when `reachable` is `false`: the underlying connection/HTTP error message.
  - `detail` - present only in protocol mode, for a child that is up but needs attention (an MQTT broker that refused the probe's credentials).

**Configuration** (env vars, all optional - defaults match `docker-compose.yml`'s service names):

| Var | Default | Affects |
|---|---|---|
| `PORT` | `8000` | This server's own listen port. |
| `PROBE_TIMEOUT_MS` | `2000` | Timeout for every child probe. |
| `GATEWAY_STATUS_CACHE_MS` | `1500` | How long a `/status` answer is reused. |
| `OPCUA_HOST` / `OPCUA_PORT` | `opcua-server` / `4840` | OPC-UA TCP probe target. |
| `MQTT_HOST` / `MQTT_PORT` | `mqtt-broker` / `1883` | MQTT TCP probe target. |
| `MTCONNECT_URL` | `http://mtconnect-adapter:5000/probe` | MTConnect HTTP probe target. |
| `GATEWAY_PROBE_MODE` | `tcp` | `protocol` makes every probe speak the protocol of its child (see below). Any other value stops the start. |
| `GATEWAY_MQTT_PROBE_USERNAME` / `GATEWAY_MQTT_PROBE_PASSWORD` / `GATEWAY_MQTT_PROBE_CLIENT_ID` | unset | The account the MQTT probe connects with in protocol mode (a broker with authentication needs a read-only account of its own; the client ID must start with that account's prefix). Without them the probe connects anonymously with a random `hydra-gateway-probe-...` ID. |

### Probe modes

`tcp` (the default) opens a TCP connection to OPC-UA and MQTT and GETs the MTConnect URL expecting a 2xx. That proves a port is open, not that the service behind it works: a web server on 4840 would be "reachable".

`protocol` says the first words of each protocol, so "reachable" means what it says:

- **OPC-UA**: an OPC UA TCP `Hello` is sent and an `Acknowledge` must come back. An `Error` message, silence or another protocol is unreachable.
- **MQTT**: an MQTT 3.1.1 `CONNECT` is sent and a `CONNACK` must come back. Return code 0 is reachable; 4 and 5 (the broker wants credentials) are reachable with a `detail` that says so; any other code, silence or another protocol is unreachable. The probe disconnects at once. Every `/status` round connects to the broker once (at most once per `GATEWAY_STATUS_CACHE_MS`).
- **MTConnect**: the body of the URL must be an `MTConnectDevices` document (at most 256 KiB are read); an `MTConnectError`, an HTML page or an empty body is unreachable.

All three were checked against the real HYDRA-UMC-OPCUA-SERVER, HYDRA-UMC-MQTT-BROKER and HYDRA-UMC-MTCONNECT-ADAPTER, and against small servers that accept the connection and say nothing.

## Headers, metrics and shutdown

Every answer carries `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`; `X-Powered-By` is off.

With `GATEWAY_METRICS=1`, `GET /metrics` serves the Prometheus text format: `hydra_gateway_uptime_seconds`, `hydra_gateway_status_probes_total`, `hydra_gateway_commands_total{outcome="..."}` (every `POST /command` attempt by its audit outcome, whichever step answered it) and, for the last probe of each child, `hydra_gateway_child_reachable` and `hydra_gateway_child_probe_latency_milliseconds`. It carries numbers and the three child names, and is open like `GET /status`.

On `SIGTERM` or `SIGINT` the gateway stops accepting connections, closes the idle ones and waits for the audit log to be written to disk before it exits (after five seconds at most).

---

## `POST /command`

The v0 command surface is deliberately read-oriented: only explicitly
allowlisted operations are accepted (`read` for OPC-UA/MTConnect and `publish`
for MQTT). It rejects other operations with `403`, applies bounded shared
concurrency (`429`), and returns `504` when an executor exceeds its request
budget. A `504` means the caller's response budget expired; it does **not**
claim that a downstream operation was cancelled. The dispatcher keeps that
capacity slot reserved until the underlying executor actually settles, so a
slow or stuck child cannot repeatedly time out and bypass backpressure.

No protocol-level write is implemented yet. The default executor makes the
same real reachability probe used by `GET /status`: when the target child is
reachable it answers `501` with outcome `probe_only` (the child answered, but
**nothing was executed** - a caller must not read it as a carried-out order), and
otherwise `502`. `accepted` (`200`) is reserved for an executor that really
performs the operation.

An MQTT `publish` may only target a concrete topic (no wildcards) inside the topics
this gateway is allowed to publish to: `hydra/gateway/#` by default, or the filters
of `GATEWAY_MQTT_PUBLISH_TOPICS`. The bridges' command topics (`hydra/bridges/...`)
and `$SYS` are never reachable through the gateway, whatever is configured: a free
publish there would be an unauthenticated order to a machine. A refused topic is
`403` (`rejected_unauthorized`).

| Var | Default | Affects |
|---|---|---|
| `GATEWAY_JWT_SECRET` | unset | Signs the `Authorization: Bearer` token `POST /command` requires. The gateway refuses to start, in any environment, without a secret of at least 32 characters that is not an example value. A token needs `exp` (it must expire) and `sub` (who issued the command; it is the `caller` of the audit trail). |
| `GATEWAY_JWT_AUDIENCE` | unset | When set, the token must also carry this `aud`. |
| `GATEWAY_ALLOW_ANONYMOUS` | unset | `1` states, on purpose, that this is an open lab gateway: it starts without a secret and `POST /command` has no caller authentication beyond the allowlist. |
| `GATEWAY_MQTT_PUBLISH_TOPICS` | `hydra/gateway/#` | Comma-separated MQTT filters an MQTT `publish` may target. |
| `GATEWAY_BIND_HOST` | `127.0.0.1` | The interface the gateway binds to (the container image sets `0.0.0.0`). |
| `GATEWAY_STRICT_TARGETS` | unset | `1` checks the format of `target`: an OPC-UA target must be a NodeId (`ns=2;s=Line1.Status`, `i=2253`, `g=...`, `b=...`), an MTConnect target a path of the agent (`/current`, `/sample?from=10&count=5`, `/HydraNode_1/probe`); anything else is a `400` that says what was expected. MQTT topics have their own check. Off, any text within the length limits is accepted, as before. |
| `GATEWAY_REQUIRE_TLS_FOR_AUTH` | unset | `1` refuses (`403`, outcome `auth_plain_http`) a request that carries an `Authorization` header over plain HTTP from another machine, before the token is looked at. Over TLS, and from loopback (a reverse proxy that terminates TLS on the same machine), it is accepted. |
| `GATEWAY_CERT_ALLOWED_CN` | unset | Comma-separated common names. With mutual TLS on (`TLS_CLIENT_CA_PATH`), a client whose verified certificate has one of these CNs may command without a token and is recorded as the caller `cert:<CN>`. Any other client still needs a valid token when `GATEWAY_JWT_SECRET` is set (`401`) and is refused with `403` when it is not. The list without mutual TLS stops the start. With the list and mutual TLS the secret is no longer required to start (a secret that is set is still checked). |
| `GATEWAY_METRICS` | unset | `1` serves `GET /metrics`. |

**Request validation.** `protocol` must be exactly `OPC-UA`, `MQTT` or `MTConnect`, `operation` (at most 64 characters) and `target` (at most 512) must not be empty, and `timeoutMs`, when present, must be a positive number of at most 30000: anything else is a `400` with a JSON body (a malformed JSON body too, and an unexpected failure is a plain `500 {"error":"internal error"}`: an answer never carries a stack trace or a server path). The bridges' command topics (`hydra/bridges/...`, `vda5050/...`) and `$SYS` are never reachable through an MQTT `publish`.

**Audit trail.** Every attempt is logged (`logs/command-audit.log`, rotated at 10 MiB) with its outcome, the caller, the peer address, the user agent, the duration and, on a mutual-TLS connection, the client certificate subject; an attempt whose client hung up before the answer is logged too, with `aborted: true`.
