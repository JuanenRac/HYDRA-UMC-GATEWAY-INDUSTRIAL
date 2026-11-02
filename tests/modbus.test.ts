// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/modbus.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The Modbus TCP adapter against a simulated device (src/modbusSimulator.ts): the declarative map, the codec, reading, and writing through the
// write gate (off by default, whitelist from the map, range, admin role, cell state, read back, signed audit chain).
// =============================================================================
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import request from "supertest";
import { buildApp } from "../src/server.js";
import { decodeWords, encodeWords, modbusWriteRules, parseModbusMap, parseModbusTarget, readBackMatches } from "../src/modbus.js";
import { startSimulatedModbus, type SimulatedModbusDevice } from "../src/modbusSimulator.js";

const SECRET = "x".repeat(8) + "Abc123!Zq9".repeat(3);
const originalEnv = { ...process.env };
let device: SimulatedModbusDevice;
let cellServer: Server;
let cellState = "READY";
let dir: string;

function mapFor(port: number, extra: Record<string, unknown> = {}) {
  return {
    devices: [
      {
        id: "plc1",
        host: "127.0.0.1",
        port,
        unitId: 1,
        timeoutMs: 400,
        registers: [
          { name: "temp", table: "input", address: 10, type: "int16", scale: 0.1 },
          { name: "setpoint", table: "holding", address: 20, type: "uint16", scale: 0.1, writable: true, min: 0, max: 90 },
          { name: "speed", table: "holding", address: 30, type: "float32", writable: true, min: 0, max: 3000 },
          { name: "counter", table: "holding", address: 40, type: "uint32", wordOrder: "little" },
          { name: "fan", table: "coil", address: 5, writable: true },
          { name: "door", table: "discrete", address: 6 },
          { name: "locked", table: "holding", address: 50, type: "uint16" },
        ],
        ...extra,
      },
    ],
  };
}

function token(claims: Record<string, unknown> = {}) {
  return jwt.sign({ sub: "alice", scope: "modbus:*", role: "admin", ...claims }, SECRET, { algorithm: "HS256", expiresIn: 300 });
}

function writeEnv() {
  const keyFile = path.join(dir, "audit.key");
  fs.writeFileSync(keyFile, "k".repeat(40));
  process.env.GATEWAY_WRITES = "1";
  process.env.GATEWAY_CELL_STATE_URL = `http://127.0.0.1:${(cellServer.address() as any).port}/state`;
  process.env.GATEWAY_WRITE_AUDIT_KEY_FILE = keyFile;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "modbus-test-"));
  cellState = "READY";
  cellServer = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ state: cellState, timestamp_utc: new Date().toISOString() }));
  });
  await new Promise<void>((resolve) => cellServer.listen(0, "127.0.0.1", resolve));
  device = await startSimulatedModbus();
  process.env.GATEWAY_JWT_SECRET = SECRET;
  process.env.PROBE_TIMEOUT_MS = "300";
});

afterEach(async () => {
  await device.close();
  await new Promise<void>((resolve) => cellServer.close(() => resolve()));
  process.env = { ...originalEnv };
  fs.rmSync(dir, { recursive: true, force: true });
});

function useMap(map: unknown) {
  const file = path.join(dir, "map.json");
  fs.writeFileSync(file, JSON.stringify(map));
  process.env.GATEWAY_MODBUS_MAP_FILE = file;
}

const command = (app: ReturnType<typeof buildApp>, body: Record<string, unknown>, bearer = token()) => request(app).post("/command").set("Authorization", `Bearer ${bearer}`).send(body);

