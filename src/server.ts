// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Integration Status Surface: src/server.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Parent/integration repo for the three protocol bridges that make up the
// Industry 4.0 Gateway (see this project's own README.md for the full
// rationale): HYDRA-UMC-OPCUA-SERVER, HYDRA-UMC-MQTT-BROKER and
// HYDRA-UMC-MTCONNECT-ADAPTER each run as their own process/container
// (see docker-compose.yml at the repo root for how they're wired
// together) - this repo does not reimplement any of the three protocols
// itself. What this entry point owns is the single aggregated surface an
// operator or monitoring tool checks first: GET /status makes a REAL
// network check against each child (TCP connect for OPC-UA/MQTT, a real
// HTTP GET for MTConnect - see src/probes.ts) so "is the plant floor
// actually connected to OPC-UA/MQTT/MTConnect right now" has one real
// answer instead of three, verified against real running services (not a
// static list) - see tests/server.test.ts and the end-to-end smoke test.
//
// Host/port defaults match docker-compose.yml's own service names
// (opcua-server, mqtt-broker, mtconnect-adapter) so `docker compose up`
// needs zero extra configuration; every one is overridable via env var
// for local development (pointing at localhost) or a non-Docker
// deployment.
// =============================================================================

import express, { type NextFunction, type Request, type Response } from "express";
import { createServer as createHttpsServer } from "node:https";
import { probeHttp, probeTcp, type ProbeResult } from "./probes.js";
import { readPackageVersion } from "./version.js";
import {
  CommandDispatcher,
  DEFAULT_MQTT_PUBLISH_TOPICS,
  MAX_COMMAND_TIMEOUT_MS,
  isProtocol,
  type CommandExecutor,
  type CommandRequest,
  type Protocol,
} from "./command.js";
import { resolveTlsConfig, describeTlsMode } from "./tls.js";
import { commandAuthStartupProblem, resolveCommandAuthConfig, requireCommandAuth, describeCommandAuthMode } from "./auth.js";
import { CommandRateLimiter, requireCommandRateLimit, resolveRateLimitConfig, describeRateLimitMode } from "./rateLimit.js";
import { FileCommandAuditLogger, recordCommandAttempt, resolveAuditLogPath, type CommandAuditLogger } from "./audit.js";

// 8000 is free of the three protocol-specific defaults this Gateway
// fronts (4840 OPC-UA, 1883 MQTT, 5000 MTConnect - see each child's own
// src/server.ts) so all four can run side by side with zero port
// collisions during local development or in docker-compose.
const PORT = Number(process.env.PORT) || 8000;

// Probe timeout is deliberately short and separately configurable from the
// child endpoints themselves - tests override it to a few ms so a probe
// against a deliberately-closed port fails fast instead of stretching
// every "child is down" test out to the production default.
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 2000;

interface ChildSpec {
  name: string;
  protocol: Protocol;
  endpoint: string;
  check: () => Promise<ProbeResult>;
}

function buildChildren(): ChildSpec[] {
  const opcuaHost = process.env.OPCUA_HOST || "opcua-server";
  const opcuaPort = Number(process.env.OPCUA_PORT) || 4840;
  const mqttHost = process.env.MQTT_HOST || "mqtt-broker";
  const mqttPort = Number(process.env.MQTT_PORT) || 1883;
  const mtconnectUrl = process.env.MTCONNECT_URL || "http://mtconnect-adapter:5000/probe";

  return [
    {
      name: "HYDRA-UMC-OPCUA-SERVER",
      protocol: "OPC-UA",
      endpoint: `opc.tcp://${opcuaHost}:${opcuaPort}/HYDRA-UMC-OPCUA-SERVER`,
      check: () => probeTcp(opcuaHost, opcuaPort, PROBE_TIMEOUT_MS),
    },
    {
      name: "HYDRA-UMC-MQTT-BROKER",
      protocol: "MQTT",
      endpoint: `mqtt://${mqttHost}:${mqttPort}`,
      check: () => probeTcp(mqttHost, mqttPort, PROBE_TIMEOUT_MS),
    },
    {
      name: "HYDRA-UMC-MTCONNECT-ADAPTER",
      protocol: "MTConnect",
      endpoint: mtconnectUrl,
      check: () => probeHttp(mtconnectUrl, PROBE_TIMEOUT_MS),
    },
  ];
}

