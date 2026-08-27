# HTTP API Reference

Real Express server implemented in
[`src/server.ts`](../src/server.ts). One endpoint, one job: aggregate a
live reachability check of the three protocol bridges this Gateway
fronts (HYDRA-UMC-OPCUA-SERVER, HYDRA-UMC-MQTT-BROKER,
HYDRA-UMC-MTCONNECT-ADAPTER) into a single status surface.

Listens on `0.0.0.0:8000` by default (`PORT` env var to override). No authentication - internal/same-network use.

---

## `GET /status`

Runs a **real network probe** against each child on every request - a TCP connect for OPC-UA/MQTT (`probeTcp()`), a real HTTP `GET` for MTConnect (`probeHttp()`), both in [`src/probes.ts`](../src/probes.ts). Nothing here is cached or a static list - kill a child process and the very next `/status` call reflects it.

**Response** - always `200`:

```json
{
  "gateway": "HYDRA-UMC-GATEWAY-INDUSTRIAL",
  "version": "0.1.4",
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

**Configuration** (env vars, all optional - defaults match `docker-compose.yml`'s service names):

| Var | Default | Affects |
|---|---|---|
| `PORT` | `8000` | This server's own listen port. |
| `PROBE_TIMEOUT_MS` | `2000` | Timeout for every child probe. |
| `OPCUA_HOST` / `OPCUA_PORT` | `opcua-server` / `4840` | OPC-UA TCP probe target. |
| `MQTT_HOST` / `MQTT_PORT` | `mqtt-broker` / `1883` | MQTT TCP probe target. |
| `MTCONNECT_URL` | `http://mtconnect-adapter:5000/probe` | MTConnect HTTP probe target. |
