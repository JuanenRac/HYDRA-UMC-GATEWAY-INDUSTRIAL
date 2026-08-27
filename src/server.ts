// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Integration Status Surface: src/server.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Parent/integration repo for the three protocol bridges that make up the
// Industry 4.0 Gateway (see this project's own README.md for the full
// rationale): HYDRA-UMC-OPCUA-SERVER, HYDRA-UMC-MQTT-BROKER and
// HYDRA-UMC-MTCONNECT-ADAPTER each run as their own process/container
// (see docker-compose.yml at the repo root for how they're wired
// together) - this repo does not reimplement any of the three protocols
// itself. What this entry point owns is the single aggregated surface an
// operator or monitoring tool checks first: GET /status makes a REAL
// network check against each child (TCP connect for OPC-UA/MQTT, a real
// HTTP GET for MTConnect - see src/probes.ts) so "is the plant floor
// actually connected to OPC-UA/MQTT/MTConnect right now" has one real
// answer instead of three, verified against real running services (not a
// static list) - see tests/server.test.ts and the end-to-end smoke test.
//
// Host/port defaults match docker-compose.yml's own service names
// (opcua-server, mqtt-broker, mtconnect-adapter) so `docker compose up`
// needs zero extra configuration; every one is overridable via env var
// for local development (pointing at localhost) or a non-Docker
// deployment.
// =============================================================================

import express from "express";
import { probeHttp, probeTcp, type ProbeResult } from "./probes.js";
import { readPackageVersion } from "./version.js";

// 8000 is free of the three protocol-specific defaults this Gateway
// fronts (4840 OPC-UA, 1883 MQTT, 5000 MTConnect - see each child's own
// src/server.ts) so all four can run side by side with zero port
// collisions during local development or in docker-compose.
const PORT = Number(process.env.PORT) || 8000;

// Probe timeout is deliberately short and separately configurable from the
// child endpoints themselves - tests override it to a few ms so a probe
// against a deliberately-closed port fails fast instead of stretching
// every "child is down" test out to the production default.
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 2000;

interface ChildSpec {
  name: string;
  protocol: "OPC-UA" | "MQTT" | "MTConnect";
  endpoint: string;
  check: () => Promise<ProbeResult>;
}

function buildChildren(): ChildSpec[] {
  const opcuaHost = process.env.OPCUA_HOST || "opcua-server";
  const opcuaPort = Number(process.env.OPCUA_PORT) || 4840;
  const mqttHost = process.env.MQTT_HOST || "mqtt-broker";
  const mqttPort = Number(process.env.MQTT_PORT) || 1883;
  const mtconnectUrl = process.env.MTCONNECT_URL || "http://mtconnect-adapter:5000/probe";

  return [
    {
      name: "HYDRA-UMC-OPCUA-SERVER",
      protocol: "OPC-UA",
      endpoint: `opc.tcp://${opcuaHost}:${opcuaPort}/HYDRA-UMC-OPCUA-SERVER`,
      check: () => probeTcp(opcuaHost, opcuaPort, PROBE_TIMEOUT_MS),
    },
    {
      name: "HYDRA-UMC-MQTT-BROKER",
      protocol: "MQTT",
      endpoint: `mqtt://${mqttHost}:${mqttPort}`,
      check: () => probeTcp(mqttHost, mqttPort, PROBE_TIMEOUT_MS),
    },
    {
      name: "HYDRA-UMC-MTCONNECT-ADAPTER",
      protocol: "MTConnect",
      endpoint: mtconnectUrl,
      check: () => probeHttp(mtconnectUrl, PROBE_TIMEOUT_MS),
    },
  ];
}

export function buildApp() {
  const app = express();

  app.get("/status", async (_req, res) => {
    const children = buildChildren();
    const results = await Promise.all(
      children.map(async (child) => {
        const probe = await child.check();
        return {
          name: child.name,
          protocol: child.protocol,
          endpoint: child.endpoint,
          reachable: probe.reachable,
          latencyMs: probe.latencyMs,
          ...(probe.error ? { error: probe.error } : {}),
        };
      }),
    );

    res.json({
      gateway: "HYDRA-UMC-GATEWAY-INDUSTRIAL",
      version: readPackageVersion(),
      allReachable: results.every((r) => r.reachable),
      children: results,
    });
  });

  return app;
}

function main() {
  const app = buildApp();
  app.listen(PORT, "0.0.0.0", () => {
    console.log("=================================================");
    console.log(` HYDRA-UMC-GATEWAY-INDUSTRIAL v${readPackageVersion()}`);
    console.log(" ROLE: Industry 4.0 interoperability bridge for factory standards");
    console.log(` STATUS: Running on port ${PORT} - status: http://localhost:${PORT}/status`);
    console.log(" CHILDREN: OPC-UA (4840) / MQTT (1883) / MTConnect (5000) - see docker-compose.yml");
    console.log("=================================================");
  });
}

// Only auto-start when run directly, not when imported by
// tests/server.test.ts.
const entryFile = process.argv[1] ? process.argv[1].split(/[/\\]/).pop() : "";
if (entryFile === "server.ts" || entryFile === "server.cjs" || entryFile === "server.js") {
  main();
}
