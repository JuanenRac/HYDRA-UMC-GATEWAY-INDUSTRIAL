// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Command allowlist + backpressure: src/command.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The real decision layer this Gateway needs before it can ever relay a
// write/command to a protocol bridge: forwarding an arbitrary operation
// string without restriction would let anything an operator's tooling
// happens to send through, including ones this v0 has no business
// allowing - none of the three children (HYDRA-UMC-OPCUA-SERVER,
// HYDRA-UMC-MQTT-BROKER, HYDRA-UMC-MTCONNECT-ADAPTER) expose a real
// command API of their own yet either. CommandDispatcher is real and
// testable today, independent of that still-missing downstream:
//   - Default-deny allowlist: an operation is only ever forwarded if it
//     is explicitly listed for its protocol. v0's DEFAULT_ALLOWLIST only
//     lists read-like/publish operations - nothing that could alter a
//     live PLC's state is allowed yet.
//   - Backpressure: no more than `maxConcurrent` commands run at once;
//     anything beyond that is rejected immediately rather than queued
//     indefinitely, so a burst of requests can never pile up unbounded
//     against a slow or stuck downstream.
//   - Timeout: a command whose executor doesn't resolve within its
//     budget is reported as timed out rather than left hanging forever.
//     Crucially, that *response* timeout does not pretend the underlying
//     executor stopped: its capacity slot remains held until it really
//     settles, preventing an uncooperative downstream from bypassing
//     backpressure by accumulating abandoned work.
//     A rejecting executor is a distinct, real failure mode: withTimeout()
//     settles the returned promise correctly whichever of the executor or
//     the timer finishes first, so an executor that throws is reported as
//     "executor_error" - never masked as a timeout, and never left as an
//     unhandled promise rejection.
// The default executor (see server.ts's buildCommandExecutor) reuses
// this project's own real reachability probes (probes.ts) - a command
// cannot be relayed to a child that isn't even there. It is honest about
// not yet performing an actual protocol-level write.
// =============================================================================

import type { WriteGate } from "./writeGate.js";

export type Protocol = "OPC-UA" | "MQTT" | "MTConnect";

/** The closed list of protocols a command may name; anything else is a malformed request, never a lookup key. */
export const PROTOCOLS: readonly Protocol[] = ["OPC-UA", "MQTT", "MTConnect"];

export function isProtocol(value: unknown): value is Protocol {
  return typeof value === "string" && (PROTOCOLS as readonly string[]).includes(value);
}

/** The longest response budget a caller may ask for. Node clamps timers above 2^31-1 ms to 1 ms, and a command that holds a concurrency slot for hours is not a command. */
export const MAX_COMMAND_TIMEOUT_MS = 30_000;

export interface CommandRequest {
  protocol: Protocol;
  operation: string;
  target: string;
  timeoutMs?: number;
  /** For an OPC-UA "write": the value to write. */
  value?: unknown;
  /** For an OPC-UA "write_commit": the id that "write" handed out. */
  confirmId?: string;
  /** Who asks (the `sub` of the token), so a confirmation can only be used by the one it was handed to. */
  caller?: string | null;
}

export type CommandOutcome =
  | { status: "accepted"; latencyMs: number }
  // The target answered a reachability probe, but this gateway has no executor that performs the operation: nothing was executed, and the caller must not believe it was.
  | { status: "probe_only"; latencyMs: number; reason: string }
  | { status: "rejected_unauthorized"; reason: string }
  // The write gate (writeGate.ts) refused a write or its confirmation, or handed out a confirmation id: nothing was written either way.
  | { status: "rejected_write"; reason: string }
  | { status: "write_prepared"; confirmId: string; expiresAtMs: number }
  | { status: "rejected_backpressure"; reason: string }
  | { status: "timeout"; reason: string }
  | { status: "downstream_unreachable"; reason: string }
  | { status: "executor_error"; reason: string };

export type CommandExecutor = (req: CommandRequest) => Promise<{ ok: boolean; detail?: string; /** false when the executor only probed the target and performed nothing (default: true) */ executed?: boolean }>;

