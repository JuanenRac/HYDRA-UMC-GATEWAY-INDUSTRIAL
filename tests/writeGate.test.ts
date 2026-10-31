// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/writeGate.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The gate that stands in front of every write to a controller (src/writeGate.ts), alone and through POST /command with a simulated controller.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";
import { buildApp } from "../src/server.js";
import { CommandDispatcher } from "../src/command.js";
import {
  WriteGate,
  createSimulatedController,
  parseWriteRules,
  valueProblem,
  verifyChain,
  writesEnabled,
  type CellStateReading,
  type WriteRule,
} from "../src/writeGate.js";

const RULES: WriteRule[] = [
  { target: "ns=2;s=Line1.Setpoint", type: "number", min: 0, max: 100 },
  { target: "ns=2;s=Line1.Mode", type: "string", values: ["auto", "manual"] },
  { target: "ns=2;s=Line1.Enable", type: "boolean" },
];

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function gateWith(state: () => CellStateReading | null | Promise<CellStateReading | null>, time = clock(), extra: Record<string, unknown> = {}) {
  return new WriteGate({ enabled: true, rules: RULES, cellState: async () => state(), now: time.now, ...extra });
}

describe("the rules of a node", () => {
  it("accept a value of the right type inside the range or among the listed values", () => {
    expect(valueProblem(RULES[0], 50)).toBeNull();
    expect(valueProblem(RULES[0], 0)).toBeNull();
    expect(valueProblem(RULES[0], 100)).toBeNull();
    expect(valueProblem(RULES[0], 100.5)).toContain("above");
    expect(valueProblem(RULES[0], -1)).toContain("below");
    expect(valueProblem(RULES[0], "50")).toContain("number");
    expect(valueProblem(RULES[0], Number.NaN)).toContain("number");
    expect(valueProblem(RULES[0], Infinity)).toContain("number");
    expect(valueProblem(RULES[1], "auto")).toBeNull();
    expect(valueProblem(RULES[1], "turbo")).toContain("not one of");
    expect(valueProblem(RULES[2], true)).toBeNull();
    expect(valueProblem(RULES[2], 1)).toContain("true or false");
  });

  it("are read from JSON and a bad rule stops the start", () => {
    expect(parseWriteRules(JSON.stringify(RULES))).toHaveLength(3);
    expect(parseWriteRules(JSON.stringify({ rules: [RULES[2]] }))).toHaveLength(1);
    for (const bad of [
      [{ target: "ns=2;s=*", type: "number", min: 0, max: 1 }],
      [{ target: "ns=2;s=A", type: "number" }],
      [{ target: "ns=2;s=A", type: "number", min: 5, max: 1 }],
      [{ target: "ns=2;s=A", type: "float", min: 0, max: 1 }],
      [{ target: "ns=2;s=A", type: "boolean", min: 0 }],
      [RULES[2], RULES[2]],
      [{ target: "ns=2;s=A", type: "string", values: [] }],
    ]) {
      expect(() => parseWriteRules(JSON.stringify(bad))).toThrow();
    }
    expect(() => parseWriteRules("{}")).toThrow();
  });

  it("are off unless GATEWAY_WRITES is exactly 1", () => {
    expect(writesEnabled({})).toBe(false);
    expect(writesEnabled({ GATEWAY_WRITES: "true" })).toBe(false);
    expect(writesEnabled({ GATEWAY_WRITES: "1" })).toBe(true);
  });
});

