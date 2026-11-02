// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/journal-and-stream.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The change journal of the orders (src/journal.ts) and the GET /status/stream push of reachability changes, both off by default.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http, { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import request from "supertest";
import { buildApp } from "../src/server.js";
import { CommandDispatcher } from "../src/command.js";
import { CommandJournal, journalFromEnv, journalSample } from "../src/journal.js";

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

describe("the journal", () => {
  it("names the series after the order and keeps the numbers in the fields", () => {
    const sample = journalSample({ atMs: 5, protocol: "Modbus", operation: "write_commit", target: "modbus:plc1/setpoint", caller: "cert:CN=Alice B", outcome: "accepted", latencyMs: 12, value: 42.5 }, 7);
    expect(sample).toEqual({
      sourceId: "gw:cert:CN_Alice_B",
      kind: "cmd.Modbus.write_commit",
      timestamp: 7,
      fields: { "modbus:plc1/setpoint": 42.5, "status.accepted": 1, latencyMs: 12 },
    });
    expect(journalSample({ atMs: 1, protocol: "MQTT", operation: "publish", target: "hydra/gateway/x", caller: null, outcome: "rejected_unauthorized", value: true }, 1)).toMatchObject({
      sourceId: "gw:anonymous",
      fields: { "hydra/gateway/x": 1, "status.rejected_unauthorized": 1 },
    });
    expect(journalSample({ atMs: 1, protocol: "MQTT", operation: "publish", target: "t", caller: "a", outcome: "o", value: false }, 1).fields.t).toBe(0);
  });

  it("is off unless an address or the list switch is set, and refuses an address that is not the lake's", () => {
    expect(journalFromEnv({})).toBeUndefined();
    expect(journalFromEnv({ GATEWAY_JOURNAL: "1" })?.toLake).toBe(false);
    expect(journalFromEnv({ GATEWAY_JOURNAL_URL: "http://127.0.0.1:8095" }, () => "")?.toLake).toBe(true);
    expect(() => journalFromEnv({ GATEWAY_JOURNAL_URL: "ftp://x" })).toThrow(/GATEWAY_JOURNAL_URL/);
    expect(() => journalFromEnv({ GATEWAY_JOURNAL_URL: "http://h:1/path" })).toThrow(/GATEWAY_JOURNAL_URL/);
  });

  it("sends the orders to the lake in a batch with its token, gives each its own millisecond, and counts what the lake refuses", async () => {
    const received: Array<{ auth: string | undefined; body: any }> = [];
    let status = 202;
    const lake: Server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        received.push({ auth: req.headers.authorization, body: JSON.parse(data) });
        res.statusCode = status;
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => lake.listen(0, "127.0.0.1", resolve));
    try {
      const journal = new CommandJournal({ lakeUrl: `http://127.0.0.1:${(lake.address() as any).port}`, token: "lake-token-16-chars", flushMs: 50 });
      for (const value of [1, 2]) journal.record({ atMs: 1000, protocol: "Modbus", operation: "read", target: "modbus:plc1/temp", caller: "alice", outcome: "accepted", value });
      await journal.flush();
      expect(received).toHaveLength(1);
      expect(received[0].auth).toBe("Bearer lake-token-16-chars");
      expect(received[0].body.samples.map((s: any) => s.timestamp)).toEqual([1000, 1001]);
      expect(journal.stats()).toMatchObject({ sent: 2, failed: 0, queued: 0 });
      status = 503;
      journal.record({ atMs: 2000, protocol: "MQTT", operation: "publish", target: "hydra/gateway/x", caller: "alice", outcome: "accepted" });
      await journal.flush();
      expect(journal.stats()).toMatchObject({ sent: 2, failed: 1 });
      await journal.close();
    } finally {
      await new Promise<void>((resolve) => lake.close(() => resolve()));
    }
  });

  it("drops the oldest of the list and the newest of an overfull queue, and a lake that is down never blocks an order", async () => {
    const journal = new CommandJournal({ lakeUrl: "http://127.0.0.1:1", keep: 3, queueLimit: 2, flushMs: 60_000 });
    for (let i = 0; i < 5; i++) journal.record({ atMs: i, protocol: "MQTT", operation: "publish", target: `t${i}`, caller: null, outcome: "accepted" });
    expect(journal.recent().map((e) => e.target)).toEqual(["t4", "t3", "t2"]);
    expect(journal.stats()).toMatchObject({ dropped: 3, queued: 2, kept: 3 });
    await journal.flush();
    expect(journal.stats().failed).toBe(2);
    await journal.close();
  });

  it("lists the newest orders at GET /command/journal behind the same login, and only while it is on", async () => {
    process.env.GATEWAY_ALLOW_ANONYMOUS = "1";
    const dispatcher = new CommandDispatcher({ executor: async () => ({ ok: true, data: 21.5 }) });
    const journal = new CommandJournal();
    const app = buildApp({ commandDispatcher: dispatcher, journal });
    await request(app).post("/command").send({ protocol: "MQTT", operation: "publish", target: "hydra/gateway/x" });
    await request(app).post("/command").send({ protocol: "MQTT", operation: "delete", target: "hydra/gateway/x" });
    const res = await request(app).get("/command/journal");
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: any) => e.outcome)).toEqual(["rejected_unauthorized", "accepted"]);
    expect(res.body.entries[1]).toMatchObject({ protocol: "MQTT", operation: "publish", target: "hydra/gateway/x", value: 21.5 });
    const off = await request(buildApp({ commandDispatcher: dispatcher })).get("/command/journal");
    expect(off.status).toBe(404);
  });
});