// The topics an MQTT "publish" may target when nothing else is configured: a namespace of the gateway's own. The bridges' own command topics (hydra/bridges/...) are never
// reachable through the gateway, whatever is configured, because a free publish there would be an unauthenticated order to a machine.
export const DEFAULT_MQTT_PUBLISH_TOPICS: readonly string[] = ["hydra/gateway/#"];
const NEVER_PUBLISH_PREFIXES: readonly string[] = ["hydra/bridges/", "vda5050/", "$SYS/", "$"];

/** MQTT topic-vs-filter match for a concrete topic (`+` one level, `#` the rest). */
export function mqttTopicMatches(topic: string, filter: string): boolean {
  const topicSegments = topic.split("/");
  const filterSegments = filter.split("/");
  for (let i = 0; i < filterSegments.length; i++) {
    const part = filterSegments[i];
    if (part === "#") return i === filterSegments.length - 1;
    if (i >= topicSegments.length) return false;
    if (part === "+") continue;
    if (part !== topicSegments[i]) return false;
  }
  return topicSegments.length === filterSegments.length;
}

/** Why a published topic is refused, or null when it is allowed: a concrete topic (no wildcards), inside the configured namespace, never a bridge command topic. */
export function mqttPublishTopicProblem(topic: string, allowedFilters: readonly string[]): string | null {
  if (topic === "" || /[+#]/.test(topic) || topic.includes(String.fromCharCode(0))) return "an MQTT publish needs a concrete topic (no wildcards)";
  if (NEVER_PUBLISH_PREFIXES.some(prefix => topic.startsWith(prefix))) return `the gateway never publishes to '${topic}' (bridge command and system topics are reserved)`;
  if (!allowedFilters.some(filter => mqttTopicMatches(topic, filter))) return `'${topic}' is outside the topics this gateway may publish to`;
  return null;
}

// Default-deny per protocol: only what is listed here is ever forwarded.
// Deliberately narrow for v0 - no OPC-UA node write, MQTT retained/config
// publish, or MTConnect device command is allowlisted yet. Extend this
// per protocol, deliberately, once a child actually exposes a real
// command API to relay such an operation to.
export const DEFAULT_ALLOWLIST: Readonly<Record<Protocol, ReadonlySet<string>>> = {
  "OPC-UA": new Set(["read"]),
  MQTT: new Set(["publish"]),
  MTConnect: new Set(["read"]),
};

export interface DispatcherOptions {
  allowlist?: Readonly<Record<Protocol, ReadonlySet<string>>>;
  maxConcurrent?: number;
  defaultTimeoutMs?: number;
  executor?: CommandExecutor;
  /** Topic filters an MQTT publish may target (default DEFAULT_MQTT_PUBLISH_TOPICS). */
  mqttPublishTopics?: readonly string[];
  /** The gate for OPC-UA writes. Without one, or while it is not enabled, "write" is not an operation of the gateway. */
  writeGate?: WriteGate;
}

const TIMEOUT_MARKER = "timeout" as const;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMEOUT_MARKER> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(TIMEOUT_MARKER);
      }
    }, timeoutMs);
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      },
    );
  });
}

export class CommandDispatcher {
  private readonly allowlist: Readonly<Record<Protocol, ReadonlySet<string>>>;
  private readonly maxConcurrent: number;
  private readonly defaultTimeoutMs: number;
  private readonly executor: CommandExecutor;
  private readonly mqttPublishTopics: readonly string[];
  private readonly writeGate: WriteGate | undefined;
  private inFlight = 0;

  constructor(options: DispatcherOptions = {}) {
    this.allowlist = options.allowlist ?? DEFAULT_ALLOWLIST;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 2000;
    this.mqttPublishTopics = options.mqttPublishTopics ?? DEFAULT_MQTT_PUBLISH_TOPICS;
    this.writeGate = options.writeGate;
    this.executor =
      options.executor ??
      (async () => ({ ok: false, detail: "no executor configured for this dispatcher" }));
  }

  isAuthorized(protocol: Protocol, operation: string): boolean {
    // The two steps of a write exist only for OPC-UA and only while the gate is on; the allowlist never lists them.
    if (protocol === "OPC-UA" && (operation === "write" || operation === "write_commit")) return this.writeGate?.enabled === true;
    // Own properties only: "constructor" or "__proto__" must never resolve to an inherited object.
    if (!Object.hasOwn(this.allowlist, protocol)) return false;
    return this.allowlist[protocol]?.has(operation) ?? false;
  }