describe("the Modbus map", () => {
  it("is read from JSON with defaults, and gives the write rules of its writable registers with their ranges", () => {
    const map = parseModbusMap(JSON.stringify(mapFor(502)));
    const plc = map.devices.get("plc1")!;
    expect(plc.registers.get("temp")).toMatchObject({ table: "input", scale: 0.1, offset: 0, wordOrder: "big", writable: false });
    expect(plc.registers.get("fan")).toMatchObject({ type: "bool", writable: true });
    const rules = modbusWriteRules(map);
    expect(rules.map((r) => r.target).sort()).toEqual(["modbus:plc1/fan", "modbus:plc1/setpoint", "modbus:plc1/speed"]);
    expect(rules.find((r) => r.target === "modbus:plc1/setpoint")).toMatchObject({ type: "number", min: 0, max: 90 });
    expect(rules.find((r) => r.target === "modbus:plc1/fan")).toMatchObject({ type: "boolean" });
    expect(parseModbusTarget("modbus:plc1/setpoint")).toEqual({ device: "plc1", register: "setpoint" });
    expect(parseModbusTarget("modbus:plc1")).toBeNull();
    expect(parseModbusTarget("modbus:../x/y")).toBeNull();
  });

  it("refuses a map that would leave a register unprotected or ambiguous", () => {
    const bad = (mutate: (m: any) => void, text: RegExp) => {
      const m = mapFor(502);
      mutate(m);
      expect(() => parseModbusMap(JSON.stringify(m))).toThrow(text);
    };
    bad((m) => delete m.devices[0].registers[1].max, /finite min and max/);
    bad((m) => (m.devices[0].registers[1].min = 95), /min is above max/);
    bad((m) => (m.devices[0].unitId = 0), /unitId/);
    bad((m) => (m.devices[0].registers[0].writable = true), /cannot be written/);
    bad((m) => m.devices[0].registers.push({ ...m.devices[0].registers[0] }), /listed twice/);
    bad((m) => (m.devices[0].registers[4].scale = 2), /no scale/);
    bad((m) => (m.devices[0].registers[0].address = 65535 + 1), /address/);
    bad((m) => (m.devices[0].registers[2].type = "bool"), /not a bool/);
    bad((m) => (m.devices[0].registers[5].min = 1), /only for a writable/);
    expect(() => parseModbusMap("{}")).toThrow(/devices/);
    expect(() => parseModbusMap('{"devices":[]}')).toThrow(/devices/);
  });
});

describe("the codec", () => {
  it("round-trips every type in both word orders and rejects what does not fit", () => {
    for (const order of ["big", "little"] as const) {
      for (const [type, value] of [["uint16", 65535], ["int16", -1234], ["uint32", 4_000_000_000], ["int32", -70000], ["float32", 12.5]] as const) {
        const words = encodeWords(type, value, order)!;
        expect(decodeWords(type, words, order)).toBe(value);
      }
    }
    expect(encodeWords("uint16", 70000, "big")).toBeNull();
    expect(encodeWords("uint16", -1, "big")).toBeNull();
    expect(encodeWords("int16", 1.5, "big")).toBeNull();
    expect(encodeWords("uint32", Number.NaN, "big")).toBeNull();
    expect(encodeWords("float32", 1e60, "big")).toBeNull();
    // a little-endian word order swaps the words
    expect(encodeWords("uint32", 0x00010002, "little")).toEqual([2, 1]);
  });

  it("compares a read back with the written value by the tolerance of the register", () => {
    const map = parseModbusMap(JSON.stringify(mapFor(502)));
    const setpoint = map.devices.get("plc1")!.registers.get("setpoint")!;
    expect(readBackMatches(setpoint, 12.5, 12.5)).toBe(true);
    expect(readBackMatches(setpoint, 12.5, 12.4)).toBe(false);
    expect(readBackMatches(setpoint, true, true)).toBe(true);
    expect(readBackMatches(setpoint, true, false)).toBe(false);
  });
});

