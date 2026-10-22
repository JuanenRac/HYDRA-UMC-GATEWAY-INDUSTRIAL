// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Format of a command target: src/targets.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// A command names its target as free text. Before it is relayed (or, today, probed) the text has to look like what that protocol addresses: an OPC UA NodeId,
// a path of the MTConnect agent, a concrete MQTT topic. Anything else is a malformed request, answered with a clear 400 instead of a command that cannot mean anything.
// The check is opt-in (GATEWAY_STRICT_TARGETS=1): without it a target is any text within the length limits, as before.
// =============================================================================

import type { Protocol } from "./command.js";

// OPC UA NodeId in its textual form: optional "ns=<n>;" and then i=<number>, s=<string>, g=<guid> or b=<base64>.
const OPC_UA_NODE_ID = /^(?:ns=\d{1,5};)?(?:i=\d{1,10}|s=[^\u0000-\u001F\u007F]{1,256}|g=[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|b=[A-Za-z0-9+/]+={0,2})$/;

// What an MTConnect agent serves: /probe, /current, /sample and /assets, optionally under a device name, and a query of plain key=value pairs.
const MTCONNECT_PATH = /^\/(?:[A-Za-z0-9_.:-]{1,128}\/)?(?:probe|current|sample|assets)(?:\?[A-Za-z0-9_.:=&,;%+-]{0,256})?$/;

/** Why `target` is not a valid target for `protocol`, or null when it is. MQTT topics have their own, stricter check in command.ts. */
export function targetFormatProblem(protocol: Protocol, target: string): string | null {
  switch (protocol) {
    case "OPC-UA":
      return OPC_UA_NODE_ID.test(target) ? null : 'an OPC-UA target is a NodeId such as "ns=1;s=HydraNode_1.SwarmOnline" or "i=2253"';
    case "MTConnect":
      return !target.includes("..") && MTCONNECT_PATH.test(target) ? null : 'an MTConnect target is a path of the agent such as "/current", "/sample?from=10&count=5" or "/HydraNode_1/probe"';
    case "MQTT":
      return null;
  }
}

/** GATEWAY_STRICT_TARGETS: off unless it is exactly "1". */
export function strictTargetsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.GATEWAY_STRICT_TARGETS ?? "").trim() === "1";
}
