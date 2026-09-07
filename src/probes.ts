// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Real child reachability probes: src/probes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
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
