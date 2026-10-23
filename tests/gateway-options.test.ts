// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/gateway-options.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The opt-in options of this pass and the security headers: strict target formats, credentials only over TLS,
// certificate login, GET /metrics, a clean audit log on shutdown. Every option is off unless its variable is set.
// =============================================================================
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  commandAuthStartupProblem,
  isLoopbackAddress,
  requireTlsForAuthEnabled,
  requireTlsForCredentials,
  resolveCertAuthAllowedCommonNames,
} from "../src/auth.js";
import { CommandDispatcher } from "../src/command.js";
import { FileCommandAuditLogger, InMemoryCommandAuditLogger } from "../src/audit.js";
import { MetricsRegistry, metricsEnabled } from "../src/metrics.js";
import { buildApp } from "../src/server.js";
import { strictTargetsEnabled, targetFormatProblem } from "../src/targets.js";

const accepting = () => new CommandDispatcher({ executor: async () => ({ ok: true }) });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("security headers", () => {
  it("every answer carries them and none announces Express", async () => {
    const res = await request(buildApp({ auditLogger: new InMemoryCommandAuditLogger() })).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("an error answer carries them too", async () => {
    const res = await request(buildApp({ auditLogger: new InMemoryCommandAuditLogger() })).post("/command").set("content-type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("GATEWAY_STRICT_TARGETS", () => {
  const send = (app: ReturnType<typeof buildApp>, protocol: string, target: string) =>
    request(app).post("/command").send({ protocol, operation: protocol === "MQTT" ? "publish" : "read", target });

  it("is off by default: any target within the limits still reaches the dispatcher", async () => {
    vi.stubEnv("GATEWAY_ALLOW_ANONYMOUS", "1");
    const app = buildApp({ commandDispatcher: accepting(), auditLogger: new InMemoryCommandAuditLogger() });
    expect((await send(app, "OPC-UA", "not a node id")).status).toBe(200);
  });

  it("when on, refuses a target that is not what the protocol addresses, with a reason", async () => {
    vi.stubEnv("GATEWAY_ALLOW_ANONYMOUS", "1");
    vi.stubEnv("GATEWAY_STRICT_TARGETS", "1");
    const audit = new InMemoryCommandAuditLogger();
    const app = buildApp({ commandDispatcher: accepting(), auditLogger: audit });
    const bad = await send(app, "OPC-UA", "not a node id");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("NodeId");
    expect(audit.entries.at(-1)).toMatchObject({ outcome: "invalid_request", httpStatus: 400 });
    expect((await send(app, "MTConnect", "../../etc/passwd")).status).toBe(400);
    expect((await send(app, "OPC-UA", "ns=2;s=Line1.Status")).status).toBe(200);
    expect((await send(app, "MTConnect", "/sample?from=10&count=5")).status).toBe(200);
  });

  it("knows the NodeId and MTConnect path formats", () => {
    for (const ok of ["i=2253", "ns=2;i=5", "ns=1;s=HydraNode_1.SwarmOnline", "g=09087e75-8e5e-499b-954f-f2a9603db28a", "b=AQID"]) expect(targetFormatProblem("OPC-UA", ok)).toBeNull();
    for (const bad of ["", "ns=;s=x", "ns=1", "x=1", "ns=99999999;s=a", "s=a\nb"]) expect(targetFormatProblem("OPC-UA", bad), bad).not.toBeNull();
    for (const ok of ["/probe", "/current", "/sample?from=1&count=10", "/HydraNode_1/probe", "/assets"]) expect(targetFormatProblem("MTConnect", ok)).toBeNull();
    for (const bad of ["probe", "/other", "/sample?from=<x>", "/a/b/probe", "/../current", "http://x/probe"]) expect(targetFormatProblem("MTConnect", bad), bad).not.toBeNull();
    expect(targetFormatProblem("MQTT", "anything")).toBeNull();
  });

  it("is on only for the exact value 1", () => {
    expect(strictTargetsEnabled({})).toBe(false);
    expect(strictTargetsEnabled({ GATEWAY_STRICT_TARGETS: "0" })).toBe(false);
    expect(strictTargetsEnabled({ GATEWAY_STRICT_TARGETS: "1" })).toBe(true);
  });
});

describe("GATEWAY_REQUIRE_TLS_FOR_AUTH", () => {
  const run = (req: object) => {
    const calls = { next: 0, status: 0, body: undefined as unknown, locals: {} as Record<string, unknown> };
    const res = {
      locals: calls.locals,
      status(code: number) {
        calls.status = code;
        return this;
      },
      json(body: unknown) {
        calls.body = body;
        return this;
      },
    };
    requireTlsForCredentials()(req as never, res as never, () => {
      calls.next += 1;
    });
    return calls;
  };

  it("refuses an Authorization header over plain HTTP from another machine, before looking at it", () => {
    const calls = run({ headers: { authorization: "Bearer x" }, socket: { remoteAddress: "192.168.0.50" } });
    expect(calls.next).toBe(0);
    expect(calls.status).toBe(403);
    expect(calls.locals.auditOutcome).toBe("auth_plain_http");
    expect(JSON.stringify(calls.body)).toContain("TLS");
  });

  it("lets it through over TLS, from loopback, and when there is no credential to protect", () => {
    expect(run({ headers: { authorization: "Bearer x" }, socket: { remoteAddress: "192.168.0.50", encrypted: true } }).next).toBe(1);
    expect(run({ headers: { authorization: "Bearer x" }, socket: { remoteAddress: "::1" } }).next).toBe(1);
    expect(run({ headers: { authorization: "Bearer x" }, socket: { remoteAddress: "::ffff:127.0.0.1" } }).next).toBe(1);
    expect(run({ headers: {}, socket: { remoteAddress: "192.168.0.50" } }).next).toBe(1);
  });

  it("recognises loopback addresses and nothing that merely looks like one", () => {
    for (const ok of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(ok)).toBe(true);
    for (const bad of [undefined, "", "128.0.0.1", "10.0.0.1", "::2", "127.0.0.1.evil.example", "::ffff:10.0.0.1"]) expect(isLoopbackAddress(bad), String(bad)).toBe(false);
  });

  it("is off by default (a loopback test client cannot tell, so the switch is checked directly)", async () => {
    expect(requireTlsForAuthEnabled({})).toBe(false);
    expect(requireTlsForAuthEnabled({ GATEWAY_REQUIRE_TLS_FOR_AUTH: "1" })).toBe(true);
    vi.stubEnv("GATEWAY_REQUIRE_TLS_FOR_AUTH", "1");
    vi.stubEnv("GATEWAY_ALLOW_ANONYMOUS", "1");
    // the supertest client is loopback, so the command still goes through with the switch on
    const res = await request(buildApp({ commandDispatcher: accepting(), auditLogger: new InMemoryCommandAuditLogger() }))
      .post("/command")
      .set("authorization", "Bearer whatever")
      .send({ protocol: "OPC-UA", operation: "read", target: "t" });
    expect(res.status).toBe(200);
  });
});

describe("GET /metrics", () => {
  it("does not exist unless GATEWAY_METRICS=1", async () => {
    expect(metricsEnabled({})).toBe(false);
    expect((await request(buildApp({ auditLogger: new InMemoryCommandAuditLogger() })).get("/metrics")).status).toBe(404);
  });

  it("counts every command attempt by outcome and the last probe of each child", async () => {
    vi.stubEnv("GATEWAY_METRICS", "1");
    vi.stubEnv("GATEWAY_ALLOW_ANONYMOUS", "1");
    const app = buildApp({ commandDispatcher: accepting(), auditLogger: new InMemoryCommandAuditLogger(), statusCacheMs: 0 });
    await request(app).post("/command").send({ protocol: "OPC-UA", operation: "read", target: "t" });
    await request(app).post("/command").send({ protocol: "OPC-UA", operation: "read", target: "t" });
    await request(app).post("/command").send({ protocol: "OPC-UA", operation: "write", target: "t" });
    await request(app).post("/command").send({ nope: true });
    await request(app).get("/status");
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain('hydra_gateway_commands_total{outcome="accepted"} 2');
    expect(res.text).toContain('hydra_gateway_commands_total{outcome="rejected_unauthorized"} 1');
    expect(res.text).toContain('hydra_gateway_commands_total{outcome="invalid_request"} 1');
    expect(res.text).toContain("hydra_gateway_status_probes_total 1");
    expect(res.text).toMatch(/hydra_gateway_child_reachable\{child="HYDRA-UMC-OPCUA-SERVER",protocol="OPC-UA"\} [01]/);
    expect(res.text).toContain("# TYPE hydra_gateway_commands_total counter");
  });

  it("escapes label values", () => {
    const registry = new MetricsRegistry();
    registry.commandEnded('we"ird\nvalue');
    expect(registry.render()).toContain('outcome="we\\"ird\\nvalue"');
  });
});

describe("the audit log on shutdown", () => {
  it("close() waits until the last entry is on disk", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gateway-audit-"));
    try {
      const file = path.join(dir, "audit.log");
      const logger = new FileCommandAuditLogger(file);
      logger.record({ caller: null, outcome: "accepted", httpStatus: 200 });
      logger.record({ caller: "alice", outcome: "timeout", httpStatus: 504 });
      await logger.close();
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1])).toMatchObject({ caller: "alice", outcome: "timeout" });
      await logger.close(); // closing twice is harmless
      logger.record({ caller: null, outcome: "accepted", httpStatus: 200 }); // and a later record opens the file again
      await logger.close();
      expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("certificate login", () => {
  it("is off unless GATEWAY_CERT_ALLOWED_CN is set, and the list is trimmed", () => {
    expect(resolveCertAuthAllowedCommonNames({})).toEqual([]);
    expect(resolveCertAuthAllowedCommonNames({ GATEWAY_CERT_ALLOWED_CN: " scada-1 , plc-2 ,," })).toEqual(["scada-1", "plc-2"]);
  });

  it("needs mutual TLS: the list alone is a startup problem, the list with the client CA replaces the secret", () => {
    expect(commandAuthStartupProblem({ GATEWAY_CERT_ALLOWED_CN: "scada-1" })).toContain("mutual TLS");
    const mtls = { GATEWAY_CERT_ALLOWED_CN: "scada-1", TLS_CERT_PATH: "c", TLS_KEY_PATH: "k", TLS_CLIENT_CA_PATH: "a" };
    expect(commandAuthStartupProblem(mtls)).toBeNull();
    // a secret that is set is still checked
    expect(commandAuthStartupProblem({ ...mtls, GATEWAY_JWT_SECRET: "short" })).toContain("at least");
  });

  const hasOpenssl = (() => {
    try {
      execFileSync("openssl", ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  describe.skipIf(!hasOpenssl)("over real mutual TLS", () => {
    let dir = "";
    const read = (name: string) => readFileSync(path.join(dir, name));
    beforeAll(() => {
      dir = mkdtempSync(path.join(tmpdir(), "gateway-cert-"));
      writeFileSync(path.join(dir, "openssl.cnf"), ["[req]", "distinguished_name = dn", "[dn]", ""].join("\n"));
      const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore", env: { ...process.env, OPENSSL_CONF: path.join(dir, "openssl.cnf") } });
      run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=test-ca", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE"]);
      for (const [name, cn] of [["server", "localhost"], ["scada", "scada-1"], ["stranger", "stranger-9"]] as const) {
        run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${cn}`]);
        run(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "2"]);
      }
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    async function post(cert: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
      const audit = new InMemoryCommandAuditLogger();
      const app = buildApp({ commandDispatcher: accepting(), auditLogger: audit });
      const server = https.createServer({ cert: read("server.pem"), key: read("server.key"), ca: read("ca.pem"), requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2" }, app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const body = JSON.stringify({ protocol: "OPC-UA", operation: "read", target: "ns=2;s=Line1" });
        return await new Promise((resolve, reject) => {
          const req = https.request(
            { host: "127.0.0.1", port: (server.address() as AddressInfo).port, method: "POST", path: "/command", ca: read("ca.pem"), cert: read(`${cert}.pem`), key: read(`${cert}.key`), servername: "localhost", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...headers } },
            (res) => {
              let text = "";
              res.on("data", (chunk) => (text += chunk));
              res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text + JSON.stringify(audit.entries.map((e) => e.caller)) }));
            },
          );
          req.on("error", reject);
          req.end(body);
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }

    it("lets a certificate whose CN is on the list command with no token, and records it as the caller", async () => {
      vi.stubEnv("GATEWAY_CERT_ALLOWED_CN", "scada-1");
      vi.stubEnv("GATEWAY_CERT_SCOPES", "*");
      const result = await post("scada");
      expect(result.status).toBe(200);
      expect(result.body).toContain("cert:scada-1");
    });

    it("refuses a valid certificate whose CN is not on the list", async () => {
      vi.stubEnv("GATEWAY_CERT_ALLOWED_CN", "scada-1");
      vi.stubEnv("GATEWAY_CERT_SCOPES", "*");
      const result = await post("stranger");
      expect(result.status).toBe(403);
      expect(result.body).toContain("GATEWAY_CERT_ALLOWED_CN");
    });

    it("with a token secret set as well, a listed certificate or a valid token works and nothing else does", async () => {
      vi.stubEnv("GATEWAY_CERT_ALLOWED_CN", "scada-1");
      vi.stubEnv("GATEWAY_CERT_SCOPES", "*");
      vi.stubEnv("GATEWAY_JWT_SECRET", "k".repeat(16) + "abcdefghijklmnop");
      expect((await post("scada")).status).toBe(200);
      const stranger = await post("stranger");
      expect(stranger.status).toBe(401); // falls through to the token check, which finds no token
    });
  });
});