// The default CommandDispatcher executor: a command is only ever
// considered relayable if the target protocol's child is actually
// reachable right now (the same real TCP/HTTP probe GET /status uses) -
// a genuinely meaningful precondition, even though it stops short of
// performing a real protocol-level write. Honest about that boundary
// rather than pretending to execute something no child can receive yet.
function buildCommandExecutor(children: ChildSpec[]): CommandExecutor {
  return async (req: CommandRequest) => {
    const child = children.find((c) => c.protocol === req.protocol);
    if (!child) {
      return { ok: false, detail: `no ${req.protocol} child is configured on this gateway` };
    }
    const probe = await child.check();
    // Reachable is all that was verified: this executor performs nothing, and says so (outcome "probe_only"), so neither the caller nor the audit log believes an order was carried out.
    return probe.reachable
      ? { ok: true, executed: false }
      : { ok: false, detail: probe.error ?? `${child.name} is not reachable` };
  };
}

export interface BuildAppOptions {
  // Overridable so tests can inject a dispatcher with a controllable
  // executor/limits (e.g. one whose executor never resolves, to exercise
  // the timeout path deterministically) instead of waiting on real
  // network probes.
  commandDispatcher?: CommandDispatcher;
  // Overridable so tests can use a tiny window/limit to exercise 429s
  // deterministically instead of firing 60 real requests, and so a fresh
  // limiter (its own in-memory state) is used per test instead of a
  // module-level singleton bleeding state across them.
  rateLimiter?: CommandRateLimiter;
  // Overridable so tests can assert on the exact real audit entries a
  // request produced (InMemoryCommandAuditLogger, audit.ts) instead of
  // depending on - or polluting - a real log file on disk.
  auditLogger?: CommandAuditLogger;
  // How long a GET /status answer is reused (default GATEWAY_STATUS_CACHE_MS or 1500 ms). Every uncached call opens a connection to each child, so an unbounded
  // loop of requests would become a connection flood against the plant services; concurrent calls also share one probe round.
  statusCacheMs?: number;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = express();
  app.use(express.json());

  // One dispatcher per app instance (not per request) - backpressure
  // only means anything if concurrent requests share the same in-flight
  // counter.
  const dispatcher = options.commandDispatcher ?? new CommandDispatcher({ executor: buildCommandExecutor(buildChildren()), mqttPublishTopics: resolveMqttPublishTopics() });
  const commandAuthConfig = resolveCommandAuthConfig();
  const commandAuthMiddleware = commandAuthConfig ? [requireCommandAuth(commandAuthConfig)] : [];
  const rateLimiter = options.rateLimiter ?? new CommandRateLimiter();
  const auditLogger = options.auditLogger ?? new FileCommandAuditLogger();
  const statusCacheMs = options.statusCacheMs ?? resolveStatusCacheMs();
  let statusCache: { at: number; pending: Promise<StatusBody> } | null = null;

  async function probeChildren(): Promise<StatusBody> {
    const children = buildChildren();
    const results = await Promise.all(
      children.map(async (child) => {
        const probe = await child.check();
        return {
          name: child.name,
          protocol: child.protocol,
          endpoint: child.endpoint,
          reachable: probe.reachable,
          latencyMs: probe.latencyMs,
          ...(probe.error ? { error: probe.error } : {}),
        };
      }),
    );
    return {
      gateway: "HYDRA-UMC-GATEWAY-INDUSTRIAL",
      version: readPackageVersion(),
      allReachable: results.every((r) => r.reachable),
      children: results,
    };
  }

