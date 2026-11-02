// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Modbus TCP adapter: src/modbus.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// A legacy PLC that speaks Modbus TCP, reached through the same POST /command as the other protocols and described by a declarative map
// (GATEWAY_MODBUS_MAP_FILE), the way a connector of the hub describes itself. Nothing exists without the map: no map, no Modbus.
//
//   - Reading: "read" of a register by its name in the map (`modbus:<device>/<register>`): holding and input registers, coils and discrete
//     inputs, 16 and 32 bit integers, 32 bit floats and booleans, scaled to engineering units.
//   - Writing is a different thing and is held to more: it exists only while the write gate is on (GATEWAY_WRITES=1, off by default), only for
//     a register the map lists as writable with its own minimum and maximum (a writable register without a range is a map the gateway refuses
//     to start with), only through the two steps of the gate (prepare, then confirm) with the safety state of the cell READY, only for a caller
//     with the admin role, and every written value is READ BACK from the device and compared before the order counts as done. A value that
//     does not come back is reported as `write_unverified`, never as accepted. Every decision lands in the signed audit chain of the gate.
//   - Only the registers of the map can be touched: a target that is not in the map is refused before any connection is opened.
// What is NOT done: no function code beyond the six below, no broadcast (unit 0), no exception is retried (a failed write is never repeated
// by the gateway), and nothing here has been tried against a real PLC: the tests use a simulated Modbus TCP device.
// =============================================================================

import net from "node:net";
import type { CommandExecutor, CommandRequest } from "./command.js";
import type { WriteRule } from "./writeGate.js";

export type RegisterTable = "holding" | "input" | "coil" | "discrete";
export type RegisterType = "uint16" | "int16" | "uint32" | "int32" | "float32" | "bool";

export interface ModbusRegister {
  name: string;
  table: RegisterTable;
  /** The zero-based address of the first register or bit, as on the wire. */
  address: number;
  type: RegisterType;
  /** engineering value = raw * scale + offset (default 1 and 0). */
  scale: number;
  offset: number;
  /** Order of the two 16-bit words of a 32-bit value: "big" (high word first, default) or "little". */
  wordOrder: "big" | "little";
  writable: boolean;
  /** For a writable register: the range of engineering values that may be written. */
  min?: number;
  max?: number;
  /** How far the value read back may be from the one written (default: half a step of the scale). */
  tolerance?: number;
}

export interface ModbusDevice {
  id: string;
  host: string;
  port: number;
  unitId: number;
  timeoutMs: number;
  registers: Map<string, ModbusRegister>;
}