describe("GET /status/stream", () => {
  let opcua: TcpServer;
  let mqtt: TcpServer;
  let mtconnect: Server;
  const open: http.ClientRequest[] = [];

  beforeEach(async () => {
    opcua = createTcpServer((s) => s.end());
    mqtt = createTcpServer((s) => s.end());
    mtconnect = createServer((_q, r) => r.end("<x/>"));
    const ports = await Promise.all([opcua, mqtt].map((s) => new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as any).port)))));
    const http1 = await new Promise<number>((resolve) => mtconnect.listen(0, "127.0.0.1", () => resolve((mtconnect.address() as any).port)));
    process.env.OPCUA_HOST = "127.0.0.1";
    process.env.OPCUA_PORT = String(ports[0]);
    process.env.MQTT_HOST = "127.0.0.1";
    process.env.MQTT_PORT = String(ports[1]);
    process.env.MTCONNECT_URL = `http://127.0.0.1:${http1}/probe`;
    process.env.PROBE_TIMEOUT_MS = "300";
  });

  afterEach(async () => {
    for (const r of open.splice(0)) r.destroy();
    await new Promise<void>((resolve) => opcua.close(() => resolve()));
    await new Promise<void>((resolve) => mqtt.close(() => resolve()));
    await new Promise<void>((resolve) => mtconnect.close(() => resolve()));
  });

  async function listen(app: ReturnType<typeof buildApp>): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as any).port, close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
  }

  /** Opens the stream and resolves once `events` events were read (or the status code, when it is not 200). */
  function readStream(port: number, wanted: number): Promise<{ status: number; events: Array<{ event: string; data: any }> }> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/status/stream" }, (res) => {
        const events: Array<{ event: string; data: any }> = [];
        let buffer = "";
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ status: res.statusCode ?? 0, events });
          return;
        }
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let at;
          while ((at = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (event && data) events.push({ event, data: JSON.parse(data) });
            if (events.length >= wanted) {
              resolve({ status: 200, events });
              req.destroy();
            }
          }
        });
      });
      open.push(req);
      req.on("error", (e: any) => (e.code === "ECONNRESET" ? undefined : reject(e)));
    });
  }

  it("does not exist unless it is switched on", async () => {
    const app = buildApp();
    expect((await request(app).get("/status/stream")).status).toBe(404);
  });

  it("sends the whole status first and then a change event when a child goes down", async () => {
    process.env.GATEWAY_STATUS_STREAM = "1";
    process.env.GATEWAY_STATUS_STREAM_MS = "250";
    const { port, close } = await listen(buildApp({ statusCacheMs: 0 }));
    try {
      const pending = readStream(port, 2);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await new Promise<void>((resolve) => mqtt.close(() => resolve()));
      const { status, events } = await pending;
      expect(status).toBe(200);
      expect(events[0].event).toBe("status");
      expect(events[0].data.allReachable).toBe(true);
      expect(events[1].event).toBe("change");
      expect(events[1].data.children.find((c: any) => c.name === "HYDRA-UMC-MQTT-BROKER").reachable).toBe(false);
    } finally {
      await close();
    }
  }, 15_000);

  it("serves at most GATEWAY_STATUS_STREAM_MAX streams at once", async () => {
    process.env.GATEWAY_STATUS_STREAM = "1";
    process.env.GATEWAY_STATUS_STREAM_MAX = "1";
    const { port, close } = await listen(buildApp());
    try {
      void readStream(port, 99);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const second = await readStream(port, 1);
      expect(second.status).toBe(503);
    } finally {
      await close();
    }
  }, 15_000);
});