describe("the two steps", () => {
  it("prepare hands out an id and commit releases the write once, to the same caller", async () => {
    const t = clock();
    const gate = gateWith(() => ({ state: "READY", atMs: t.now() }), t);
    const prepared = await gate.prepare("tech", "ns=2;s=Line1.Setpoint", 42);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.expiresAtMs).toBe(t.now() + 30_000);
    const released = await gate.commit("tech", prepared.confirmId);
    expect(released).toEqual({ ok: true, target: "ns=2;s=Line1.Setpoint", value: 42 });
    // used up
    const again = await gate.commit("tech", prepared.confirmId);
    expect(again.ok).toBe(false);
  });

  it("a confirmation of another caller, an unknown one and an expired one release nothing", async () => {
    const t = clock();
    const gate = gateWith(() => ({ state: "READY", atMs: t.now() }), t);
    const a = await gate.prepare("tech", "ns=2;s=Line1.Enable", true);
    if (!a.ok) throw new Error("prepare");
    const wrong = await gate.commit("someone-else", a.confirmId);
    expect(wrong.ok).toBe(false);
    // the id is gone even for the right caller: a stolen id burns the confirmation
    expect((await gate.commit("tech", a.confirmId)).ok).toBe(false);
    expect((await gate.commit("tech", "0".repeat(32))).ok).toBe(false);
    expect((await gate.commit("tech", undefined)).ok).toBe(false);
    const b = await gate.prepare("tech", "ns=2;s=Line1.Enable", true);
    if (!b.ok) throw new Error("prepare");
    t.advance(30_001);
    const late = await gate.commit("tech", b.confirmId);
    expect(late).toEqual({ ok: false, reason: expect.stringContaining("expired") });
  });

  it("a node with no rule, a value outside the range and a full queue are refused at the first step", async () => {
    const t = clock();
    const gate = gateWith(() => ({ state: "READY", atMs: t.now() }), t, { maxPending: 2 });
    expect(await gate.prepare("tech", "ns=2;s=Other", 1)).toEqual({ ok: false, reason: expect.stringContaining("no write rule") });
    expect(await gate.prepare("tech", "ns=2;s=Line1.Setpoint", 101)).toEqual({ ok: false, reason: expect.stringContaining("above") });
    expect((await gate.prepare("tech", "ns=2;s=Line1.Setpoint", 1)).ok).toBe(true);
    expect((await gate.prepare("tech", "ns=2;s=Line1.Setpoint", 2)).ok).toBe(true);
    expect(await gate.prepare("tech", "ns=2;s=Line1.Setpoint", 3)).toEqual({ ok: false, reason: expect.stringContaining("too many") });
    expect(gate.pendingCount).toBe(2);
    t.advance(30_001);
    expect(gate.pendingCount).toBe(0);
  });

  it("a gate that is not enabled refuses everything", async () => {
    const gate = new WriteGate({ rules: RULES, cellState: async () => ({ state: "READY", atMs: Date.now() }) });
    expect(gate.enabled).toBe(false);
    expect((await gate.prepare("tech", "ns=2;s=Line1.Enable", true)).ok).toBe(false);
    expect((await gate.commit("tech", "x")).ok).toBe(false);
  });
});

describe("the state of the cell", () => {
  it("only a fresh READY lets a write through, at both steps", async () => {
    const t = clock();
    let reading: CellStateReading | null = { state: "READY", atMs: t.now() };
    const gate = gateWith(() => reading, t);
    for (const state of ["INHIBITED", "FAULT", "SAFE_STOP", "SOMETHING_ELSE"]) {
      reading = { state, atMs: t.now() };
      const refused = await gate.prepare("tech", "ns=2;s=Line1.Enable", true);
      expect(refused.ok).toBe(false);
    }
    reading = { state: "READY", atMs: t.now() - 5000 };
    expect(await gate.prepare("tech", "ns=2;s=Line1.Enable", true)).toEqual({ ok: false, reason: expect.stringContaining("old") });
    reading = null;
    expect(await gate.prepare("tech", "ns=2;s=Line1.Enable", true)).toEqual({ ok: false, reason: expect.stringContaining("unknown") });
    // READY at the first step, a stop before the second: the write is not released
    reading = { state: "READY", atMs: t.now() };
    const prepared = await gate.prepare("tech", "ns=2;s=Line1.Enable", true);
    if (!prepared.ok) throw new Error("prepare");
    reading = { state: "SAFE_STOP", atMs: t.now() };
    expect(await gate.commit("tech", prepared.confirmId)).toEqual({ ok: false, reason: expect.stringContaining("SAFE_STOP") });
  });

  it("no source of the state, or one that fails, means no write", async () => {
    const blind = new WriteGate({ enabled: true, rules: RULES });
    expect(await blind.prepare("tech", "ns=2;s=Line1.Enable", true)).toEqual({ ok: false, reason: expect.stringContaining("no source") });
    const failing = new WriteGate({
      enabled: true,
      rules: RULES,
      cellState: async () => {
        throw new Error("down");
      },
    });
    expect(await failing.prepare("tech", "ns=2;s=Line1.Enable", true)).toEqual({ ok: false, reason: expect.stringContaining("could not be read") });
  });
});