  /** The write gate this dispatcher consults, if any. */
  get gate(): WriteGate | undefined {
    return this.writeGate;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  // Real, ordered decision: authorization is checked before capacity, so
  // a disallowed operation is always rejected the same way regardless of
  // how busy the gateway happens to be right now - an unauthorized
  // command must never appear to have merely been "too busy" to run.
  async dispatch(req: CommandRequest): Promise<CommandOutcome> {
    const gate = this.writeGate;
    if (gate && req.protocol === "OPC-UA" && this.isAuthorized(req.protocol, req.operation)) {
      const caller = req.caller ?? null;
      if (req.operation === "write") {
        const decision = await gate.prepare(caller, req.target, req.value);
        return decision.ok ? { status: "write_prepared", confirmId: decision.confirmId, expiresAtMs: decision.expiresAtMs } : { status: "rejected_write", reason: decision.reason };
      }
      if (req.operation === "write_commit") {
        const decision = await gate.commit(caller, req.confirmId);
        if (!decision.ok) return { status: "rejected_write", reason: decision.reason };
        // the released write goes through the same capacity and timeout rules as any other command
        const outcome = await this.run({ protocol: "OPC-UA", operation: "write", target: decision.target, value: decision.value, timeoutMs: req.timeoutMs, caller });
        gate.recordExecution(caller, decision.target, outcome.status);
        return outcome;
      }
    }
    return this.run(req);
  }

  private async run(req: CommandRequest): Promise<CommandOutcome> {
    if (!this.isAuthorized(req.protocol, req.operation)) {
      return {
        status: "rejected_unauthorized",
        reason: `operation "${req.operation}" is not allowlisted for ${req.protocol}`,
      };
    }

    if (req.protocol === "MQTT" && req.operation === "publish") {
      const problem = mqttPublishTopicProblem(req.target, this.mqttPublishTopics);
      if (problem) return { status: "rejected_unauthorized", reason: problem };
    }

    if (this.inFlight >= this.maxConcurrent) {
      return {
        status: "rejected_backpressure",
        reason: `gateway already has ${this.inFlight} command(s) in flight (limit ${this.maxConcurrent})`,
      };
    }

    this.inFlight++;
    let releaseAfterExecutorSettles = false;
    const startedAt = Date.now();
    // Capture this exact execution promise once. If the response budget
    // expires first, the executor may still own a real downstream socket or
    // protocol request. Its eventual rejection is observed below so it never
    // becomes an unhandled rejection, and its capacity is released only then.
    const execution = Promise.resolve().then(() => this.executor(req));
    try {
      const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
      let result: { ok: boolean; detail?: string; executed?: boolean } | typeof TIMEOUT_MARKER;
      try {
        result = await withTimeout(execution, timeoutMs);
      } catch (err) {
        // A rejecting/throwing executor is a real error, not a network
        // timeout - reporting it as "timeout" would mask the executor's
        // own bug. Surfaced here (rather than left to reject dispatch()
        // itself) so callers always get back a real CommandOutcome
        // instead of having to also wrap dispatch() in a try/catch.
        const message = err instanceof Error ? err.message : String(err);
        return { status: "executor_error", reason: `executor threw: ${message}` };
      }
      if (result === TIMEOUT_MARKER) {
        releaseAfterExecutorSettles = true;
        void execution.then(
          () => {
            this.inFlight--;
          },
          () => {
            this.inFlight--;
          },
        );
        return { status: "timeout", reason: `command timed out after ${timeoutMs}ms` };
      }
      if (!result.ok) {
        return {
          status: "downstream_unreachable",
          reason: result.detail ?? `${req.protocol} target "${req.target}" did not confirm the command`,
        };
      }
      if (result.executed === false) {
        return { status: "probe_only", latencyMs: Date.now() - startedAt, reason: result.detail ?? `${req.protocol} target "${req.target}" is reachable, but this gateway has no executor that performs the operation: nothing was executed` };
      }
      return { status: "accepted", latencyMs: Date.now() - startedAt };
    } finally {
      if (!releaseAfterExecutorSettles) {
        this.inFlight--;
      }
    }
  }
}