describe("reading through POST /command", () => {
  it("is off without a map: Modbus is not an operation of the gateway", async () => {
    const res = await command(buildApp(), { protocol: "Modbus", operation: "read", target: "modbus:plc1/temp" });
    expect(res.status).toBe(403);
    expect(res.body.status).toBe("rejected_unauthorized");
    expect(device.requests).toHaveLength(0);
  });

  it("reads scaled values of every table and type from the device", async () => {
    useMap(mapFor(device.port));
    device.input[10] = 0xffff - 24; // int16 -25 -> -2.5
    device.holding[20] = 125;
    device.holding[40] = 0x0001; // little word order: low word first
    device.holding[41] = 0x0002;
    device.coils[5] = 1;
    device.discrete[6] = 0;
    const app = buildApp();
    const read = async (name: string) => (await command(app, { protocol: "Modbus", operation: "read", target: `modbus:plc1/${name}` })).body;
    expect((await read("temp")).result).toBeCloseTo(-2.5);
    expect((await read("setpoint")).result).toBeCloseTo(12.5);
    expect((await read("counter")).result).toBe(0x00020001);
    expect((await read("fan")).result).toBe(true);
    expect((await read("door")).result).toBe(false);
    expect((await read("temp")).status).toBe("accepted");
  });

  it("refuses a register the map does not have before it opens a connection, and reports a device that answers with an exception", async () => {
    useMap(mapFor(device.port));
    const app = buildApp();
    const before = device.requests.length;
    const missing = await command(app, { protocol: "Modbus", operation: "read", target: "modbus:plc1/nope" });
    expect(missing.status).toBe(502);
    expect(missing.body.reason).toContain("no register");
    const other = await command(app, { protocol: "Modbus", operation: "read", target: "modbus:plc9/temp" });
    expect(other.body.reason).toContain("no device");
    expect(device.requests.length).toBe(before);
    await device.close();
    device = await startSimulatedModbus({ alwaysException: 2 });
    useMap(mapFor(device.port));
    const refused = await command(buildApp(), { protocol: "Modbus", operation: "read", target: "modbus:plc1/temp" });
    expect(refused.status).toBe(502);
    expect(refused.body.reason).toContain("exception 2");
  });

  it("needs the modbus scope of the token, and GET /status lists each device of the map", async () => {
    useMap(mapFor(device.port));
    const app = buildApp();
    const noScope = await command(app, { protocol: "Modbus", operation: "read", target: "modbus:plc1/temp" }, token({ scope: "mqtt:publish" }));
    expect(noScope.status).toBe(403);
    expect(noScope.body.error).toContain("no scope for modbus:read");
    const status = await request(app).get("/status");
    const plc = status.body.children.find((c: any) => c.name === "modbus:plc1");
    expect(plc).toMatchObject({ protocol: "Modbus", reachable: true });
  });
});

