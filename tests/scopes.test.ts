// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/scopes.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// A token names what its holder may do, per protocol and operation: a valid token without the scope of the command is refused, however current and
// well signed it is.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";
import { buildApp } from "../src/server.js";
import { CommandDispatcher } from "../src/command.js";
import { resolveCertScopes, scopeAllows, scopesFromPayload, scopesRequired } from "../src/auth.js";

const originalEnv = { ...process.env };
const SECRET = "test-gateway-secret";

beforeEach(() => {
  process.env.GATEWAY_JWT_SECRET = SECRET;
});
afterEach(() => {
  process.env = { ...originalEnv };
});

function app() {
  return buildApp({ commandDispatcher: new CommandDispatcher({ executor: async () => ({ ok: true }) }) });
}
function token(claims: Record<string, unknown>): string {
  return jwt.sign({ sub: "tech", ...claims }, SECRET, { algorithm: "HS256", expiresIn: "1h" });
}
function send(bearer: string, protocol: string, operation: string, target: string) {
  return request(app()).post("/command").set("Authorization", `Bearer ${bearer}`).send({ protocol, operation, target });
}

describe("scope matching", () => {
  it("matches protocol and operation, ignoring case, with protocol-wide and total wildcards", () => {
    expect(scopeAllows(["mqtt:publish"], "MQTT", "publish")).toBe(true);
    expect(scopeAllows(["mqtt:publish"], "MQTT", "read")).toBe(false);
    expect(scopeAllows(["mqtt:publish"], "OPC-UA", "publish")).toBe(false);
    expect(scopeAllows(["opc-ua:*"], "OPC-UA", "read")).toBe(true);
    expect(scopeAllows(["opc-ua:*"], "MTConnect", "read")).toBe(false);
    expect(scopeAllows(["*"], "MTConnect", "read")).toBe(true);
    expect(scopeAllows([], "MQTT", "publish")).toBe(false);
    // a prefix of a scope is not the scope
    expect(scopeAllows(["mqtt:pub"], "MQTT", "publish")).toBe(false);
  });

  it("reads the standard scope string and the scopes / scp arrays, and nothing else", () => {
    expect(scopesFromPayload({ scope: "mqtt:publish  OPC-UA:read" })).toEqual(["mqtt:publish", "opc-ua:read"]);
    expect(scopesFromPayload({ scopes: ["mqtt:publish", 7, null] })).toEqual(["mqtt:publish"]);
    expect(scopesFromPayload({ scp: ["*"] })).toEqual(["*"]);
    expect(scopesFromPayload({ scope: 5, scopes: "mqtt:publish" })).toEqual([]);
    expect(scopesFromPayload({})).toEqual([]);
  });

  it("requires scopes unless GATEWAY_REQUIRE_SCOPES is exactly 0, and gives a certificate only what GATEWAY_CERT_SCOPES lists", () => {
    expect(scopesRequired({})).toBe(true);
    expect(scopesRequired({ GATEWAY_REQUIRE_SCOPES: "1" })).toBe(true);
    expect(scopesRequired({ GATEWAY_REQUIRE_SCOPES: "false" })).toBe(true);
    expect(scopesRequired({ GATEWAY_REQUIRE_SCOPES: "0" })).toBe(false);
    expect(resolveCertScopes({})).toEqual([]);
    expect(resolveCertScopes({ GATEWAY_CERT_SCOPES: "OPC-UA:read, mtconnect:read" })).toEqual(["opc-ua:read", "mtconnect:read"]);
  });
});

describe("POST /command with scopes", () => {
  it("accepts the operation the token names", async () => {
    const res = await send(token({ scope: "mqtt:publish" }), "MQTT", "publish", "hydra/gateway/x");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
  });

  it("refuses a valid token that names another operation or protocol (403)", async () => {
    const other = await send(token({ scope: "opc-ua:read" }), "MQTT", "publish", "hydra/gateway/x");
    expect(other.status).toBe(403);
    expect(other.body.error).toMatch(/no scope for mqtt:publish/);
    const otherOperation = await send(token({ scope: "mqtt:subscribe" }), "MQTT", "publish", "hydra/gateway/x");
    expect(otherOperation.status).toBe(403);
  });

  it("refuses a valid token with no scope at all", async () => {
    expect((await send(token({}), "OPC-UA", "read", "t")).status).toBe(403);
  });

  it("lets a protocol-wide scope cover every operation of that protocol only", async () => {
    expect((await send(token({ scope: "opc-ua:*" }), "OPC-UA", "read", "t")).status).toBe(200);
    expect((await send(token({ scope: "opc-ua:*" }), "MTConnect", "read", "t")).status).toBe(403);
  });

  it("judges the scope before the allowlist: a scope cannot make a non-allowlisted operation run", async () => {
    const res = await send(token({ scope: "*" }), "OPC-UA", "write", "t");
    expect(res.status).not.toBe(200);
    expect(res.body.status).toBe("rejected_unauthorized");
  });

  it("GATEWAY_REQUIRE_SCOPES=0 brings back the old behaviour: any valid token, any allowlisted operation", async () => {
    process.env.GATEWAY_REQUIRE_SCOPES = "0";
    expect((await send(token({}), "OPC-UA", "read", "t")).status).toBe(200);
  });

  it("an open lab gateway (no secret, anonymous on purpose) is not judged by scopes", async () => {
    delete process.env.GATEWAY_JWT_SECRET;
    const res = await request(app()).post("/command").send({ protocol: "OPC-UA", operation: "read", target: "t" });
    expect(res.status).toBe(200);
  });
});
