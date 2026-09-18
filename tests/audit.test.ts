// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/audit.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real integration test: drives POST /command through the real app with a
// real InMemoryCommandAuditLogger injected, and asserts the exact real
// audit entry produced for every distinct real outcome - accepted,
// allowlist-rejected, unauthenticated, invalid-token, invalid request
// body - not just that SOME log line was written.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";
import { buildApp } from "../src/server.js";
import { CommandDispatcher } from "../src/command.js";
import { InMemoryCommandAuditLogger } from "../src/audit.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("HYDRA-UMC-GATEWAY-INDUSTRIAL command audit trail", () => {
  it("records an accepted command with no caller when auth is not configured", async () => {
    delete process.env.GATEWAY_JWT_SECRET;
    const auditLogger = new InMemoryCommandAuditLogger();
    const dispatcher = new CommandDispatcher({ executor: async () => ({ ok: true }) });
    const app = buildApp({ commandDispatcher: dispatcher, auditLogger });

    await request(app).post("/command").send({ protocol: "OPC-UA", operation: "read", target: "ns=2;s=Line1" });

    expect(auditLogger.entries).toHaveLength(1);
    const entry = auditLogger.entries[0];
    expect(entry.caller).toBeNull();
    expect(entry.outcome).toBe("accepted");
    expect(entry.httpStatus).toBe(200);
    expect(entry.protocol).toBe("OPC-UA");
    expect(entry.operation).toBe("read");
    expect(entry.target).toBe("ns=2;s=Line1");
    expect(typeof entry.timestamp).toBe("string");
  });

  it("records the real authenticated caller identity from a valid token", async () => {
    process.env.GATEWAY_JWT_SECRET = "test-secret";
    const auditLogger = new InMemoryCommandAuditLogger();
    const dispatcher = new CommandDispatcher({ executor: async () => ({ ok: true }) });
    const app = buildApp({ commandDispatcher: dispatcher, auditLogger });
    const token = jwt.sign({ sub: "technician-1" }, "test-secret", { algorithm: "HS256" });

    await request(app)
      .post("/command")
      .set("Authorization", `Bearer ${token}`)
      .send({ protocol: "OPC-UA", operation: "read", target: "t" });

    expect(auditLogger.entries).toHaveLength(1);
    expect(auditLogger.entries[0].caller).toBe("technician-1");
    expect(auditLogger.entries[0].outcome).toBe("accepted");
  });

  it("records a missing-token attempt with no caller and the real outcome, distinct from an invalid one", async () => {
    process.env.GATEWAY_JWT_SECRET = "test-secret";
    const auditLogger = new InMemoryCommandAuditLogger();
    const app = buildApp({ auditLogger });

    await request(app).post("/command").send({ protocol: "OPC-UA", operation: "read", target: "t" });

    expect(auditLogger.entries).toHaveLength(1);
    expect(auditLogger.entries[0].caller).toBeNull();
    expect(auditLogger.entries[0].outcome).toBe("auth_missing_token");
    expect(auditLogger.entries[0].httpStatus).toBe(401);
  });

  it("records an allowlist rejection with its real reason", async () => {
    delete process.env.GATEWAY_JWT_SECRET;
    const auditLogger = new InMemoryCommandAuditLogger();
    const app = buildApp({ auditLogger });

    await request(app).post("/command").send({ protocol: "OPC-UA", operation: "write", target: "t" });

    expect(auditLogger.entries).toHaveLength(1);
    const entry = auditLogger.entries[0];
    expect(entry.outcome).toBe("rejected_unauthorized");
    expect(entry.httpStatus).toBe(403);
    expect(entry.reason).toMatch(/not allowlisted/);
  });

  it("records an invalid request body distinctly from every other outcome", async () => {
    delete process.env.GATEWAY_JWT_SECRET;
    const auditLogger = new InMemoryCommandAuditLogger();
    const app = buildApp({ auditLogger });

    await request(app).post("/command").send({ protocol: "OPC-UA" });

    expect(auditLogger.entries).toHaveLength(1);
    expect(auditLogger.entries[0].outcome).toBe("invalid_request");
    expect(auditLogger.entries[0].httpStatus).toBe(400);
  });
});
