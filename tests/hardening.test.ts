// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/hardening.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Request validation, token claims, /status amplification, audit fields and
// the bounded rate limiter.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, createServer, type Server } from "node:net";
import request from "supertest";
import jwt from "jsonwebtoken";
import { buildApp } from "../src/server.js";
import { CommandDispatcher, MAX_COMMAND_TIMEOUT_MS, mqttPublishTopicProblem } from "../src/command.js";
import { InMemoryCommandAuditLogger } from "../src/audit.js";
import { CommandRateLimiter, MAX_TRACKED_KEYS } from "../src/rateLimit.js";
import { readPackageVersion } from "../src/version.js";

const originalEnv = { ...process.env };
beforeEach(() => {
  delete process.env.GATEWAY_JWT_SECRET;
  delete process.env.GATEWAY_JWT_AUDIENCE;
});
afterEach(() => {
  process.env = { ...originalEnv };
});

function acceptingApp(auditLogger = new InMemoryCommandAuditLogger()) {
  const dispatcher = new CommandDispatcher({ executor: async () => ({ ok: true }) });
  return { app: buildApp({ commandDispatcher: dispatcher, auditLogger }), auditLogger };
}

const body = { protocol: "OPC-UA", operation: "read", target: "ns=2;s=Line1" };

describe("POST /command input validation", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "opc-ua", ""])(
    "answers a JSON 400 (not a 500 with a stack) for the protocol %j",
    async (protocol) => {
      const { app } = acceptingApp();
      const res = await request(app).post("/command").send({ ...body, protocol });
      expect(res.status).toBe(400);
      expect(res.type).toMatch(/json/);
      expect(res.text).not.toMatch(/node_modules|\.ts:|<html/i);
    },
  );

  it("refuses a timeout above the maximum instead of letting the timer overflow", async () => {
    const { app } = acceptingApp();
    const tooLong = await request(app).post("/command").send({ ...body, timeoutMs: MAX_COMMAND_TIMEOUT_MS + 1 });
    expect(tooLong.status).toBe(400);
    const overflow = await request(app).post("/command").send({ ...body, timeoutMs: 1e10 });
    expect(overflow.status).toBe(400);
    const fine = await request(app).post("/command").send({ ...body, timeoutMs: MAX_COMMAND_TIMEOUT_MS });
    expect(fine.status).toBe(200);
  });

  it("refuses an empty or oversized operation and target", async () => {
    const { app } = acceptingApp();
    expect((await request(app).post("/command").send({ ...body, operation: "" })).status).toBe(400);
    expect((await request(app).post("/command").send({ ...body, target: "x".repeat(513) })).status).toBe(400);
  });

  it("answers malformed JSON with a plain JSON error and never an HTML page or a path", async () => {
    const { app } = acceptingApp();
    const res = await request(app).post("/command").set("Content-Type", "application/json").send("{not json");
    expect(res.status).toBe(400);
    expect(res.type).toMatch(/json/);
    expect(res.text).not.toMatch(/node_modules|\.ts:|<html/i);
  });

  it("never lets an MQTT publish reach the AMR command topics", () => {
    expect(mqttPublishTopicProblem("vda5050/v2/agv/robot-1/order", ["#"])).toMatch(/reserved/);
    expect(mqttPublishTopicProblem("hydra/bridges/cnc/cmd/x", ["#"])).toMatch(/reserved/);
  });
});