  // Real, fast liveness probe - deliberately separate from /status below,
  // which is a genuine deep diagnostic (real reachability checks against
  // every configured child, each with its own real connect timeout that
  // can legitimately take ~2s when a child is down). Found live: the
  // ecosystem-wide /api/ecosystem/status scanner (HYDRA-UMC-SERVER) budgets
  // only 800ms per probe - pointed at /status, a gateway whose children
  // are unreachable would report itself DOWN in that scan even though the
  // gateway process itself is perfectly healthy, exactly the "green bulb
  // that means something real" property that scan exists to provide. This
  // route answers "is the gateway process itself up", nothing about its
  // children - that question stays /status's own job, unchanged.
  app.get("/health", (_req, res) => {
    res.json({ gateway: "HYDRA-UMC-GATEWAY-INDUSTRIAL", version: readPackageVersion(), status: "ok" });
  });

  app.get("/status", async (_req, res, next) => {
    try {
      const now = Date.now();
      if (!statusCache || now - statusCache.at >= statusCacheMs) {
        // Single flight: callers arriving while a round is running (or inside the cache window) share its answer.
        const pending = probeChildren();
        statusCache = { at: now, pending };
        pending.catch(() => {
          if (statusCache?.pending === pending) statusCache = null;
        });
      }
      res.json(await statusCache.pending);
    } catch (error) {
      next(error);
    }
  });

  const OUTCOME_HTTP_STATUS: Record<string, number> = {
    accepted: 200,
    probe_only: 501,
    rejected_unauthorized: 403,
    rejected_backpressure: 429,
    timeout: 504,
    downstream_unreachable: 502,
    executor_error: 500,
  };

  app.post(
    "/command",
    // Audit logging goes first: res.on("finish") inside it fires
    // whichever middleware/handler below ends the response, so every
    // real attempt is recorded - rate-limited, unauthenticated,
    // allowlist-rejected or accepted alike. Rate limiting runs before
    // auth so a caller hammering the endpoint with invalid/missing
    // tokens is bounded too, not just one sending valid commands too
    // fast - see rateLimit.ts's own header comment.
    recordCommandAttempt(auditLogger),
    requireCommandRateLimit(rateLimiter),
    ...commandAuthMiddleware,
    async (req, res) => {
      const body = req.body ?? {};
      const { protocol, operation, target, timeoutMs } = body;
      if (typeof protocol !== "string" || typeof operation !== "string" || typeof target !== "string") {
        res.locals.auditOutcome = "invalid_request";
        res.status(400).json({ error: "protocol, operation and target are required strings" });
        return;
      }
      if (!isProtocol(protocol)) {
        res.locals.auditOutcome = "invalid_request";
        res.status(400).json({ error: "protocol must be one of OPC-UA, MQTT, MTConnect" });
        return;
      }
      if (operation.length === 0 || operation.length > MAX_OPERATION_LENGTH || target.length === 0 || target.length > MAX_TARGET_LENGTH) {
        res.locals.auditOutcome = "invalid_request";
        res.status(400).json({ error: `operation (1-${MAX_OPERATION_LENGTH} characters) and target (1-${MAX_TARGET_LENGTH} characters) must not be empty or oversized` });
        return;
      }
      if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_COMMAND_TIMEOUT_MS)) {
        res.locals.auditOutcome = "invalid_request";
        res.status(400).json({ error: `timeoutMs, when present, must be a positive finite number of at most ${MAX_COMMAND_TIMEOUT_MS}` });
        return;
      }

      const outcome = await dispatcher.dispatch({
        protocol,
        operation,
        target,
        timeoutMs,
      });
      res.locals.auditOutcome = outcome.status;
      if ("reason" in outcome) res.locals.auditReason = outcome.reason;
      res.status(OUTCOME_HTTP_STATUS[outcome.status] ?? 500).json(outcome);
    },
  );

  // Last: whatever a handler throws (or a malformed JSON body) leaves as a JSON error without a stack trace or an internal path.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof error === "object" && error !== null && "status" in error && typeof (error as { status: unknown }).status === "number" ? (error as { status: number }).status : 500;
    if (status >= 500) console.error("[HYDRA-UMC-GATEWAY-INDUSTRIAL] unhandled request error", error);
    res.locals.auditOutcome ??= status >= 500 ? "internal_error" : "invalid_request";
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: status >= 500 ? "internal error" : "invalid request" });
  });

  return app;
}