describe("the chain of decisions", () => {
  it("links every record to the one before it and breaks when a record is changed or removed", async () => {
    const t = clock();
    const gate = gateWith(() => ({ state: "READY", atMs: t.now() }), t);
    const p = await gate.prepare("tech", "ns=2;s=Line1.Setpoint", 10);
    if (!p.ok) throw new Error("prepare");
    await gate.commit("tech", p.confirmId);
    gate.recordExecution("tech", "ns=2;s=Line1.Setpoint", "accepted");
    await gate.prepare("tech", "ns=2;s=Other", 1);
    const records = [...gate.auditChain()];
    expect(records.map((r) => r.event)).toEqual(["write_prepared", "write_committed", "write_executed", "write_refused"]);
    expect(records[0].prevHash).toBe("0".repeat(64));
    expect(records[1].prevHash).toBe(records[0].hash);
    expect(verifyChain(records)).toBe(true);
    expect(verifyChain([])).toBe(true);
    // edited
    const edited = records.map((r, i) => (i === 1 ? { ...r, detail: "value 99 released to the executor" } : r));
    expect(verifyChain(edited)).toBe(false);
    // removed from the middle
    expect(verifyChain([records[0], records[2], records[3]])).toBe(false);
    // the tail may be cut off without breaking the part that remains (it is a chain, not a signature)
    expect(verifyChain(records.slice(0, 2))).toBe(true);
  });
});

