// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Real child reachability probes: src/probes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Real network checks against each protocol bridge, replacing the static
// CHILDREN list this project's GET /status used to return unconditionally,
// regardless of whether any child was actually up. Two check kinds, chosen
// per protocol's own transport:
//   - probeTcp(): a real TCP connect for OPC-UA and MQTT - both are raw
//     TCP protocols; a successful connect proves the child's listener is
//     actually up and accepting sockets (for HYDRA-UMC-MQTT-BROKER
//     specifically, this also proves Aedes's own async listen() step
//     completed - see that project's own server.ts for the real bug this
//     would have caught).
//   - probeHttp(): a real HTTP GET for HYDRA-UMC-MTCONNECT-ADAPTER, since
//     it's an HTTP service already - checking its actual /probe endpoint
//     is a stronger, application-level signal than a bare TCP connect
//     would be.
// Neither performs a full protocol handshake (an actual OPC-UA Hello or
// MQTT CONNECT) - that's real scope left for later, documented here
// rather than silently implied by the word "reachable".
// =============================================================================

import { Socket } from "node:net";

export interface ProbeResult {
  reachable: boolean;
  error?: string;
  /** Reachable, but with something worth saying (for example an MQTT broker that refused the probe's credentials). */
  detail?: string;
  latencyMs: number;
}

export function probeTcp(host: string, port: number, timeoutMs = 2000): Promise<ProbeResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;

    function finish(reachable: boolean, error?: string) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, error, latencyMs: Date.now() - startedAt });
    }

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, `TCP connect to ${host}:${port} timed out after ${timeoutMs}ms`));
    socket.once("error", (err) => finish(false, err.message));

    socket.connect(port, host);
  });
}

export async function probeHttp(url: string, timeoutMs = 2000): Promise<ProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    // Only the status matters: release the connection instead of leaving the body stream open until GC.
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) {
      return { reachable: false, error: `HTTP ${res.status}`, latencyMs: Date.now() - startedAt };
    }
    return { reachable: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { reachable: false, error: message, latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Protocol probes (GATEWAY_PROBE_MODE=protocol). A TCP connect only proves that something owns the port; these speak the first words of each protocol, so
// "reachable" means "an OPC UA server answered the Hello", "an MQTT broker answered CONNECT" and "the agent returned an MTConnectDevices document".
// -----------------------------------------------------------------------------

export type ProbeMode = "tcp" | "protocol";

/** GATEWAY_PROBE_MODE: "tcp" (the default, as before) or "protocol". Anything else is a startup error. */
export function resolveProbeMode(env: NodeJS.ProcessEnv = process.env): ProbeMode {
  const raw = (env.GATEWAY_PROBE_MODE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "tcp") return "tcp";
  if (raw === "protocol") return "protocol";
  throw new Error(`GATEWAY_PROBE_MODE must be "tcp" or "protocol", got ${JSON.stringify(env.GATEWAY_PROBE_MODE)}`);
}

/** Opens a connection, sends `payload`, and collects what comes back until `enough` says it is complete. Resolves with the bytes (possibly fewer if the peer closed). */
function exchange(host: string, port: number, payload: Buffer, enough: (received: Buffer) => boolean, timeoutMs: number): Promise<{ data: Buffer; error?: string }> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      const data = Buffer.concat(chunks);
      socket.destroy();
      resolve(error ? { data, error } : { data });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      if (enough(Buffer.concat(chunks))) finish();
    });
    socket.once("timeout", () => finish(`no answer from ${host}:${port} within ${timeoutMs}ms`));
    socket.once("error", (err) => finish(err.message));
    socket.once("close", () => finish());
    socket.connect(port, host);
  });
}

/** The OPC UA TCP Hello message (part 6, 7.1.2): what a server must answer with Acknowledge (or Error). */
export function buildOpcUaHello(endpointUrl: string): Buffer {
  const url = Buffer.from(endpointUrl, "utf8");
  const message = Buffer.alloc(8 + 20 + 4 + url.length);
  message.write("HELF", 0, "ascii");
  message.writeUInt32LE(message.length, 4);
  message.writeUInt32LE(0, 8); // protocol version
  message.writeUInt32LE(65536, 12); // receive buffer size
  message.writeUInt32LE(65536, 16); // send buffer size
  message.writeUInt32LE(0, 20); // max message size: no limit
  message.writeUInt32LE(0, 24); // max chunk count: no limit
  message.writeInt32LE(url.length, 28);
  url.copy(message, 32);
  return message;
}

