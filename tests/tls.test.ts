// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/tls.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real tests against real X.509 material: every certificate/key used
// below is generated fresh by the real `openssl` binary (mkdtempSync'd
// temp directory, cleaned up in afterAll) - never a hardcoded/committed
// fixture. The mTLS test at the bottom is the one that matters most: a
// real https.Server with a real client certificate requirement, proven
// by actually completing a TLS handshake with a certificate signed by
// the configured CA, and actually being refused when no client
// certificate is presented at all.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from "node:https";
import { resolveTlsConfig, describeTlsMode } from "../src/tls.js";

let dir: string;
let serverCertPath: string;
let serverKeyPath: string;
let caCertPath: string;
let caKeyPath: string;
let clientCertPath: string;
let clientKeyPath: string;

// Real openssl invocation via execFileSync (argv array, no shell) - never
// goes through a shell that could reinterpret a leading "/CN=..." subject
// as a filesystem path (a real, environment-specific footgun on Git Bash/
// Windows). OPENSSL_CONF is deliberately stripped from the child's own
// environment: a stray/misconfigured global OPENSSL_CONF pointing at a
// config file that doesn't exist on THIS machine must not make an
// unrelated test suite fail.
function openssl(args: string[]): void {
  const env = { ...process.env };
  delete env.OPENSSL_CONF;
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"], env });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hydra-gateway-tls-"));
  serverCertPath = join(dir, "server.crt");
  serverKeyPath = join(dir, "server.key");
  caCertPath = join(dir, "ca.crt");
  caKeyPath = join(dir, "ca.key");
  clientCertPath = join(dir, "client.crt");
  clientKeyPath = join(dir, "client.key");
  const clientCsrPath = join(dir, "client.csr");

  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKeyPath, "-out", serverCertPath, "-days", "1", "-subj", "/CN=localhost"]);
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKeyPath, "-out", caCertPath, "-days", "1", "-subj", "/CN=Test CA"]);
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", clientKeyPath, "-out", clientCsrPath, "-subj", "/CN=test-client"]);
  openssl(["x509", "-req", "-in", clientCsrPath, "-CA", caCertPath, "-CAkey", caKeyPath, "-CAcreateserial", "-out", clientCertPath, "-days", "1"]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveTlsConfig", () => {
  it("returns null when no TLS env vars are set - the real plain-HTTP fallback", () => {
    expect(resolveTlsConfig({})).toBeNull();
  });

  it("returns a real server-only TLS config when cert+key are set without a CA", () => {
    const config = resolveTlsConfig({ TLS_CERT_PATH: serverCertPath, TLS_KEY_PATH: serverKeyPath });
    expect(config).not.toBeNull();
    expect(config!.requestCert).toBe(false);
    expect(config!.rejectUnauthorized).toBe(false);
    expect(config!.ca).toBeUndefined();
    expect(config!.cert.toString("utf-8")).toContain("BEGIN CERTIFICATE");
    expect(config!.minVersion).toBe("TLSv1.2");
  });

  it("returns a real mutual-TLS config when TLS_CLIENT_CA_PATH is also set", () => {
    const config = resolveTlsConfig({ TLS_CERT_PATH: serverCertPath, TLS_KEY_PATH: serverKeyPath, TLS_CLIENT_CA_PATH: caCertPath });
    expect(config).not.toBeNull();
    expect(config!.requestCert).toBe(true);
    expect(config!.rejectUnauthorized).toBe(true);
    expect(config!.ca?.toString("utf-8")).toContain("BEGIN CERTIFICATE");
  });

  it("throws instead of silently falling back to plain HTTP when only one of cert/key is set", () => {
    expect(() => resolveTlsConfig({ TLS_CERT_PATH: serverCertPath })).toThrow(/must both be set/);
    expect(() => resolveTlsConfig({ TLS_KEY_PATH: serverKeyPath })).toThrow(/must both be set/);
  });

  it("throws instead of silently falling back to plain HTTP when a configured path can't be read", () => {
    expect(() => resolveTlsConfig({ TLS_CERT_PATH: join(dir, "does-not-exist.crt"), TLS_KEY_PATH: serverKeyPath })).toThrow(/TLS_CERT_PATH/);
  });

  it("refuses TLS_CLIENT_CA_PATH alone - mutual TLS needs a real server certificate first", () => {
    expect(() => resolveTlsConfig({ TLS_CLIENT_CA_PATH: caCertPath })).toThrow(/TLS_CLIENT_CA_PATH/);
  });
});

describe("describeTlsMode", () => {
  it("reports plain HTTP, TLS, and mutual TLS distinctly", () => {
    expect(describeTlsMode(null)).toMatch(/plain HTTP/);
    expect(describeTlsMode({ cert: Buffer.alloc(0), key: Buffer.alloc(0), requestCert: false, rejectUnauthorized: false, minVersion: "TLSv1.2" })).toMatch(/^TLS/);
    expect(describeTlsMode({ cert: Buffer.alloc(0), key: Buffer.alloc(0), requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2" })).toMatch(/mutual TLS/);
  });
});

describe("a real mutual-TLS handshake", () => {
  let server: HttpsServer;
  let port: number;

  beforeAll(async () => {
    const config = resolveTlsConfig({ TLS_CERT_PATH: serverCertPath, TLS_KEY_PATH: serverKeyPath, TLS_CLIENT_CA_PATH: caCertPath })!;
    server = createHttpsServer(config, (_req, res) => res.end("ok"));
    port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("completes a real TLS handshake for a client presenting a certificate the configured CA signed", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: "localhost", // matches the server cert's own CN=localhost
          port,
          path: "/",
          // The server's own certificate is self-signed (not chained to
          // the client-cert CA below) - trusting it directly is the real,
          // standard way a client validates a self-signed server, exactly
          // as this test's own beforeAll generated it.
          ca: [readFileSync(serverCertPath)],
          cert: readFileSync(clientCertPath),
          key: readFileSync(clientKeyPath),
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  it("refuses the TLS handshake itself when no client certificate is presented - the real mTLS enforcement", async () => {
    await expect(
      new Promise<number>((resolve, reject) => {
        const req = httpsRequest(
          {
            host: "localhost", // matches the server cert's own CN=localhost
            port,
            path: "/",
            ca: [readFileSync(serverCertPath)],
            // Deliberately no cert/key - an unauthenticated client.
          },
          (res) => resolve(res.statusCode ?? 0),
        );
        req.on("error", reject);
        req.end();
      }),
    ).rejects.toThrow();
  });
});
