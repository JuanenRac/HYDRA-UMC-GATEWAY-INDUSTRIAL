// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Smoke test of the bundle: scripts/smoke.mjs
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Starts the real bundle (dist/server.cjs, `npm run bundle` first) the way the
// container does and checks what the unit tests cannot: that the bundle
// really starts and answers GET /health with this repository's version, that
// it refuses to start without a secret, and that POST /command asks for a
// token. Runs without Docker, so CI can run it on every push.
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "dist", "server.cjs");
const expectedVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")).version;

function fail(message) {
  console.error(`SMOKE_TEST=FAIL ${message}`);
  process.exit(1);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function start(env) {
  const child = spawn(process.execPath, [bundle], {
    cwd: root,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  return { child, output: () => output };
}

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  fail(`${what} (last error: ${lastError?.message ?? "none"})`);
}

if (!existsSync(bundle)) fail("dist/server.cjs does not exist: run `npm run bundle` first");

const scratch = mkdtempSync(path.join(tmpdir(), "gateway-smoke-"));
try {
  // 1. no secret: the gateway must refuse to start, whatever NODE_ENV says
  const port = await freePort();
  const refused = start({ PORT: String(port) });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      refused.child.kill();
      resolve("still running");
    }, 20000);
    refused.child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  if (code !== 1) fail(`without GATEWAY_JWT_SECRET the gateway should exit with code 1, got ${code}`);
  if (!/refusing to start/.test(refused.output())) fail("the refusal does not say why");

  // 2. with a secret: it starts, /health reports this repository's version, /command wants a token
  const running = start({
    PORT: String(port),
    GATEWAY_BIND_HOST: "127.0.0.1",
    GATEWAY_JWT_SECRET: "smoke-test-secret-0123456789abcdef-0123456789abcdef",
    GATEWAY_AUDIT_LOG_PATH: path.join(scratch, "audit.log"),
    PROBE_TIMEOUT_MS: "300",
  });
  try {
    const health = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      return response.ok ? response.json() : null;
    }, 15000, "GET /health never answered");
    if (health.status !== "ok") fail(`/health says ${JSON.stringify(health)}`);
    if (health.version !== expectedVersion) fail(`/health reports version ${health.version}, package.json says ${expectedVersion}`);

    const noToken = await fetch(`http://127.0.0.1:${port}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol: "OPC-UA", operation: "read", target: "ns=2;s=x" }),
    });
    if (noToken.status !== 401) fail(`POST /command without a token should be 401, got ${noToken.status}`);

    const status = await fetch(`http://127.0.0.1:${port}/status`);
    if (!status.ok) fail(`GET /status answered ${status.status}`);
  } finally {
    running.child.kill();
  }
  console.log(`SMOKE_TEST=PASS version=${expectedVersion}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
