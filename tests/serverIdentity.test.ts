// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/serverIdentity.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The common identity of the family on the gateway: a signed token of HYDRA-UMC-SERVER. Off by default (nothing changes); on, GET /health and /status need an
// identity too, a viewer reads but does not command, and the scopes of an identity are the ones the configuration gives.
// =============================================================================
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "../src/server.js";
import { CommandDispatcher } from "../src/command.js";
import { commandAuthStartupProblem } from "../src/auth.js";
import { DEFAULT_IDENTITY_SCOPES, IdentityError, identityScopes, resolveIdentityKey, signServerToken, verifyServerToken } from "../src/serverIdentity.js";

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

const KEY = Buffer.from("a-signing-key-of-the-server-0123456789", "utf8");

function appWithIdentity() {
  const dispatcher = new CommandDispatcher({ executor: async () => ({ ok: true }) });
  return buildApp({ commandDispatcher: dispatcher, identityKey: KEY });
}

function forge(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }, key: Buffer = KEY): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = part(header);
  const body = part(claims);
  return `${head}.${body}.${crypto.createHmac("sha256", key).update(`${head}.${body}`).digest().toString("base64url")}`;
}

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const COMMAND = { protocol: "OPC-UA", operation: "read", target: "ns=2;s=Temperature" };

describe("verifyServerToken", () => {
  it("accepts a token of the SERVER and names who and what role", () => {
    expect(verifyServerToken(signServerToken(KEY, "ana", "operator"), KEY)).toEqual({ username: "ana", role: "operator" });
  });
  it("refuses alg none, another algorithm, a wrong key, an expired, a missing or non-finite expiry and an unknown role", () => {
    const refused = (token: string) => expect(() => verifyServerToken(token, KEY)).toThrow(IdentityError);
    refused(`${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ username: "x", role: "admin", exp: inAnHour() })).toString("base64url")}.x`);
    refused(forge({ username: "x", role: "admin", exp: inAnHour() }, { alg: "HS512" }));
    refused(forge({ username: "x", role: "admin", exp: inAnHour() }, undefined, Buffer.from("another-key-another-key-another-key-0")));
    refused(forge({ username: "x", role: "admin", exp: 1 }));
    refused(forge({ username: "x", role: "admin" }));
    refused(forge({ username: "x", role: "admin", exp: "soon" }));
    refused(forge({ username: "x", role: "root", exp: inAnHour() }));
    refused(forge({ username: "", role: "admin", exp: inAnHour() }));
    refused(forge({ username: "x", role: "admin", exp: inAnHour(), nbf: inAnHour() }));
    refused(forge({ username: "x", role: "admin", exp: inAnHour(), iat: inAnHour() }));
    refused("not.a.jwt.at.all");
    refused("");
  });
});

describe("the key", () => {
  it("is off without a file, and refuses a missing or short one", () => {
    expect(resolveIdentityKey({})).toBeNull();
    expect(() => resolveIdentityKey({ GATEWAY_IDENTITY_KEY_FILE: "/nope" }, () => { throw new Error("ENOENT"); })).toThrow(/cannot be read/);
    expect(() => resolveIdentityKey({ GATEWAY_IDENTITY_KEY_FILE: "/k" }, () => "short")).toThrow(/at least 32/);
    expect(resolveIdentityKey({ GATEWAY_IDENTITY_KEY_FILE: "/k" }, () => `${KEY.toString()}\n`)?.equals(KEY)).toBe(true);
  });
  it("is itself a credential: a gateway without GATEWAY_JWT_SECRET is not open when the identity is on", () => {
    expect(commandAuthStartupProblem({ GATEWAY_IDENTITY_KEY_FILE: "/k" })).toBeNull();
    expect(commandAuthStartupProblem({})).toMatch(/GATEWAY_JWT_SECRET is not set/);
  });
  it("gives an identity only the operations the dispatcher allows, unless the configuration says more", () => {
    expect(identityScopes({})).toEqual(DEFAULT_IDENTITY_SCOPES);
    expect(identityScopes({ GATEWAY_IDENTITY_SCOPES: "Modbus:write, mqtt:publish" })).toEqual(["modbus:write", "mqtt:publish"]);
  });
});

describe("the gateway with the identity on: nothing is open", () => {
  it("asks for an identity on /health and /status, loopback included", async () => {
    const app = appWithIdentity();
    expect((await request(app).get("/health")).status).toBe(401);
    expect((await request(app).get("/status")).status).toBe(401);
    expect((await request(app).get("/health").set("Authorization", "Bearer garbage")).status).toBe(403);
    expect((await request(app).get("/health").set("Authorization", `Bearer ${forge({ username: "x", role: "admin", exp: 1 })}`)).status).toBe(403);
  });
  it("answers /health to any role, and the probe of the container signs its own token", async () => {
    const app = appWithIdentity();
    for (const role of ["viewer", "operator", "admin"] as const) {
      const res = await request(app).get("/health").set("Authorization", `Bearer ${signServerToken(KEY, "u", role)}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    }
    expect((await request(app).get("/health").set("Authorization", `Bearer ${signServerToken(KEY)}`)).status).toBe(200);
  });
  it("lets an operator command, refuses a viewer, and refuses a request with no credential", async () => {
    const app = appWithIdentity();
    expect((await request(app).post("/command").send(COMMAND)).status).toBe(401);
    const viewer = await request(app).post("/command").set("Authorization", `Bearer ${signServerToken(KEY, "vic", "viewer")}`).send(COMMAND);
    expect(viewer.status).toBe(403);
    const operator = await request(app).post("/command").set("Authorization", `Bearer ${signServerToken(KEY, "ana", "operator")}`).send(COMMAND);
    expect(operator.status).toBe(200);
  });
  it("keeps the allowlist and the scopes: an identity cannot run an operation outside its scopes", async () => {
    const app = appWithIdentity();
    const res = await request(app)
      .post("/command")
      .set("Authorization", `Bearer ${signServerToken(KEY, "ana", "operator")}`)
      .send({ protocol: "Modbus", operation: "write", target: "t", value: 1 });
    expect(res.status).toBe(403);
  });
});

describe("the gateway without the identity", () => {
  it("is as before: /health and /status are open", async () => {
    const app = buildApp({ commandDispatcher: new CommandDispatcher({ executor: async () => ({ ok: true }) }), identityKey: null });
    expect((await request(app).get("/health")).status).toBe(200);
  });
});