describe("writing through the write gate", () => {
  const prepare = (app: ReturnType<typeof buildApp>, target: string, value: unknown, bearer = token()) => command(app, { protocol: "Modbus", operation: "write", target, value }, bearer);
  const commit = (app: ReturnType<typeof buildApp>, confirmId: string, bearer = token()) => command(app, { protocol: "Modbus", operation: "write_commit", target: "modbus:plc1/setpoint", confirmId }, bearer);

  it("is off by default: with a map and no GATEWAY_WRITES the write is not an operation", async () => {
    useMap(mapFor(device.port));
    const res = await prepare(buildApp(), "modbus:plc1/setpoint", 20);
    expect(res.status).toBe(403);
    expect(res.body.status).toBe("rejected_unauthorized");
    expect(device.holding[20]).toBe(0);
  });

  it("writes, in two steps, only what the map lists with a value inside its range, and reads the value back", async () => {
    useMap(mapFor(device.port));
    writeEnv();
    const app = buildApp();
    const prepared = await prepare(app, "modbus:plc1/setpoint", 42.5);
    expect(prepared.status).toBe(202);
    expect(prepared.body.status).toBe("write_prepared");
    expect(device.holding[20]).toBe(0); // nothing written by the first step
    const done = await commit(app, prepared.body.confirmId);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("accepted");
    expect(done.body.result).toBeCloseTo(42.5);
    expect(device.holding[20]).toBe(425);
    // the confirmation is good once
    const again = await commit(app, prepared.body.confirmId);
    expect(again.status).toBe(403);
    // a bit and a float over two registers
    const fan = await prepare(app, "modbus:plc1/fan", true);
    expect((await command(app, { protocol: "Modbus", operation: "write_commit", target: "modbus:plc1/fan", confirmId: fan.body.confirmId })).body.result).toBe(true);
    expect(device.coils[5]).toBe(1);
    const speed = await prepare(app, "modbus:plc1/speed", 1500.5);
    const speedDone = await command(app, { protocol: "Modbus", operation: "write_commit", target: "modbus:plc1/speed", confirmId: speed.body.confirmId });
    expect(speedDone.body.result).toBeCloseTo(1500.5);
    expect(device.holding[30]).not.toBe(0);
  });

  it("refuses a value out of range, a register that is not writable, a type that is wrong and a caller that is not an admin", async () => {
    useMap(mapFor(device.port));
    writeEnv();
    const app = buildApp();
    expect((await prepare(app, "modbus:plc1/setpoint", 90.1)).body.reason).toContain("above the maximum");
    expect((await prepare(app, "modbus:plc1/setpoint", -1)).body.reason).toContain("below the minimum");
    expect((await prepare(app, "modbus:plc1/locked", 1)).body.reason).toContain("no write rule");
    expect((await prepare(app, "modbus:plc1/temp", 1)).body.reason).toContain("no write rule");
    expect((await prepare(app, "modbus:plc1/fan", "on")).body.reason).toContain("true or false");
    const operator = await prepare(app, "modbus:plc1/setpoint", 10, token({ role: "operator" }));
    expect(operator.status).toBe(403);
    expect(operator.body.reason).toContain("admin role");
    const noRole = await prepare(app, "modbus:plc1/setpoint", 10, token({ role: undefined }));
    expect(noRole.body.reason).toContain("admin role");
    // a role among several counts, and the token may carry them as a list
    expect((await prepare(app, "modbus:plc1/setpoint", 10, token({ role: undefined, roles: ["operator", "Admin"] }))).status).toBe(202);
    expect(device.holding[20]).toBe(0);
    expect(device.requests.filter(([code]) => code === 6 || code === 16 || code === 5)).toHaveLength(0);
  });

  it("refuses to write while the cell is not READY, at either step", async () => {
    useMap(mapFor(device.port));
    writeEnv();
    const app = buildApp();
    const prepared = await prepare(app, "modbus:plc1/setpoint", 10);
    expect(prepared.status).toBe(202);
    cellState = "INHIBITED";
    const blocked = await commit(app, prepared.body.confirmId);
    expect(blocked.status).toBe(403);
    expect(blocked.body.reason).toContain("INHIBITED");
    expect((await prepare(app, "modbus:plc1/setpoint", 10)).body.reason).toContain("INHIBITED");
    expect(device.holding[20]).toBe(0);
  });

  it("reports a write the device did not keep as write_unverified, never as accepted", async () => {
    await device.close();
    device = await startSimulatedModbus({ ignoreWrites: true });
    useMap(mapFor(device.port));
    writeEnv();
    const app = buildApp();
    const prepared = await prepare(app, "modbus:plc1/setpoint", 30);
    const done = await commit(app, prepared.body.confirmId);
    expect(done.status).toBe(502);
    expect(done.body.status).toBe("write_unverified");
    expect(done.body.reason).toContain("not the one written");
    expect(done.body.readBack).toBe(0);
    // the write was sent once and not repeated
    expect(device.requests.filter(([code]) => code === 6)).toHaveLength(1);
  });

  it("leaves every decision in the signed audit chain, the refusals for the role included", async () => {
    useMap(mapFor(device.port));
    writeEnv();
    const app = buildApp();
    await prepare(app, "modbus:plc1/setpoint", 10, token({ role: "operator" }));
    const prepared = await prepare(app, "modbus:plc1/setpoint", 11);
    await commit(app, prepared.body.confirmId);
    const audit = await request(app).get("/command/write-audit").set("Authorization", `Bearer ${token()}`);
    expect(audit.status).toBe(200);
    expect(audit.body.signed).toBe(true);
    expect(audit.body.chainIntact).toBe(true);
    const events = audit.body.records.map((r: any) => r.event);
    expect(events).toEqual(["write_refused", "write_prepared", "write_committed", "write_executed"]);
    expect(audit.body.records[0].detail).toContain("admin role");
    expect(audit.body.records[3].detail).toBe("accepted");
    expect(audit.body.records.every((r: any) => r.caller === "alice" && r.target === "modbus:plc1/setpoint")).toBe(true);
  });

  it("starts with the rules of the map alone, and refuses a node that has a rule in the file and in the map", async () => {
    useMap(mapFor(device.port));
    writeEnv();
    expect(() => buildApp()).not.toThrow();
    const rules = path.join(dir, "rules.json");
    fs.writeFileSync(rules, JSON.stringify([{ target: "modbus:plc1/setpoint", type: "number", min: 0, max: 1 }]));
    process.env.GATEWAY_WRITE_RULES_FILE = rules;
    expect(() => buildApp()).toThrow(/two write rules/);
  });
});