/** Sends a Hello to an OPC UA server and requires an Acknowledge back. */
export async function probeOpcUa(host: string, port: number, endpointUrl: string, timeoutMs = 2000): Promise<ProbeResult> {
  const startedAt = Date.now();
  const { data, error } = await exchange(host, port, buildOpcUaHello(endpointUrl), (received) => received.length >= 8, timeoutMs);
  const latencyMs = Date.now() - startedAt;
  if (data.length < 8) return { reachable: false, error: error ?? `${host}:${port} closed the connection without answering the OPC UA Hello`, latencyMs };
  const kind = data.subarray(0, 3).toString("ascii");
  if (kind === "ACK") return { reachable: true, latencyMs };
  if (kind === "ERR") return { reachable: false, error: `${host}:${port} answered the OPC UA Hello with an Error message`, latencyMs };
  return { reachable: false, error: `${host}:${port} is not an OPC UA server (its answer to the Hello was not Acknowledge)`, latencyMs };
}

function mqttString(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  const out = Buffer.alloc(2 + bytes.length);
  out.writeUInt16BE(bytes.length, 0);
  bytes.copy(out, 2);
  return out;
}

export interface MqttProbeCredentials {
  clientId?: string;
  username?: string;
  password?: string;
}

/** An MQTT 3.1.1 CONNECT packet (clean session, 10 s keep-alive). */
export function buildMqttConnect(credentials: MqttProbeCredentials = {}): Buffer {
  const clientId = credentials.clientId || `hydra-gateway-probe-${Math.random().toString(16).slice(2, 8)}`;
  const withUser = credentials.username !== undefined && credentials.username !== "";
  const flags = 0x02 | (withUser ? 0x80 : 0) | (withUser && credentials.password !== undefined ? 0x40 : 0);
  const variable = Buffer.concat([mqttString("MQTT"), Buffer.from([0x04, flags, 0x00, 0x0a])]);
  const payload = Buffer.concat([
    mqttString(clientId),
    ...(withUser ? [mqttString(credentials.username!)] : []),
    ...(withUser && credentials.password !== undefined ? [mqttString(credentials.password)] : []),
  ]);
  const remaining = variable.length + payload.length; // always below 128 for a probe, so one length byte
  return Buffer.concat([Buffer.from([0x10, remaining]), variable, payload]);
}

/**
 * Sends CONNECT to an MQTT broker and reads the CONNACK. Return code 0 is reachable. Codes 4 and 5 (bad credentials / not authorized) mean a broker that is up and
 * speaking MQTT but refusing this probe: reachable, with the reason in `detail` (give the probe an account with GATEWAY_MQTT_PROBE_USERNAME / _PASSWORD / _CLIENT_ID).
 */
export async function probeMqtt(host: string, port: number, credentials: MqttProbeCredentials = {}, timeoutMs = 2000): Promise<ProbeResult> {
  const startedAt = Date.now();
  const { data, error } = await exchange(host, port, buildMqttConnect(credentials), (received) => received.length >= 4, timeoutMs);
  const latencyMs = Date.now() - startedAt;
  if (data.length < 4) return { reachable: false, error: error ?? `${host}:${port} closed the connection without answering CONNECT`, latencyMs };
  if (data[0] !== 0x20 || data[1] !== 0x02) return { reachable: false, error: `${host}:${port} is not an MQTT broker (its answer to CONNECT was not a CONNACK)`, latencyMs };
  const code = data[3];
  if (code === 0) return { reachable: true, latencyMs };
  if (code === 4 || code === 5) return { reachable: true, latencyMs, detail: `the broker is up but refused the probe (CONNACK ${code}): give it a probe account` };
  return { reachable: false, error: `the broker refused CONNECT (CONNACK ${code})`, latencyMs };
}

const MAX_PROBE_BODY_BYTES = 256 * 1024;

/** GETs the agent's /probe and requires an MTConnectDevices document (an MTConnectError, an HTML page or an empty body is not a working agent). */
export async function probeMtconnect(url: string, timeoutMs = 2000): Promise<ProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { reachable: false, error: `HTTP ${res.status}`, latencyMs: Date.now() - startedAt };
    }
    // read at most a bounded amount: only the root element matters
    const reader = res.body?.getReader();
    let text = "";
    let received = 0;
    if (reader) {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (received >= MAX_PROBE_BODY_BYTES || /<MTConnect(?:Devices|Error)\b/.test(text)) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    const latencyMs = Date.now() - startedAt;
    if (/<MTConnectDevices\b/.test(text)) return { reachable: true, latencyMs };
    if (/<MTConnectError\b/.test(text)) return { reachable: false, error: "the agent answered with an MTConnectError instead of the device model", latencyMs };
    return { reachable: false, error: "HTTP 200, but the body is not an MTConnectDevices document", latencyMs };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}
