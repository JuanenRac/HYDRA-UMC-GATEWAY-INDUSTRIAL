// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/auth.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real contract test: with GATEWAY_JWT_SECRET configured, POST /command
// must reject a missing token (401), a token signed with the wrong
// secret (403), and a hand-built alg:none token (403) - then accept a
// real HS256 token signed with the configured secret. Without
// GATEWAY_JWT_SECRET set at all, POST /command must behave exactly as
// before this change (no auth middleware applied) - covered already by
// tests/server.test.ts, which never sets this env var.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";
import { buildApp } from "../src/server.js";
import { CommandDispatcher } from "../src/command.js";

const originalEnv = { ...process.env };
const SECRET = "test-gateway-secret";

function base64url(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

beforeEach(() => {
  process.env.GATEWAY_JWT_SECRET = SECRET;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function buildAcceptingApp() {
  const dispatcher = new CommandDispatcher({ executor: async () => ({ ok: true }) });
  return buildApp({ commandDispatcher: dispatcher });
}

describe("HYDRA-UMC-GATEWAY-INDUSTRIAL POST /command (real JWT caller auth, opt-in)", () => {
  it("rejects a request with no Authorization header at all (401)", async () => {
    const res = await request(buildAcceptingApp())
      .post("/command")
      .send({ protocol: "OPC-UA", operation: "read", target: "t" });
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret (403)", async () => {
    const token = jwt.sign({ sub: "attacker" }, "wrong-secret", { algorithm: "HS256" });
    const res = await request(buildAcceptingApp())
      .post("/command")
      .set("Authorization", `Bearer ${token}`)
      .send({ protocol: "OPC-UA", operation: "read", target: "t" });
    expect(res.status).toBe(403);
  });

  it("rejects a hand-built alg:none token even with a well-formed payload (403)", async () => {
    const header = base64url({ alg: "none", typ: "JWT" });
    const payload = base64url({ sub: "attacker" });
    const forged = `${header}.${payload}.`;
    const res = await request(buildAcceptingApp())
      .post("/command")
      .set("Authorization", `Bearer ${forged}`)
      .send({ protocol: "OPC-UA", operation: "read", target: "t" });
    expect(res.status).toBe(403);
  });

  it("accepts a real HS256 token signed with the configured secret", async () => {
    const token = jwt.sign({ sub: "technician-1" }, SECRET, { algorithm: "HS256" });
    const res = await request(buildAcceptingApp())
      .post("/command")
      .set("Authorization", `Bearer ${token}`)
      .send({ protocol: "OPC-UA", operation: "read", target: "t" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
  });
});