describe("POST /command token claims", () => {
  const SECRET = "claims-test-secret-claims-test-secret";
  const post = (token: string) => {
    process.env.GATEWAY_JWT_SECRET = SECRET;
    const { app } = acceptingApp();
    return request(app).post("/command").set("Authorization", `Bearer ${token}`).send(body);
  };

  it("refuses a token without an expiry", async () => {
    const res = await post(jwt.sign({ sub: "tech" }, SECRET, { algorithm: "HS256" }));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/exp/);
  });

  it("refuses a token without a subject", async () => {
    const res = await post(jwt.sign({}, SECRET, { algorithm: "HS256", expiresIn: "1h" }));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/sub/);
  });

  it("refuses an expired token and accepts a current one", async () => {
    expect((await post(jwt.sign({ sub: "tech" }, SECRET, { algorithm: "HS256", expiresIn: -10 }))).status).toBe(403);
    expect((await post(jwt.sign({ sub: "tech" }, SECRET, { algorithm: "HS256", expiresIn: "1h" }))).status).toBe(200);
  });

  it("enforces the audience when GATEWAY_JWT_AUDIENCE is set", async () => {
    process.env.GATEWAY_JWT_AUDIENCE = "hydra-umc-gateway-industrial";
    const other = await post(jwt.sign({ sub: "tech", aud: "hydra-umc-server" }, SECRET, { algorithm: "HS256", expiresIn: "1h" }));
    expect(other.status).toBe(403);
    const mine = await post(jwt.sign({ sub: "tech", aud: "hydra-umc-gateway-industrial" }, SECRET, { algorithm: "HS256", expiresIn: "1h" }));
    expect(mine.status).toBe(200);
  });
});

describe("GET /status does not amplify into the children", () => {
  let stub: Server;
  let connections = 0;
  beforeEach(async () => {
    connections = 0;
    stub = createServer((socket) => {
      connections++;
      socket.end();
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const port = (stub.address() as { port: number }).port;
    process.env.OPCUA_HOST = "127.0.0.1";
    process.env.OPCUA_PORT = String(port);
    process.env.MQTT_HOST = "127.0.0.1";
    process.env.MQTT_PORT = "1"; // closed on purpose
    process.env.MTCONNECT_URL = "http://127.0.0.1:1/probe";
    process.env.PROBE_TIMEOUT_MS = "300";
  });
  afterEach(async () => {
    await new Promise((resolve) => stub.close(resolve));
  });

  it("answers a burst of requests with one probe round (single flight inside the cache window)", async () => {
    const app = buildApp({ statusCacheMs: 5000 });
    const results = await Promise.all(Array.from({ length: 20 }, () => request(app).get("/status")));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(connections).toBe(1);
  });

  it("probes again once the cache window has passed", async () => {
    const app = buildApp({ statusCacheMs: 0 });
    await request(app).get("/status");
    await request(app).get("/status");
    expect(connections).toBe(2);
  });
});

describe("the audit trail", () => {
  it("attributes an attempt to a host and measures it", async () => {
    const { app, auditLogger } = acceptingApp();
    await request(app).post("/command").set("User-Agent", "unit-test").send(body);
    const entry = auditLogger.entries[0];
    expect(entry.remoteAddress).toBeTruthy();
    expect(entry.userAgent).toBe("unit-test");
    expect(typeof entry.durationMs).toBe("number");
    expect(entry.aborted).toBeUndefined();
  });

  it("records an attempt whose client hung up before the answer", async () => {
    const auditLogger = new InMemoryCommandAuditLogger();
    const slow = new CommandDispatcher({ executor: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 400)) });
    const app = buildApp({ commandDispatcher: slow, auditLogger });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const payload = JSON.stringify(body);
    await new Promise<void>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(`POST /command HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`);
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 80);
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    server.close();
    expect(auditLogger.entries).toHaveLength(1);
    expect(auditLogger.entries[0].aborted).toBe(true);
  });
});

describe("the rate limiter is bounded", () => {
  it("never tracks more than its ceiling of distinct callers", () => {
    const limiter = new CommandRateLimiter({ windowMs: 60_000, maxRequests: 5 });
    const now = 1_000_000;
    for (let i = 0; i < MAX_TRACKED_KEYS + 500; i++) limiter.check(`2001:db8::${i}`, now);
    expect(limiter.trackedKeys).toBeLessThanOrEqual(MAX_TRACKED_KEYS);
  });
});

describe("the reported version", () => {
  it("is the package version, read once", () => {
    const first = readPackageVersion();
    expect(first).toMatch(/^\d+\.\d+\.\d+/);
    expect(readPackageVersion()).toBe(first);
  });
});