describe("through POST /command with a simulated controller", () => {
  const SECRET = "test-gateway-secret-of-more-than-32-characters";
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.GATEWAY_JWT_SECRET = SECRET;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function setup(state: () => CellStateReading | null) {
    const controller = createSimulatedController({ "ns=2;s=Line1.Setpoint": 0 });
    const gate = new WriteGate({ enabled: true, rules: RULES, cellState: async () => state() });
    const dispatcher = new CommandDispatcher({ executor: controller.executor, writeGate: gate });
    return { controller, gate, app: buildApp({ commandDispatcher: dispatcher }) };
  }
  const token = (sub: string, scope: string) => jwt.sign({ sub, scope }, SECRET, { algorithm: "HS256", expiresIn: "1h" });
  const ready = () => ({ state: "READY", atMs: Date.now() });

  it("writes only after prepare and commit, once", async () => {
    const { controller, app } = setup(ready);
    const bearer = token("tech", "opc-ua:write opc-ua:write_commit opc-ua:read");
    const prepare = await request(app).post("/command").set("Authorization", `Bearer ${bearer}`).send({ protocol: "OPC-UA", operation: "write", target: "ns=2;s=Line1.Setpoint", value: 42 });
    expect(prepare.status).toBe(202);
    expect(prepare.body.status).toBe("write_prepared");
    expect(controller.nodes.get("ns=2;s=Line1.Setpoint")).toBe(0);
    const commit = await request(app).post("/command").set("Authorization", `Bearer ${bearer}`).send({ protocol: "OPC-UA", operation: "write_commit", target: "ns=2;s=Line1.Setpoint", confirmId: prepare.body.confirmId });
    expect(commit.status).toBe(200);
    expect(controller.nodes.get("ns=2;s=Line1.Setpoint")).toBe(42);
    const replay = await request(app).post("/command").set("Authorization", `Bearer ${bearer}`).send({ protocol: "OPC-UA", operation: "write_commit", target: "ns=2;s=Line1.Setpoint", confirmId: prepare.body.confirmId });
    expect(replay.status).toBe(403);
    expect(replay.body.status).toBe("rejected_write");
    const audit = await request(app).get("/command/write-audit").set("Authorization", `Bearer ${bearer}`);
    expect(audit.status).toBe(200);
    expect(audit.body.chainIntact).toBe(true);
    expect(audit.body.records.map((r: { event: string }) => r.event)).toEqual(["write_prepared", "write_committed", "write_executed", "commit_refused"]);
  });

  it("a caller without the write scope, or a confirmation of another caller, writes nothing", async () => {
    const { controller, app } = setup(ready);
    const reader = token("reader", "opc-ua:read");
    const refused = await request(app).post("/command").set("Authorization", `Bearer ${reader}`).send({ protocol: "OPC-UA", operation: "write", target: "ns=2;s=Line1.Setpoint", value: 1 });
    expect(refused.status).toBe(403);
    expect(refused.body.error ?? refused.body.status).toBeDefined();
    const alice = token("alice", "opc-ua:write opc-ua:write_commit");
    const bob = token("bob", "opc-ua:write opc-ua:write_commit");
    const prepared = await request(app).post("/command").set("Authorization", `Bearer ${alice}`).send({ protocol: "OPC-UA", operation: "write", target: "ns=2;s=Line1.Setpoint", value: 7 });
    const stolen = await request(app).post("/command").set("Authorization", `Bearer ${bob}`).send({ protocol: "OPC-UA", operation: "write_commit", target: "ns=2;s=Line1.Setpoint", confirmId: prepared.body.confirmId });
    expect(stolen.status).toBe(403);
    expect(controller.nodes.get("ns=2;s=Line1.Setpoint")).toBe(0);
  });

  it("a cell that stops between the two steps releases nothing", async () => {
    let current = ready();
    const { controller, app } = setup(() => current);
    const bearer = token("tech", "opc-ua:write opc-ua:write_commit");
    const prepared = await request(app).post("/command").set("Authorization", `Bearer ${bearer}`).send({ protocol: "OPC-UA", operation: "write", target: "ns=2;s=Line1.Setpoint", value: 5 });
    current = { state: "SAFE_STOP", atMs: Date.now() };
    const commit = await request(app).post("/command").set("Authorization", `Bearer ${bearer}`).send({ protocol: "OPC-UA", operation: "write_commit", target: "ns=2;s=Line1.Setpoint", confirmId: prepared.body.confirmId });
    expect(commit.status).toBe(403);
    expect(commit.body.reason).toContain("SAFE_STOP");
    expect(controller.nodes.get("ns=2;s=Line1.Setpoint")).toBe(0);
  });

  it("without a gate, write is not an operation of the gateway and no audit route exists", async () => {
    process.env.GATEWAY_ALLOW_ANONYMOUS = "1";
    delete process.env.GATEWAY_JWT_SECRET;
    const app = buildApp({ commandDispatcher: new CommandDispatcher({ executor: async () => ({ ok: true }) }) });
    for (const operation of ["write", "write_commit"]) {
      const res = await request(app).post("/command").send({ protocol: "OPC-UA", operation, target: "ns=2;s=Line1.Setpoint", value: 1, confirmId: "x" });
      expect(res.status).toBe(403);
      expect(res.body.status).toBe("rejected_unauthorized");
    }
    expect((await request(app).get("/command/write-audit")).status).toBe(404);
  });

  it("a write is never an operation of MQTT or MTConnect, gate or not", async () => {
    const { app } = setup(ready);
    const bearer = token("tech", "*");
    for (const protocol of ["MQTT", "MTConnect"]) {
      const res = await request(app).post("/command").set("Authorization", `Bearer ${bearer}`).send({ protocol, operation: "write", target: "hydra/gateway/x", value: 1 });
      expect(res.status).toBe(403);
      expect(res.body.status).toBe("rejected_unauthorized");
    }
  });
});
