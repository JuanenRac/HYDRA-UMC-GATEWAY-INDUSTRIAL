// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/server.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real integration test for GET /status: starts real stand-in TCP/HTTP
// servers for the three children (real sockets, not mocks of probes.ts),
// points this Gateway at them via the same env vars docker-compose.yml
// itself sets, and asserts /status reports each one correctly - then
// closes one child mid-test and asserts /status flips that one child to
// unreachable on the very next request. This is what actually proves
// GET /status makes a real, live check rather than returning a static
// list (see this project's own README.md "Architecture" section for why
// that distinction matters).
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import request from "supertest";
import { buildApp } from "../src/server.js";

let opcuaStub: TcpServer;
let mqttStub: TcpServer;
let mtconnectStub: HttpServer;
const originalEnv = { ...process.env };

async function listenTcp(server: TcpServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port));
  });
}

async function listenHttp(server: HttpServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port));
  });
}

beforeEach(async () => {
  opcuaStub = createTcpServer((socket) => socket.end());
  mqttStub = createTcpServer((socket) => socket.end());
  mtconnectStub = createHttpServer((_req, res) => {
    res.writeHead(200);
    res.end("<MTConnectDevices/>");
  });

  const opcuaPort = await listenTcp(opcuaStub);
  const mqttPort = await listenTcp(mqttStub);
  const mtconnectPort = await listenHttp(mtconnectStub);

  process.env.OPCUA_HOST = "127.0.0.1";
  process.env.OPCUA_PORT = String(opcuaPort);
  process.env.MQTT_HOST = "127.0.0.1";
  process.env.MQTT_PORT = String(mqttPort);
  process.env.MTCONNECT_URL = `http://127.0.0.1:${mtconnectPort}/probe`;
  process.env.PROBE_TIMEOUT_MS = "500";
});

afterEach(async () => {
  await new Promise<void>((resolve) => opcuaStub.close(() => resolve()));
  await new Promise<void>((resolve) => mqttStub.close(() => resolve()));
  await new Promise<void>((resolve) => mtconnectStub.close(() => resolve()));
  process.env = { ...originalEnv };
});

describe("HYDRA-UMC-GATEWAY-INDUSTRIAL GET /status (real reachability checks)", () => {
  it("reports all three children reachable when all three are really up", async () => {
    const res = await request(buildApp()).get("/status");
    expect(res.status).toBe(200);
    expect(res.body.allReachable).toBe(true);
    expect(res.body.children).toHaveLength(3);
    for (const child of res.body.children) {
      expect(child.reachable).toBe(true);
    }
  });

  it("flips allReachable to false and identifies the specific down child once it's closed", async () => {
    // First request: all up.
    let res = await request(buildApp()).get("/status");
    expect(res.body.allReachable).toBe(true);

    // Now really close the MQTT stand-in - the next /status call must
    // reflect this live, not return a cached "all up" result.
    await new Promise<void>((resolve) => mqttStub.close(() => resolve()));

    res = await request(buildApp()).get("/status");
    expect(res.body.allReachable).toBe(false);
    const mqttChild = res.body.children.find((c: any) => c.name === "HYDRA-UMC-MQTT-BROKER");
    expect(mqttChild.reachable).toBe(false);
    expect(mqttChild.error).toBeDefined();

    const opcuaChild = res.body.children.find((c: any) => c.name === "HYDRA-UMC-OPCUA-SERVER");
    const mtconnectChild = res.body.children.find((c: any) => c.name === "HYDRA-UMC-MTCONNECT-ADAPTER");
    expect(opcuaChild.reachable).toBe(true);
    expect(mtconnectChild.reachable).toBe(true);
  });

  it("reports the real configured endpoint strings for each child", async () => {
    const res = await request(buildApp()).get("/status");
    const opcuaChild = res.body.children.find((c: any) => c.name === "HYDRA-UMC-OPCUA-SERVER");
    expect(opcuaChild.endpoint).toContain("opc.tcp://127.0.0.1:");
    const mtconnectChild = res.body.children.find((c: any) => c.name === "HYDRA-UMC-MTCONNECT-ADAPTER");
    expect(mtconnectChild.endpoint).toBe(process.env.MTCONNECT_URL);
  });
});