export interface ModbusMap {
  devices: Map<string, ModbusDevice>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const TABLES: readonly RegisterTable[] = ["holding", "input", "coil", "discrete"];
const TYPES: readonly RegisterType[] = ["uint16", "int16", "uint32", "int32", "float32", "bool"];

/** Registers a value of this type takes. */
function wordCount(type: RegisterType): number {
  return type === "uint32" || type === "int32" || type === "float32" ? 2 : 1;
}

/** The target text of a register in a command: `modbus:<device>/<register>`. */
export function modbusTarget(device: string, register: string): string {
  return `modbus:${device}/${register}`;
}

/** `modbus:<device>/<register>` to its two names, or null when it is not that. */
export function parseModbusTarget(target: string): { device: string; register: string } | null {
  const match = /^modbus:([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/.exec(target);
  return match ? { device: match[1], register: match[2] } : null;
}

function fail(where: string, problem: string): never {
  throw new Error(`Modbus map, ${where}: ${problem}`);
}

/** Reads the map from JSON text. An invalid entry stops the start: a map that is half understood would leave a register unprotected. */
export function parseModbusMap(text: string): ModbusMap {
  const parsed: unknown = JSON.parse(text);
  const list = (parsed as { devices?: unknown })?.devices;
  if (!Array.isArray(list) || list.length === 0) fail("file", 'it must be an object with a non-empty "devices" list');
  const devices = new Map<string, ModbusDevice>();
  for (const [d, rawDevice] of list.entries()) {
    const device = rawDevice as Record<string, unknown>;
    const where = `device ${d + 1}`;
    if (typeof device.id !== "string" || !NAME.test(device.id)) fail(where, "id must be letters, digits, '.', '_' or '-' (up to 64)");
    if (devices.has(device.id)) fail(where, `the device ${device.id} is listed twice`);
    if (typeof device.host !== "string" || device.host.trim() === "" || /[\s/]/.test(device.host)) fail(where, "host must be a host name or an address");
    const port = device.port === undefined ? 502 : device.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) fail(where, "port must be 1..65535");
    const unitId = device.unitId === undefined ? 1 : device.unitId;
    if (typeof unitId !== "number" || !Number.isInteger(unitId) || unitId < 1 || unitId > 247) fail(where, "unitId must be 1..247 (0 is the broadcast, which is never used)");
    const timeoutMs = device.timeoutMs === undefined ? 1500 : device.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000) fail(where, "timeoutMs must be 50..30000");
    const rawRegisters = device.registers;
    if (!Array.isArray(rawRegisters) || rawRegisters.length === 0) fail(where, 'it needs a non-empty "registers" list');
    const registers = new Map<string, ModbusRegister>();
    for (const [r, rawRegister] of rawRegisters.entries()) {
      const reg = rawRegister as Record<string, unknown>;
      const at = `${device.id} register ${r + 1}`;
      if (typeof reg.name !== "string" || !NAME.test(reg.name)) fail(at, "name must be letters, digits, '.', '_' or '-' (up to 64)");
      if (registers.has(reg.name)) fail(at, `the register ${reg.name} is listed twice`);
      if (!TABLES.includes(reg.table as RegisterTable)) fail(at, `table must be one of ${TABLES.join(", ")}`);
      const table = reg.table as RegisterTable;
      const bitTable = table === "coil" || table === "discrete";
      const type = (reg.type === undefined ? (bitTable ? "bool" : "uint16") : reg.type) as RegisterType;
      if (!TYPES.includes(type)) fail(at, `type must be one of ${TYPES.join(", ")}`);
      if (bitTable !== (type === "bool")) fail(at, bitTable ? "a coil or discrete input is a bool" : "a holding or input register is not a bool");
      if (typeof reg.address !== "number" || !Number.isInteger(reg.address) || reg.address < 0 || reg.address + wordCount(type) > 65536) fail(at, "address must be a whole number inside 0..65535");
      const scale = reg.scale === undefined ? 1 : reg.scale;
      const offset = reg.offset === undefined ? 0 : reg.offset;
      if (typeof scale !== "number" || !Number.isFinite(scale) || scale === 0) fail(at, "scale must be a finite number other than 0");
      if (typeof offset !== "number" || !Number.isFinite(offset)) fail(at, "offset must be a finite number");
      if (bitTable && (scale !== 1 || offset !== 0)) fail(at, "a bit has no scale or offset");
      const wordOrder = reg.wordOrder === undefined ? "big" : reg.wordOrder;
      if (wordOrder !== "big" && wordOrder !== "little") fail(at, 'wordOrder must be "big" or "little"');
      const writable = reg.writable === true;
      if (reg.writable !== undefined && typeof reg.writable !== "boolean") fail(at, "writable must be true or false");
      if (writable && (table === "input" || table === "discrete")) fail(at, "an input register or a discrete input cannot be written");
      let min: number | undefined;
      let max: number | undefined;
      if (writable && !bitTable) {
        // The range is the protection of the register: an unbounded setpoint is not a rule.
        if (typeof reg.min !== "number" || typeof reg.max !== "number" || !Number.isFinite(reg.min) || !Number.isFinite(reg.max)) fail(at, "a writable register needs a finite min and max");
        if (reg.min > reg.max) fail(at, "min is above max");
        min = reg.min;
        max = reg.max;
      } else if (reg.min !== undefined || reg.max !== undefined) {
        fail(at, "min and max are only for a writable register that is not a bit");
      }
      let tolerance: number | undefined;
      if (reg.tolerance !== undefined) {
        if (typeof reg.tolerance !== "number" || !Number.isFinite(reg.tolerance) || reg.tolerance < 0) fail(at, "tolerance must be a number of at least 0");
        tolerance = reg.tolerance;
      }
      registers.set(reg.name, { name: reg.name, table, address: reg.address, type, scale, offset, wordOrder, writable, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(tolerance !== undefined ? { tolerance } : {}) });
    }
    devices.set(device.id, { id: device.id, host: device.host, port, unitId, timeoutMs, registers });
  }
  return { devices };
}

/** The write rules of the gate that follow from the map: one per writable register, with the range of the map. */
export function modbusWriteRules(map: ModbusMap): WriteRule[] {
  const rules: WriteRule[] = [];
  for (const device of map.devices.values()) {
    for (const reg of device.registers.values()) {
      if (!reg.writable) continue;
      rules.push(reg.type === "bool" ? { target: modbusTarget(device.id, reg.name), type: "boolean" } : { target: modbusTarget(device.id, reg.name), type: "number", min: reg.min, max: reg.max });
    }
  }
  return rules;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The wire: MBAP header (transaction, protocol 0, length, unit) + PDU.
// ---------------------------------------------------------------------------------------------------------------------------------

export class ModbusError extends Error {
  constructor(
    message: string,
    /** The exception code of the device, when it answered with one. */
    readonly exceptionCode?: number,
  ) {
    super(message);
  }
}

const EXCEPTION_TEXT: Record<number, string> = { 1: "illegal function", 2: "illegal data address", 3: "illegal data value", 4: "device failure", 5: "acknowledge", 6: "device busy", 8: "memory parity error", 10: "gateway path unavailable", 11: "gateway target failed to respond" };

let nextTransaction = 1;

/** One request and its answer over a fresh connection (a PLC with few connections is not kept occupied). Resolves with the PDU of the answer. */
export function modbusExchange(device: Pick<ModbusDevice, "host" | "port" | "unitId" | "timeoutMs">, pdu: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const transaction = nextTransaction++ & 0xffff;
    const header = Buffer.alloc(7);
    header.writeUInt16BE(transaction, 0);
    header.writeUInt16BE(0, 2);
    header.writeUInt16BE(pdu.length + 1, 4);
    header.writeUInt8(device.unitId, 6);
    const socket = net.createConnection({ host: device.host, port: device.port });
    let received = Buffer.alloc(0);
    let done = false;
    const finish = (error: Error | null, value?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value as Buffer);
    };
    const timer = setTimeout(() => finish(new ModbusError(`the device did not answer within ${device.timeoutMs} ms`)), device.timeoutMs);
    socket.on("connect", () => socket.write(Buffer.concat([header, pdu])));
    socket.on("error", (error) => finish(new ModbusError(`connection failed: ${error.message}`)));
    socket.on("close", () => finish(new ModbusError("the device closed the connection before it answered")));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 7) return;
      const length = received.readUInt16BE(4);
      if (length < 2 || length > 254) return finish(new ModbusError("the answer has an impossible length"));
      if (received.length < 6 + length) return;
      if (received.readUInt16BE(0) !== transaction || received.readUInt16BE(2) !== 0 || received.readUInt8(6) !== device.unitId) return finish(new ModbusError("the answer is not for this request"));
      const answer = received.subarray(7, 6 + length);
      if ((answer[0] & 0x80) !== 0) {
        const code = answer[1] ?? 0;
        return finish(new ModbusError(`the device refused with exception ${code} (${EXCEPTION_TEXT[code] ?? "unknown"})`, code));
      }
      if (answer[0] !== pdu[0]) return finish(new ModbusError("the answer is for another function"));
      finish(null, answer);
    });
  });
}

