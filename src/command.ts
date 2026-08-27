// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Command allowlist + backpressure: src/command.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
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
// The default executor (see server.ts's buildCommandExecutor) reuses
// this project's own real reachability probes (probes.ts) - a command
// cannot be relayed to a child that isn't even there. It is honest about
// not yet performing an actual protocol-level write.
// =============================================================================

export type Protocol = "OPC-UA" | "MQTT" | "MTConnect";

export interface CommandRequest {
  protocol: Protocol;
  operation: string;
  target: string;
  timeoutMs?: number;
}

export type CommandOutcome =
  | { status: "accepted"; latencyMs: number }
  | { status: "rejected_unauthorized"; reason: string }
  | { status: "rejected_backpressure"; reason: string }
  | { status: "timeout"; reason: string }
  | { status: "downstream_unreachable"; reason: string };

export type CommandExecutor = (req: CommandRequest) => Promise<{ ok: boolean; detail?: string }>;

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
}

const TIMEOUT_MARKER = "timeout" as const;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMEOUT_MARKER> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(TIMEOUT_MARKER);
      }
    }, timeoutMs);
    promise.then((value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    });
  });
}

export class CommandDispatcher {
  private readonly allowlist: Readonly<Record<Protocol, ReadonlySet<string>>>;
  private readonly maxConcurrent: number;
  private readonly defaultTimeoutMs: number;
  private readonly executor: CommandExecutor;
  private inFlight = 0;

  constructor(options: DispatcherOptions = {}) {
    this.allowlist = options.allowlist ?? DEFAULT_ALLOWLIST;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 2000;
    this.executor =
      options.executor ??
      (async () => ({ ok: false, detail: "no executor configured for this dispatcher" }));
  }

  isAuthorized(protocol: Protocol, operation: string): boolean {
    return this.allowlist[protocol]?.has(operation) ?? false;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  // Real, ordered decision: authorization is checked before capacity, so
  // a disallowed operation is always rejected the same way regardless of
  // how busy the gateway happens to be right now - an unauthorized
  // command must never appear to have merely been "too busy" to run.
  async dispatch(req: CommandRequest): Promise<CommandOutcome> {
    if (!this.isAuthorized(req.protocol, req.operation)) {
      return {
        status: "rejected_unauthorized",
        reason: `operation "${req.operation}" is not allowlisted for ${req.protocol}`,
      };
    }

    if (this.inFlight >= this.maxConcurrent) {
      return {
        status: "rejected_backpressure",
        reason: `gateway already has ${this.inFlight} command(s) in flight (limit ${this.maxConcurrent})`,
      };
    }

    this.inFlight++;
    const startedAt = Date.now();
    try {
      const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
      const result = await withTimeout(this.executor(req), timeoutMs);
      if (result === TIMEOUT_MARKER) {
        return { status: "timeout", reason: `command timed out after ${timeoutMs}ms` };
      }
      if (!result.ok) {
        return {
          status: "downstream_unreachable",
          reason: result.detail ?? `${req.protocol} target "${req.target}" did not confirm the command`,
        };
      }
      return { status: "accepted", latencyMs: Date.now() - startedAt };
    } finally {
      this.inFlight--;
    }
  }
}
