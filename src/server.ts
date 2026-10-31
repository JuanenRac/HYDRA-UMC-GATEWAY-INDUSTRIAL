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

import fs from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer as createHttpsServer } from "node:https";
import { probeHttp, probeMqtt, probeMtconnect, probeOpcUa, probeTcp, resolveProbeMode, type ProbeMode, type ProbeResult } from "./probes.js";
import { MetricsRegistry, metricsEnabled } from "./metrics.js";
import { strictTargetsEnabled, targetFormatProblem } from "./targets.js";
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
import {
  commandAuthStartupProblem,
  enforceCommandScope,
  describeCommandAuthMode,
  requireCommandAuth,
  requireTlsForAuthEnabled,
  requireTlsForCredentials,
  resolveCertAuthAllowedCommonNames,
  resolveCommandAuthConfig,
} from "./auth.js";
import { CommandRateLimiter, requireCommandRateLimit, resolveRateLimitConfig, describeRateLimitMode } from "./rateLimit.js";
import { FileCommandAuditLogger, recordCommandAttempt, resolveAuditLogPath, type CommandAuditLogger } from "./audit.js";
import { resolveServicePort } from "./portConfig.js";
import { WriteGate, createSimulatedController, parseWriteRules, verifyChain, writesEnabled, type CellStateProvider } from "./writeGate.js";

// 8000 is free of the three protocol-specific defaults this Gateway
// fronts (4840 OPC-UA, 1883 MQTT, 5000 MTConnect - see each child's own
// src/server.ts) so all four can run side by side with zero port
// collisions during local development or in docker-compose.
// HYDRA_UMC_GATEWAY_PORT is the variable of this service; the shared PORT still works, with a warning.
const RESOLVED_PORT = resolveServicePort(process.env, "HYDRA_UMC_GATEWAY_PORT", 8000);
if (RESOLVED_PORT.warning) console.warn(`[HYDRA-UMC-GATEWAY-INDUSTRIAL] ${RESOLVED_PORT.warning}`);
const PORT = RESOLVED_PORT.port;

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

/** The mode, or "tcp" when the setting is invalid (main() refuses an invalid one at start, before any request). */
function probeModeOrDefault(): ProbeMode {
  try {
    return resolveProbeMode();
  } catch {
    return "tcp";
  }
}

function buildChildren(): ChildSpec[] {
  const mode = probeModeOrDefault();
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
      check: () =>
        mode === "protocol"
          ? probeOpcUa(opcuaHost, opcuaPort, `opc.tcp://${opcuaHost}:${opcuaPort}/HYDRA-UMC-OPCUA-SERVER`, PROBE_TIMEOUT_MS)
          : probeTcp(opcuaHost, opcuaPort, PROBE_TIMEOUT_MS),
    },
    {
      name: "HYDRA-UMC-MQTT-BROKER",
      protocol: "MQTT",
      endpoint: `mqtt://${mqttHost}:${mqttPort}`,
      check: () =>
        mode === "protocol"
          ? probeMqtt(
              mqttHost,
              mqttPort,
              {
                clientId: process.env.GATEWAY_MQTT_PROBE_CLIENT_ID?.trim() || undefined,
                username: process.env.GATEWAY_MQTT_PROBE_USERNAME || undefined,
                password: process.env.GATEWAY_MQTT_PROBE_PASSWORD,
              },
              PROBE_TIMEOUT_MS,
            )
          : probeTcp(mqttHost, mqttPort, PROBE_TIMEOUT_MS),
    },
    {
      name: "HYDRA-UMC-MTCONNECT-ADAPTER",
      protocol: "MTConnect",
      endpoint: mtconnectUrl,
      check: () => (mode === "protocol" ? probeMtconnect(mtconnectUrl, PROBE_TIMEOUT_MS) : probeHttp(mtconnectUrl, PROBE_TIMEOUT_MS)),
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
  // Overridable so tests can read the counters; by default one registry per app, served at GET /metrics only with GATEWAY_METRICS=1.
  metrics?: MetricsRegistry;
}