const MAX_OPERATION_LENGTH = 64;
const MAX_TARGET_LENGTH = 512;

interface StatusBody {
  gateway: string;
  version: string;
  allReachable: boolean;
  children: Array<{ name: string; protocol: Protocol; endpoint: string; reachable: boolean; latencyMs: number; error?: string }>;
}

function resolveStatusCacheMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.GATEWAY_STATUS_CACHE_MS);
  return Number.isFinite(configured) && configured >= 0 && env.GATEWAY_STATUS_CACHE_MS?.trim() ? configured : 1500;
}

/** The topics an MQTT publish may target: GATEWAY_MQTT_PUBLISH_TOPICS (comma-separated filters) or the gateway's own namespace. */
function resolveMqttPublishTopics(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const configured = (env.GATEWAY_MQTT_PUBLISH_TOPICS ?? "").split(",").map(item => item.trim()).filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_MQTT_PUBLISH_TOPICS;
}

function main() {
  const problem = commandAuthStartupProblem();
  if (problem) {
    console.error(`[HYDRA-UMC-GATEWAY-INDUSTRIAL] refusing to start: ${problem}`);
    console.error("[HYDRA-UMC-GATEWAY-INDUSTRIAL] set GATEWAY_JWT_SECRET, or GATEWAY_ALLOW_ANONYMOUS=1 for an open lab gateway.");
    process.exit(1);
  }
  const app = buildApp();
  // Real TLS/mTLS, opt-in via real certificate files - see src/tls.ts's
  // own header comment for why this exists (this project's own README
  // already claimed mTLS as a delivered feature before this). A
  // misconfigured TLS_* path throws here, at startup, rather than
  // silently serving plaintext HTTP.
  const tlsConfig = resolveTlsConfig();
  const scheme = tlsConfig ? "https" : "http";
  const server = tlsConfig ? createHttpsServer(tlsConfig, app) : app;
  const commandAuthConfigForBanner = resolveCommandAuthConfig();
  const rateLimitConfigForBanner = resolveRateLimitConfig();

  // Loopback unless told otherwise: the container image and any LAN deployment set GATEWAY_BIND_HOST explicitly.
  const bindHost = process.env.GATEWAY_BIND_HOST?.trim() || "127.0.0.1";
  server.listen(PORT, bindHost, () => {
    console.log("=================================================");
    console.log(` HYDRA-UMC-GATEWAY-INDUSTRIAL v${readPackageVersion()}`);
    console.log(" ROLE: Industry 4.0 interoperability bridge for factory standards");
    console.log(` STATUS: Running on ${bindHost}:${PORT} - status: ${scheme}://localhost:${PORT}/status`);
    console.log(` SECURITY: ${describeTlsMode(tlsConfig)}`);
    console.log(` COMMAND AUTH: ${describeCommandAuthMode(commandAuthConfigForBanner)}`);
    console.log(` RATE LIMIT: ${describeRateLimitMode(rateLimitConfigForBanner)}`);
    console.log(` AUDIT: every POST /command attempt logged to ${resolveAuditLogPath()}`);
    console.log(" CHILDREN: OPC-UA (4840) / MQTT (1883) / MTConnect (5000) - see docker-compose.yml");
    console.log("=================================================");
  });
}

// Only auto-start when run directly, not when imported by
// tests/server.test.ts.
const entryFile = process.argv[1] ? process.argv[1].split(/[/\\]/).pop() : "";
if (entryFile === "server.ts" || entryFile === "server.cjs" || entryFile === "server.js") {
  main();
}
