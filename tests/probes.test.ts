// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/probes.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real network tests: probeTcp against a real net.Server (listening, then
// actually closed) and probeHttp against a real http.Server - proving
// each probe correctly distinguishes reachable from unreachable using a
// real socket/request, not a mocked network layer.
// =============================================================================

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { probeHttp, probeTcp } from "../src/probes.js";

let tcpServer: Server | undefined;
let httpServer: HttpServer | undefined;

afterEach(async () => {
  if (tcpServer) {
    await new Promise<void>((resolve) => tcpServer!.close(() => resolve()));
    tcpServer = undefined;
  }
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = undefined;
  }
});

describe("probeTcp (real TCP connect)", () => {
  it("reports reachable:true for a real listening TCP server", async () => {
    tcpServer = createServer((socket) => socket.end());
    const port = await new Promise<number>((resolve) => {
      tcpServer!.listen(0, "127.0.0.1", () => resolve((tcpServer!.address() as any).port));
    });

    const result = await probeTcp("127.0.0.1", port, 1000);
    expect(result.reachable).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("reports reachable:false for a port nothing is listening on", async () => {
    // Port 1 is a real, universally-unassigned low port nothing binds to
    // in this test environment - a real connection refusal, not simulated.
    const result = await probeTcp("127.0.0.1", 1, 1000);
    expect(result.reachable).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("reports reachable:false once a previously-reachable server is closed", async () => {
    tcpServer = createServer((socket) => socket.end());
    const port = await new Promise<number>((resolve) => {
      tcpServer!.listen(0, "127.0.0.1", () => resolve((tcpServer!.address() as any).port));
    });
    expect((await probeTcp("127.0.0.1", port, 1000)).reachable).toBe(true);

    await new Promise<void>((resolve) => tcpServer!.close(() => resolve()));
    tcpServer = undefined;

    const result = await probeTcp("127.0.0.1", port, 1000);
    expect(result.reachable).toBe(false);
  });
});

describe("probeHttp (real HTTP GET)", () => {
  it("reports reachable:true for a real 200-responding HTTP server", async () => {
    httpServer = createHttpServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const port = await new Promise<number>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => resolve((httpServer!.address() as any).port));
    });

    const result = await probeHttp(`http://127.0.0.1:${port}/probe`, 1000);
    expect(result.reachable).toBe(true);
  });

  it("reports reachable:false for a real HTTP 500 response", async () => {
    httpServer = createHttpServer((_req, res) => {
      res.writeHead(500);
      res.end("error");
    });
    const port = await new Promise<number>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => resolve((httpServer!.address() as any).port));
    });

    const result = await probeHttp(`http://127.0.0.1:${port}/probe`, 1000);
    expect(result.reachable).toBe(false);
    expect(result.error).toContain("500");
  });

  it("reports reachable:false when nothing is listening", async () => {
    const result = await probeHttp("http://127.0.0.1:1/probe", 500);
    expect(result.reachable).toBe(false);
  });
});