/** Headers every answer carries: it is a JSON API, never a page, so nothing it returns may be sniffed, framed, cached or given a script. */
function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  next();
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(express.json());
  const metrics = options.metrics ?? new MetricsRegistry();
  const strictTargets = strictTargetsEnabled();
  const requireTls = requireTlsForAuthEnabled();
  const certCommonNames = resolveCertAuthAllowedCommonNames();

  // One dispatcher per app instance (not per request) - backpressure
  // only means anything if concurrent requests share the same in-flight
  // counter.
  const writeGate = options.commandDispatcher ? undefined : buildWriteGate();
  const dispatcher =
    options.commandDispatcher ??
    new CommandDispatcher({
      executor: writeGate && simulatedWritesEnabled() ? createSimulatedController().executor : buildCommandExecutor(buildChildren()),
      mqttPublishTopics: resolveMqttPublishTopics(),
      writeGate,
    });
  const commandAuthConfig = resolveCommandAuthConfig();
  const commandAuthMiddleware = commandAuthConfig || certCommonNames.length > 0 ? [requireCommandAuth(commandAuthConfig, certCommonNames)] : [];
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
          ...(probe.detail ? { detail: probe.detail } : {}),
        };
      }),
    );
    metrics.statusProbed(results.map((r) => ({ name: r.name, protocol: r.protocol, reachable: r.reachable, latencyMs: r.latencyMs })));
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

  if (metricsEnabled()) {
    app.get("/metrics", (_req, res) => {
      res.type("text/plain; version=0.0.4; charset=utf-8").send(metrics.render());
    });
  }

  const OUTCOME_HTTP_STATUS: Record<string, number> = {
    accepted: 200,
    write_prepared: 202,
    rejected_write: 403,
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
    (_req, res, next) => {
      // counts how every attempt ended, whichever middleware answered
      res.on("finish", () => metrics.commandEnded(typeof res.locals.auditOutcome === "string" ? res.locals.auditOutcome : `http_${res.statusCode}`));
      next();
    },
    requireCommandRateLimit(rateLimiter),
    ...(requireTls ? [requireTlsForCredentials()] : []),
    ...commandAuthMiddleware,
    async (req, res) => {
      const body = req.body ?? {};
      const { protocol, operation, target, timeoutMs, value, confirmId } = body;
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
      if (!enforceCommandScope(req, res, protocol, operation)) return;
      if (operation.length === 0 || operation.length > MAX_OPERATION_LENGTH || target.length === 0 || target.length > MAX_TARGET_LENGTH) {
        res.locals.auditOutcome = "invalid_request";
        res.status(400).json({ error: `operation (1-${MAX_OPERATION_LENGTH} characters) and target (1-${MAX_TARGET_LENGTH} characters) must not be empty or oversized` });
        return;
      }
      if (strictTargets) {
        const formatProblem = targetFormatProblem(protocol, target);
        if (formatProblem) {
          res.locals.auditOutcome = "invalid_request";
          res.locals.auditReason = formatProblem;
          res.status(400).json({ error: formatProblem });
          return;
        }
      }
      if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_COMMAND_TIMEOUT_MS)) {
        res.locals.auditOutcome = "invalid_request";
        res.status(400).json({ error: `timeoutMs, when present, must be a positive finite number of at most ${MAX_COMMAND_TIMEOUT_MS}` });
        return;
      }

      if (confirmId !== undefined && typeof confirmId !== "string") {
        res.locals.auditOutcome = "invalid_request";
        res.status(400).json({ error: "confirmId, when present, must be a string" });
        return;
      }
      const outcome = await dispatcher.dispatch({
        protocol,
        operation,
        target,
        timeoutMs,
        value,
        confirmId,
        caller: req.commandCaller ?? null,
      });
      res.locals.auditOutcome = outcome.status;
      if ("reason" in outcome) res.locals.auditReason = outcome.reason;
      res.status(OUTCOME_HTTP_STATUS[outcome.status] ?? 500).json(outcome);
    },
  );

  // The tamper-evident record of what the write gate decided: behind the same authentication as POST /command, and only when writes are on.
  const activeGate = writeGate ?? dispatcher.gate;
  if (activeGate?.enabled) {
    app.get("/command/write-audit", ...commandAuthMiddleware, (_req, res) => {
      const records = activeGate.auditChain();
      res.json({ records, chainIntact: verifyChain(records) });
    });
  }

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
  children: Array<{ name: string; protocol: Protocol; endpoint: string; reachable: boolean; latencyMs: number; error?: string; detail?: string }>;
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

function simulatedWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.GATEWAY_WRITE_SIMULATED ?? "").trim() === "1";
}

/**
 * The write gate from the environment. Writes are off unless GATEWAY_WRITES=1. When on, the node rules (GATEWAY_WRITE_RULES_FILE, a JSON list) and a
 * source of the cell state (GATEWAY_CELL_STATE_URL: a GET that answers {"state": "READY", "timestamp_utc": "..."}) are required, and the start fails without them:
 * a gateway that says it writes but would refuse everything, or write blind, is a misconfiguration to stop, not to run.
 */
