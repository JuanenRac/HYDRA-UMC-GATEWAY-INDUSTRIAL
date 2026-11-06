// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - A simulated Modbus TCP device: src/modbusSimulator.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// A stand-in for a PLC, to try the whole Modbus path without one: an in-memory table of holding registers, input registers, coils and discrete
// inputs behind a real Modbus TCP listener (function codes 1, 2, 3, 4, 5, 6 and 16). It is what the tests use; it is not a model of any
// real controller, and it says nothing about how a real one behaves.
// =============================================================================

import net from "node:net";

export interface SimulatedModbusOptions {
  unitId?: number;
  /** Accept writes but do not apply them (a device that ignores a setpoint): the read back then differs. */
  ignoreWrites?: boolean;
  /** Answer every request with this exception code. */
  alwaysException?: number;
  /** Wait this long before every answer. */
  delayMs?: number;
}

export interface SimulatedModbusDevice {
  port: number;
  holding: Uint16Array;
  input: Uint16Array;
  coils: Uint8Array;
  discrete: Uint8Array;
  /** Every request received, as [function code, address]. */
  requests: Array<[number, number]>;
  close(): Promise<void>;
}

const SIZE = 1024;

export async function startSimulatedModbus(options: SimulatedModbusOptions = {}): Promise<SimulatedModbusDevice> {
  const unitId = options.unitId ?? 1;
  const holding = new Uint16Array(SIZE);
  const input = new Uint16Array(SIZE);
  const coils = new Uint8Array(SIZE);
  const discrete = new Uint8Array(SIZE);
  const requests: Array<[number, number]> = [];
  const sockets = new Set<net.Socket>();

  const respond = (socket: net.Socket, header: Buffer, pdu: Buffer) => {
    const out = Buffer.alloc(7 + pdu.length);
    header.copy(out, 0, 0, 4);
    out.writeUInt16BE(pdu.length + 1, 4);
    out.writeUInt8(unitId, 6);
    pdu.copy(out, 7);
    const send = () => socket.writable && socket.write(out);
    if (options.delayMs) setTimeout(send, options.delayMs);
    else send();
  };
  const exception = (code: number, ex: number) => Buffer.from([code | 0x80, ex]);

  const handle = (socket: net.Socket, header: Buffer, pdu: Buffer) => {
    const code = pdu[0];
    const address = pdu.length >= 3 ? pdu.readUInt16BE(1) : 0;
    requests.push([code, address]);
    if (options.alwaysException) return respond(socket, header, exception(code, options.alwaysException));
    const quantity = pdu.length >= 5 ? pdu.readUInt16BE(3) : 0;
    switch (code) {
      case 3:
      case 4: {
        const table = code === 3 ? holding : input;
        if (quantity < 1 || quantity > 125 || address + quantity > SIZE) return respond(socket, header, exception(code, 2));
        const out = Buffer.alloc(2 + quantity * 2);
        out[0] = code;
        out[1] = quantity * 2;
        for (let i = 0; i < quantity; i++) out.writeUInt16BE(table[address + i], 2 + i * 2);
        return respond(socket, header, out);
      }
      case 1:
      case 2: {
        const table = code === 1 ? coils : discrete;
        if (quantity < 1 || quantity > 2000 || address + quantity > SIZE) return respond(socket, header, exception(code, 2));
        const bytes = Math.ceil(quantity / 8);
        const out = Buffer.alloc(2 + bytes);
        out[0] = code;
        out[1] = bytes;
        for (let i = 0; i < quantity; i++) if (table[address + i]) out[2 + (i >> 3)] |= 1 << (i & 7);
        return respond(socket, header, out);
      }
      case 5: {
        const value = pdu.readUInt16BE(3);
        if (address >= SIZE) return respond(socket, header, exception(code, 2));
        if (value !== 0xff00 && value !== 0) return respond(socket, header, exception(code, 3));
        if (!options.ignoreWrites) coils[address] = value === 0xff00 ? 1 : 0;
        return respond(socket, header, Buffer.from(pdu.subarray(0, 5)));
      }
      case 6: {
        if (address >= SIZE) return respond(socket, header, exception(code, 2));
        if (!options.ignoreWrites) holding[address] = pdu.readUInt16BE(3);
        return respond(socket, header, Buffer.from(pdu.subarray(0, 5)));
      }
      case 16: {
        const bytes = pdu[5];
        if (quantity < 1 || quantity > 123 || bytes !== quantity * 2 || address + quantity > SIZE) return respond(socket, header, exception(code, 2));
        if (!options.ignoreWrites) for (let i = 0; i < quantity; i++) holding[address + i] = pdu.readUInt16BE(6 + i * 2);
        return respond(socket, header, Buffer.from(pdu.subarray(0, 5)));
      }
      default:
        return respond(socket, header, exception(code, 1));
    }
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk as Buffer]);
      while (buffer.length >= 8) {
        const length = buffer.readUInt16BE(4);
        if (buffer.length < 6 + length) return;
        const header = buffer.subarray(0, 7);
        const pdu = buffer.subarray(7, 6 + length);
        buffer = buffer.subarray(6 + length);
        if (header.readUInt8(6) !== unitId) continue; // not for this unit: no answer, as on a real bus
        handle(socket, Buffer.from(header), Buffer.from(pdu));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    holding,
    input,
    coils,
    discrete,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