function readPdu(table: RegisterTable, address: number, quantity: number): Buffer {
  const code = { coil: 1, discrete: 2, holding: 3, input: 4 }[table];
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(code, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(quantity, 3);
  return pdu;
}

/** Decodes the words of a 16/32 bit value to the number the device holds (before scale). */
export function decodeWords(type: RegisterType, words: number[], wordOrder: "big" | "little"): number {
  const buffer = Buffer.alloc(4);
  if (wordCount(type) === 1) {
    buffer.writeUInt16BE(words[0] & 0xffff, 0);
    return type === "int16" ? buffer.readInt16BE(0) : buffer.readUInt16BE(0);
  }
  const [high, low] = wordOrder === "big" ? [words[0], words[1]] : [words[1], words[0]];
  buffer.writeUInt16BE(high & 0xffff, 0);
  buffer.writeUInt16BE(low & 0xffff, 2);
  return type === "float32" ? buffer.readFloatBE(0) : type === "int32" ? buffer.readInt32BE(0) : buffer.readUInt32BE(0);
}

/** Encodes a raw number to the words of its type; null when it does not fit the type. */
export function encodeWords(type: RegisterType, raw: number, wordOrder: "big" | "little"): number[] | null {
  if (!Number.isFinite(raw)) return null;
  const buffer = Buffer.alloc(4);
  switch (type) {
    case "uint16":
      if (!Number.isInteger(raw) || raw < 0 || raw > 0xffff) return null;
      return [raw];
    case "int16":
      if (!Number.isInteger(raw) || raw < -0x8000 || raw > 0x7fff) return null;
      buffer.writeInt16BE(raw, 0);
      return [buffer.readUInt16BE(0)];
    case "uint32":
      if (!Number.isInteger(raw) || raw < 0 || raw > 0xffffffff) return null;
      buffer.writeUInt32BE(raw, 0);
      break;
    case "int32":
      if (!Number.isInteger(raw) || raw < -0x80000000 || raw > 0x7fffffff) return null;
      buffer.writeInt32BE(raw, 0);
      break;
    case "float32":
      buffer.writeFloatBE(raw, 0);
      if (!Number.isFinite(buffer.readFloatBE(0))) return null;
      break;
    default:
      return null;
  }
  const high = buffer.readUInt16BE(0);
  const low = buffer.readUInt16BE(2);
  return wordOrder === "big" ? [high, low] : [low, high];
}

/** Reads one register of a device and returns its engineering value (a boolean for a bit). */
export async function readRegister(device: ModbusDevice, reg: ModbusRegister): Promise<number | boolean> {
  if (reg.type === "bool") {
    const answer = await modbusExchange(device, readPdu(reg.table, reg.address, 1));
    if (answer.length < 3 || answer[1] < 1) throw new ModbusError("the answer is too short");
    return (answer[2] & 1) === 1;
  }
  const quantity = wordCount(reg.type);
  const answer = await modbusExchange(device, readPdu(reg.table, reg.address, quantity));
  if (answer.length < 2 + quantity * 2 || answer[1] !== quantity * 2) throw new ModbusError("the answer is too short");
  const words: number[] = [];
  for (let i = 0; i < quantity; i++) words.push(answer.readUInt16BE(2 + i * 2));
  const raw = decodeWords(reg.type, words, reg.wordOrder);
  return raw * reg.scale + reg.offset;
}

/** Writes one register (holding or coil). `value` is an engineering value, or a boolean for a bit. The caller has already been through the gate. */
export async function writeRegister(device: ModbusDevice, reg: ModbusRegister, value: number | boolean): Promise<void> {
  if (reg.table === "coil") {
    if (typeof value !== "boolean") throw new ModbusError("a coil takes true or false");
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(5, 0);
    pdu.writeUInt16BE(reg.address, 1);
    pdu.writeUInt16BE(value ? 0xff00 : 0x0000, 3);
    await modbusExchange(device, pdu);
    return;
  }
  if (reg.table !== "holding" || typeof value !== "number") throw new ModbusError("only a holding register or a coil can be written");
  const raw = (value - reg.offset) / reg.scale;
  const rounded = reg.type === "float32" ? raw : Math.round(raw);
  const words = encodeWords(reg.type, rounded, reg.wordOrder);
  if (!words) throw new ModbusError(`the value ${value} does not fit the type ${reg.type} of the register`);
  let pdu: Buffer;
  if (words.length === 1) {
    pdu = Buffer.alloc(5);
    pdu.writeUInt8(6, 0);
    pdu.writeUInt16BE(reg.address, 1);
    pdu.writeUInt16BE(words[0], 3);
  } else {
    pdu = Buffer.alloc(6 + words.length * 2);
    pdu.writeUInt8(16, 0);
    pdu.writeUInt16BE(reg.address, 1);
    pdu.writeUInt16BE(words.length, 3);
    pdu.writeUInt8(words.length * 2, 5);
    words.forEach((word, i) => pdu.writeUInt16BE(word, 6 + i * 2));
  }
  await modbusExchange(device, pdu);
}

/** Whether a value read back is the one that was written (a bit exactly; a number within the tolerance, by default half a step of the scale). */
export function readBackMatches(reg: ModbusRegister, written: number | boolean, readBack: number | boolean): boolean {
  if (typeof written === "boolean" || typeof readBack === "boolean") return written === readBack;
  const tolerance = reg.tolerance ?? (reg.type === "float32" ? Math.max(Math.abs(reg.scale), 1e-6) * 1e-3 + Math.abs(written) * 1e-6 : Math.abs(reg.scale) / 2);
  return Math.abs(written - readBack) <= tolerance + 1e-12;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The executor: what the dispatcher calls once a command has passed every other check.
// ---------------------------------------------------------------------------------------------------------------------------------

export interface ModbusExecutorResult {
  ok: boolean;
  detail?: string;
  /** For a read: the value. For a write: the value read back. */
  data?: unknown;
  /** false when a write was sent but the value read back differs (or could not be read). */
  verified?: boolean;
}

function lookup(map: ModbusMap, target: string): { device: ModbusDevice; reg: ModbusRegister } | string {
  const parsed = parseModbusTarget(target);
  if (!parsed) return `a Modbus target is modbus:<device>/<register>, got '${target}'`;
  const device = map.devices.get(parsed.device);
  if (!device) return `the map has no device '${parsed.device}'`;
  const reg = device.registers.get(parsed.register);
  if (!reg) return `the map of '${parsed.device}' has no register '${parsed.register}'`;
  return { device, reg };
}

/** The executor for protocol "Modbus": "read" and (after the gate) "write". */
export function createModbusExecutor(map: ModbusMap): (req: CommandRequest) => Promise<ModbusExecutorResult> {
  return async (req) => {
    const found = lookup(map, req.target);
    if (typeof found === "string") return { ok: false, detail: found };
    const { device, reg } = found;
    try {
      if (req.operation === "read") {
        return { ok: true, data: await readRegister(device, reg) };
      }
      if (req.operation === "write") {
        // Defence in depth: the gate already checked all of this, and the executor does not rely on it.
        if (!reg.writable) return { ok: false, detail: `the register '${reg.name}' is not writable in the map` };
        const value = req.value;
        if (reg.type === "bool" ? typeof value !== "boolean" : typeof value !== "number" || !Number.isFinite(value)) return { ok: false, detail: "the value does not have the type of the register" };
        if (typeof value === "number" && (value < (reg.min as number) || value > (reg.max as number))) return { ok: false, detail: `the value ${value} is outside the range ${reg.min}..${reg.max} of the register` };
        try {
          await writeRegister(device, reg, value as number | boolean);
        } catch (error) {
          return { ok: false, detail: `the write failed and was not repeated: ${(error as Error).message}` };
        }
        let readBack: number | boolean;
        try {
          readBack = await readRegister(device, reg);
        } catch (error) {
          return { ok: true, verified: false, detail: `the value was sent but could not be read back: ${(error as Error).message}` };
        }
        const verified = readBackMatches(reg, value as number | boolean, readBack);
        return verified ? { ok: true, verified: true, data: readBack, detail: `verified: read back ${String(readBack)}` } : { ok: true, verified: false, data: readBack, detail: `the value read back (${String(readBack)}) is not the one written (${String(value)})` };
      }
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
    return { ok: false, detail: `the operation '${req.operation}' is not one of the Modbus adapter` };
  };
}

/** GATEWAY_MODBUS_MAP_FILE: the path of the map, or undefined while the adapter is off. */
export function modbusMapFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.GATEWAY_MODBUS_MAP_FILE?.trim();
  return file ? file : undefined;
}

/** The status of the devices of the map: which ones answer a one-register read of their first register (for GET /status). */
export async function probeModbusDevice(device: ModbusDevice): Promise<{ reachable: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  const first = [...device.registers.values()].find((r) => r.table === "holding" || r.table === "input") ?? [...device.registers.values()][0];
  try {
    await readRegister(device, first);
    return { reachable: true, latencyMs: Date.now() - started };
  } catch (error) {
    // an exception of the device is an answer: the device is there, even if it refused this address
    if (error instanceof ModbusError && error.exceptionCode !== undefined) return { reachable: true, latencyMs: Date.now() - started };
    return { reachable: false, latencyMs: Date.now() - started, error: (error as Error).message };
  }
}