function buildWriteGate(env: NodeJS.ProcessEnv = process.env): WriteGate | undefined {
  if (!writesEnabled(env)) return undefined;
  const rulesFile = env.GATEWAY_WRITE_RULES_FILE?.trim();
  const stateUrl = env.GATEWAY_CELL_STATE_URL?.trim();
  if (!rulesFile) throw new Error("GATEWAY_WRITES=1 needs GATEWAY_WRITE_RULES_FILE (the nodes that may be written, one rule each)");
  if (!stateUrl) throw new Error("GATEWAY_WRITES=1 needs GATEWAY_CELL_STATE_URL (the safety state of the cell): a write is not made blind");
  const rules = parseWriteRules(fs.readFileSync(rulesFile, "utf8"));
  const ttl = Number(env.GATEWAY_WRITE_CONFIRM_TTL_MS);
  const maxAge = Number(env.GATEWAY_CELL_STATE_MAX_AGE_MS);
  const cellState: CellStateProvider = async () => {
    const response = await fetch(stateUrl, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const body = (await response.json()) as { state?: unknown; timestamp_utc?: unknown };
    const at = typeof body.timestamp_utc === "string" ? Date.parse(body.timestamp_utc) : NaN;
    return typeof body.state === "string" && Number.isFinite(at) ? { state: body.state, atMs: at } : null;
  };
  console.warn(`[HYDRA-UMC-GATEWAY-INDUSTRIAL] WRITES ARE ON: ${rules.length} node(s) may be written, two steps, only while the cell is READY`);
  if (simulatedWritesEnabled(env)) console.warn("[HYDRA-UMC-GATEWAY-INDUSTRIAL] GATEWAY_WRITE_SIMULATED=1: writes go to an in-memory controller, not to a PLC");
  return new WriteGate({
    enabled: true,
    rules,
    cellState,
    ...(Number.isFinite(ttl) && ttl > 0 ? { confirmTtlMs: ttl } : {}),
    ...(Number.isFinite(maxAge) && maxAge > 0 ? { cellStateMaxAgeMs: maxAge } : {}),
  });
}

function main() {
  const problem = commandAuthStartupProblem();
  if (problem) {
    console.error(`[HYDRA-UMC-GATEWAY-INDUSTRIAL] refusing to start: ${problem}`);
    console.error("[HYDRA-UMC-GATEWAY-INDUSTRIAL] set GATEWAY_JWT_SECRET, or GATEWAY_ALLOW_ANONYMOUS=1 for an open lab gateway.");
    process.exit(1);
  }
  try {
    resolveProbeMode();
  } catch (error) {
    console.error(`[HYDRA-UMC-GATEWAY-INDUSTRIAL] refusing to start: ${(error as Error).message}`);
    process.exit(1);
  }
  const auditLogger = new FileCommandAuditLogger();
  const app = buildApp({ auditLogger });
  // Real TLS/mTLS, opt-in via real certificate files - see src/tls.ts's
  // own header comment for why this exists (this project's own README
  // already claimed mTLS as a delivered feature before this). A
  // misconfigured TLS_* path throws here, at startup, rather than
  // silently serving plaintext HTTP.
  const tlsConfig = resolveTlsConfig();
  const scheme = tlsConfig ? "https" : "http";
  const server = tlsConfig ? createHttpsServer(tlsConfig, app) : app;
  const commandAuthConfigForBanner = resolveCommandAuthConfig();
  const certCommonNamesForBanner = resolveCertAuthAllowedCommonNames();
  if (certCommonNamesForBanner.length > 0 && !tlsConfig?.requestCert) {
    console.error("[HYDRA-UMC-GATEWAY-INDUSTRIAL] refusing to start: GATEWAY_CERT_ALLOWED_CN needs mutual TLS (TLS_CLIENT_CA_PATH)");
    process.exit(1);
  }
  const rateLimitConfigForBanner = resolveRateLimitConfig();

  // Loopback unless told otherwise: the container image and any LAN deployment set GATEWAY_BIND_HOST explicitly.
  const bindHost = process.env.GATEWAY_BIND_HOST?.trim() || "127.0.0.1";
  const listener = server.listen(PORT, bindHost, () => {
    console.log("=================================================");
    console.log(` HYDRA-UMC-GATEWAY-INDUSTRIAL v${readPackageVersion()}`);
    console.log(" ROLE: Industry 4.0 interoperability bridge for factory standards");
    console.log(` STATUS: Running on ${bindHost}:${PORT} - status: ${scheme}://localhost:${PORT}/status`);
    console.log(` SECURITY: ${describeTlsMode(tlsConfig)}`);
    console.log(` COMMAND AUTH: ${describeCommandAuthMode(commandAuthConfigForBanner, certCommonNamesForBanner)}`);
    console.log(` PROBES: ${resolveProbeMode() === "protocol" ? "protocol (OPC UA Hello, MQTT CONNECT, MTConnect /probe document)" : "reachability (TCP connect / HTTP 2xx)"}`);
    console.log(` RATE LIMIT: ${describeRateLimitMode(rateLimitConfigForBanner)}`);
    console.log(` AUDIT: every POST /command attempt logged to ${resolveAuditLogPath()}`);
    console.log(" CHILDREN: OPC-UA (4840) / MQTT (1883) / MTConnect (5000) - see docker-compose.yml");
    console.log("=================================================");
  });

  // A clean stop: no new connections, the audit log flushed to disk, and an end after at most five seconds if a connection will not let go.
  const shutdown = (signal: string) => {
    console.log(`[HYDRA-UMC-GATEWAY-INDUSTRIAL] ${signal} received: closing`);
    const forced = setTimeout(() => process.exit(0), 5000);
    forced.unref();
    listener.close(() => {
      void (auditLogger.close?.() ?? Promise.resolve()).finally(() => process.exit(0));
    });
    listener.closeIdleConnections?.();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

// Only auto-start when run directly, not when imported by
// tests/server.test.ts.
const entryFile = process.argv[1] ? process.argv[1].split(/[/\\]/).pop() : "";
if (entryFile === "server.ts" || entryFile === "server.cjs" || entryFile === "server.js") {
  main();
}
