// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/protocol-probes.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The protocol probes (GATEWAY_PROBE_MODE=protocol) against small real servers that speak, or
// pretend to speak, each protocol: a TCP connect alone would call all of them reachable.
// =============================================================================
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMqttConnect,
  buildOpcUaHello,
  probeMqtt,
  probeMtconnect,
  probeOpcUa,
  probeTcp,
  resolveProbeMode,
} from "../src/probes.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A TCP server that hands each connection's first chunk to `reply` and writes back what it returns (nothing when it returns null). */
async function tcpServer(reply: (request: Buffer) => Buffer | null): Promise<{ port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.once("data", (chunk) => {
      received.push(chunk);
      const answer = reply(chunk);
      if (answer) socket.write(answer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as net.AddressInfo).port, received };
}

const acknowledge = () => {
  const ack = Buffer.alloc(28);
  ack.write("ACKF", 0, "ascii");
  ack.writeUInt32LE(28, 4);
  return ack;
};
const connack = (code: number) => Buffer.from([0x20, 0x02, 0x00, code]);

describe("the OPC UA Hello probe", () => {
  it("sends a well-formed Hello and takes an Acknowledge as reachable", async () => {
    const { port, received } = await tcpServer(() => acknowledge());
    const result = await probeOpcUa("127.0.0.1", port, "opc.tcp://plant:4840/x", 1000);
    expect(result.reachable).toBe(true);
    const hello = received[0];
    expect(hello.subarray(0, 4).toString("ascii")).toBe("HELF");
    expect(hello.readUInt32LE(4)).toBe(hello.length);
    expect(hello.readInt32LE(28)).toBe("opc.tcp://plant:4840/x".length);
    expect(hello.subarray(32).toString("utf8")).toBe("opc.tcp://plant:4840/x");
  });

  it("calls a port that accepts the connection and says nothing unreachable (a TCP connect would not)", async () => {
    const { port } = await tcpServer(() => null);
    expect((await probeTcp("127.0.0.1", port, 300)).reachable).toBe(true);
    const result = await probeOpcUa("127.0.0.1", port, "opc.tcp://x", 300);
    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(/no answer/);
  });

  it("calls an Error message and a different protocol unreachable, with the reason", async () => {
    const err = Buffer.alloc(16);
    err.write("ERRF", 0, "ascii");
    const refused = await tcpServer(() => err);
    expect(await probeOpcUa("127.0.0.1", refused.port, "opc.tcp://x", 500)).toMatchObject({ reachable: false, error: expect.stringContaining("Error message") });
    const web = await tcpServer(() => Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n"));
    expect(await probeOpcUa("127.0.0.1", web.port, "opc.tcp://x", 500)).toMatchObject({ reachable: false, error: expect.stringContaining("not an OPC UA server") });
  });

  it("reports a closed port", async () => {
    const { port } = await tcpServer(() => null);
    await closers.pop()!();
    expect((await probeOpcUa("127.0.0.1", port, "opc.tcp://x", 300)).reachable).toBe(false);
  });

  it("the Hello message has the layout of the specification", () => {
    const hello = buildOpcUaHello("opc.tcp://h:1/p");
    expect(hello.readUInt32LE(8)).toBe(0); // protocol version
    expect(hello.readUInt32LE(12)).toBe(65536);
    expect(hello.length).toBe(32 + "opc.tcp://h:1/p".length);
  });
});

describe("the MQTT CONNECT probe", () => {
  it("sends CONNECT 3.1.1 and takes CONNACK 0 as reachable", async () => {
    const { port, received } = await tcpServer(() => connack(0));
    const result = await probeMqtt("127.0.0.1", port, {}, 1000);
    expect(result.reachable).toBe(true);
    const connect = received[0];
    expect(connect[0]).toBe(0x10);
    expect(connect.subarray(2, 8).toString("latin1")).toBe("\u0000\u0004MQTT");
    expect(connect[8]).toBe(0x04); // protocol level 3.1.1
    expect(connect[9] & 0x02).toBe(0x02); // clean session
  });

  it("carries the probe's account and client ID when they are set", () => {
    const packet = buildMqttConnect({ clientId: "probe-1", username: "gw", password: "secret" });
    const text = packet.toString("latin1");
    expect(text).toContain("probe-1");
    expect(text).toContain("gw");
    expect(text).toContain("secret");
    expect(packet[9] & 0xc0).toBe(0xc0); // username and password flags
    expect(packet[1]).toBe(packet.length - 2);
  });

  it("a broker that refuses the probe's credentials is up: reachable, with the reason", async () => {
    for (const code of [4, 5]) {
      const { port } = await tcpServer(() => connack(code));
      const result = await probeMqtt("127.0.0.1", port, {}, 500);
      expect(result).toMatchObject({ reachable: true, detail: expect.stringContaining(`CONNACK ${code}`) });
    }
  });

  it("other refusals, a silent port and another protocol are unreachable", async () => {
    expect(await probeMqtt("127.0.0.1", (await tcpServer(() => connack(1))).port, {}, 500)).toMatchObject({ reachable: false, error: expect.stringContaining("CONNACK 1") });
    expect((await probeMqtt("127.0.0.1", (await tcpServer(() => null)).port, {}, 300)).reachable).toBe(false);
    expect(await probeMqtt("127.0.0.1", (await tcpServer(() => Buffer.from("HTTP/1.1 400\r\n\r\n"))).port, {}, 500)).toMatchObject({ reachable: false, error: expect.stringContaining("not an MQTT broker") });
  });
});

async function httpServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/probe`;
}

describe("the MTConnect /probe probe", () => {
  it("requires an MTConnectDevices document", async () => {
    const url = await httpServer((_req, res) => {
      res.setHeader("content-type", "application/xml");
      res.end('<?xml version="1.0"?><MTConnectDevices xmlns="urn:mtconnect.org:MTConnectDevices:1.7"></MTConnectDevices>');
    });
    expect((await probeMtconnect(url, 1000)).reachable).toBe(true);
  });

  it("calls an MTConnectError, an HTML page and an error status unreachable", async () => {
    const error = await httpServer((_req, res) => res.end('<MTConnectError xmlns="x"><Errors/></MTConnectError>'));
    expect(await probeMtconnect(error, 1000)).toMatchObject({ reachable: false, error: expect.stringContaining("MTConnectError") });
    const page = await httpServer((_req, res) => res.end("<html>welcome</html>"));
    expect(await probeMtconnect(page, 1000)).toMatchObject({ reachable: false, error: expect.stringContaining("not an MTConnectDevices") });
    const broken = await httpServer((_req, res) => res.writeHead(503).end());
    expect(await probeMtconnect(broken, 1000)).toMatchObject({ reachable: false, error: "HTTP 503" });
  });

  it("reads a bounded amount of a huge body", async () => {
    const url = await httpServer((_req, res) => {
      res.write("x".repeat(64 * 1024));
      const timer = setInterval(() => res.write("x".repeat(64 * 1024)), 5);
      res.on("close", () => clearInterval(timer));
    });
    const result = await probeMtconnect(url, 1000);
    expect(result.reachable).toBe(false);
  });
});

describe("GATEWAY_PROBE_MODE", () => {
  it("is tcp unless it says protocol, and anything else is an error", () => {
    expect(resolveProbeMode({})).toBe("tcp");
    expect(resolveProbeMode({ GATEWAY_PROBE_MODE: "TCP" })).toBe("tcp");
    expect(resolveProbeMode({ GATEWAY_PROBE_MODE: "protocol" })).toBe("protocol");
    expect(() => resolveProbeMode({ GATEWAY_PROBE_MODE: "deep" })).toThrow(/GATEWAY_PROBE_MODE/);
  });
});
