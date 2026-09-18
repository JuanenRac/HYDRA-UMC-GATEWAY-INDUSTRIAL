// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/rateLimit.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "../src/server.js";
import { CommandDispatcher } from "../src/command.js";
import { CommandRateLimiter, resolveRateLimitConfig } from "../src/rateLimit.js";
import { InMemoryCommandAuditLogger } from "../src/audit.js";

describe("CommandRateLimiter (unit)", () => {
  it("allows up to maxRequests within one window, then rejects", () => {
    const limiter = new CommandRateLimiter({ windowMs: 60_000, maxRequests: 3 });
    const now = Date.now();
    expect(limiter.check("caller-a", now).allowed).toBe(true);
    expect(limiter.check("caller-a", now).allowed).toBe(true);
    expect(limiter.check("caller-a", now).allowed).toBe(true);
    const fourth = limiter.check("caller-a", now);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks separate callers independently", () => {
    const limiter = new CommandRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const now = Date.now();
    expect(limiter.check("caller-a", now).allowed).toBe(true);
    expect(limiter.check("caller-b", now).allowed).toBe(true);
    expect(limiter.check("caller-a", now).allowed).toBe(false);
  });

  it("resets the window once it has fully elapsed", () => {
    const limiter = new CommandRateLimiter({ windowMs: 1000, maxRequests: 1 });
    const now = Date.now();
    expect(limiter.check("caller-a", now).allowed).toBe(true);
    expect(limiter.check("caller-a", now + 500).allowed).toBe(false);
    expect(limiter.check("caller-a", now + 1000).allowed).toBe(true);
  });

  it("resolveRateLimitConfig falls back to real defaults on invalid/missing env values", () => {
    const config = resolveRateLimitConfig({});
    expect(config.windowMs).toBeGreaterThan(0);
    expect(config.maxRequests).toBeGreaterThan(0);
  });

  it("resolveRateLimitConfig honors real, valid env overrides", () => {
    const config = resolveRateLimitConfig({ GATEWAY_COMMAND_RATE_WINDOW_MS: "5000", GATEWAY_COMMAND_RATE_MAX: "2" });
    expect(config).toEqual({ windowMs: 5000, maxRequests: 2 });
  });
});

describe("HYDRA-UMC-GATEWAY-INDUSTRIAL POST /command (real rate limiting)", () => {
  it("returns 429 once the real per-caller limit is exceeded within the window", async () => {
    const dispatcher = new CommandDispatcher({ executor: async () => ({ ok: true }) });
    const rateLimiter = new CommandRateLimiter({ windowMs: 60_000, maxRequests: 2 });
    const app = buildApp({ commandDispatcher: dispatcher, rateLimiter });
    const body = { protocol: "OPC-UA", operation: "read", target: "t" };

    const first = await request(app).post("/command").send(body);
    const second = await request(app).post("/command").send(body);
    const third = await request(app).post("/command").send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.headers["retry-after"]).toBeDefined();
  });

  it("records a rate-limited attempt in the real audit trail", async () => {
    const dispatcher = new CommandDispatcher({ executor: async () => ({ ok: true }) });
    const rateLimiter = new CommandRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const auditLogger = new InMemoryCommandAuditLogger();
    const app = buildApp({ commandDispatcher: dispatcher, rateLimiter, auditLogger });
    const body = { protocol: "OPC-UA", operation: "read", target: "t" };

    await request(app).post("/command").send(body);
    await request(app).post("/command").send(body);

    expect(auditLogger.entries).toHaveLength(2);
    expect(auditLogger.entries[0].outcome).toBe("accepted");
    expect(auditLogger.entries[1].outcome).toBe("rate_limited");
    expect(auditLogger.entries[1].httpStatus).toBe(429);
  });

  it("does not consume rate-limit budget across two independently-built apps (own limiter per app)", async () => {
    const rateLimiter1 = new CommandRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const rateLimiter2 = new CommandRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const dispatcher = () => new CommandDispatcher({ executor: async () => ({ ok: true }) });
    const body = { protocol: "OPC-UA", operation: "read", target: "t" };

    const appOne = buildApp({ commandDispatcher: dispatcher(), rateLimiter: rateLimiter1 });
    const appTwo = buildApp({ commandDispatcher: dispatcher(), rateLimiter: rateLimiter2 });

    const resOne = await request(appOne).post("/command").send(body);
    const resTwo = await request(appTwo).post("/command").send(body);

    expect(resOne.status).toBe(200);
    expect(resTwo.status).toBe(200);
  });
});
