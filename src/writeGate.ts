// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Gate for writes to a controller: src/writeGate.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// A write to a PLC can move a machine, so it is held to more than a read:
//   1. Off by default. Writes exist only when GATEWAY_WRITES=1; the allowlist of the dispatcher still denies "write" unless the gate is on.
//   2. A rule per node: a write is accepted only for a node that a rule names, with a value of the type the rule says and inside its range
//      (or one of its listed values). A node with no rule cannot be written, whatever the caller holds.
//   3. Two steps: "write" only PREPARES (the gate checks everything and answers a confirmation id that expires and can be used once, by the
//      same caller, for the same node and value); "write_commit" with that id is what executes.
//   4. The state of the cell: both steps ask for the safety state of the cell (the SafetyState of the SDK). Only a fresh READY lets a write
//      through; INHIBITED, FAULT, SAFE_STOP, a state that is too old, or no way to know it refuse (fail closed).
//   5. Every decision is recorded in a chain: each record carries the SHA-256 of the one before it, so a record that is removed or edited
//      afterwards breaks the chain (verifyChain). The chain is tamper-evident, not signed: it proves the log is consistent, not who wrote it.
// The executor that really writes is separate (CommandExecutor): without one the commit ends as "probe_only", nothing was written.
// =============================================================================

import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";

/** The states the safety service reports (SafetyState of the SDK). */
export type CellStateName = "READY" | "INHIBITED" | "FAULT" | "SAFE_STOP";

export interface CellStateReading {
  state: string;
  /** When the state was reported, in milliseconds since the epoch. */
  atMs: number;
}

export type CellStateProvider = () => Promise<CellStateReading | null>;

export type WriteValue = number | boolean | string;

export interface WriteRule {
  /** The exact NodeId, such as "ns=2;s=Line1.Setpoint". No wildcards: a node is allowed one by one. */
  target: string;
  type: "number" | "boolean" | "string";
  min?: number;
  max?: number;
  /** For a string or a number that may only take some values. */
  values?: WriteValue[];
}

export interface WriteGateOptions {
  enabled?: boolean;
  rules?: readonly WriteRule[];
  /** How long a confirmation id lasts (default 30000, at most 300000). */
  confirmTtlMs?: number;
  /** Where the state of the cell comes from. Without one every write is refused. */
  cellState?: CellStateProvider;
  /** The oldest state reading that still counts (default 2000). */
  cellStateMaxAgeMs?: number;
  /** At most this many prepared writes wait for their confirmation (default 64). */
  maxPending?: number;
  now?: () => number;
}

export type GateDecision =
  | { ok: true; confirmId: string; expiresAtMs: number }
  | { ok: false; reason: string };

export type CommitDecision =
  | { ok: true; target: string; value: WriteValue }
  | { ok: false; reason: string };

export interface ChainRecord {
  seq: number;
  at: string;
  event: string;
  caller: string | null;
  target: string;
  detail: string;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);
const MAX_CHAIN = 1000;
export const MAX_CONFIRM_TTL_MS = 300_000;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function chainHash(record: Omit<ChainRecord, "hash">): string {
  return sha256([record.seq, record.at, record.event, record.caller ?? "", record.target, record.detail, record.prevHash].join("\n"));
}

/** True when every record carries the hash of its content and the hash of the one before it (the first one follows the genesis value). */
export function verifyChain(records: readonly ChainRecord[]): boolean {
  let previous = records.length > 0 && records[0].seq > 1 ? records[0].prevHash : GENESIS;
  let expectedSeq = records.length > 0 ? records[0].seq : 1;
  for (const record of records) {
    if (record.seq !== expectedSeq || record.prevHash !== previous) return false;
    const { hash, ...rest } = record;
    if (chainHash(rest) !== hash) return false;
    previous = hash;
    expectedSeq++;
  }
  return true;
}

interface Pending {
  caller: string | null;
  target: string;
  value: WriteValue;
  expiresAtMs: number;
}

/** Why `value` cannot be written to the node of `rule`, or null when it can. */
export function valueProblem(rule: WriteRule, value: unknown): string | null {
  if (rule.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "the value must be a finite number";
    if (rule.min !== undefined && value < rule.min) return `the value ${value} is below the minimum ${rule.min}`;
    if (rule.max !== undefined && value > rule.max) return `the value ${value} is above the maximum ${rule.max}`;
  } else if (rule.type === "boolean") {
    if (typeof value !== "boolean") return "the value must be true or false";
  } else if (typeof value !== "string" || value.length > 256) {
    return "the value must be a text of at most 256 characters";
  }
  if (rule.values && !rule.values.includes(value as WriteValue)) return "the value is not one of the values this node may take";
  return null;
}

/** Reads the rules from JSON text; an invalid rule stops the start instead of leaving a node unprotected. */
export function parseWriteRules(text: string): WriteRule[] {
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : (parsed as { rules?: unknown })?.rules;
  if (!Array.isArray(list)) throw new Error("the write rules must be a list (or an object with a \"rules\" list)");
  const seen = new Set<string>();
  return list.map((raw, index) => {
    const rule = raw as Partial<WriteRule>;
    const where = `write rule ${index + 1}`;
    if (typeof rule.target !== "string" || rule.target.length === 0 || rule.target.length > 512 || /[*?]/.test(rule.target)) {
      throw new Error(`${where}: target must be an exact node id (no wildcards)`);
    }
    if (seen.has(rule.target)) throw new Error(`${where}: the node ${rule.target} has two rules`);
    seen.add(rule.target);
    if (rule.type !== "number" && rule.type !== "boolean" && rule.type !== "string") throw new Error(`${where}: type must be number, boolean or string`);
    for (const bound of ["min", "max"] as const) {
      if (rule[bound] !== undefined && (rule.type !== "number" || typeof rule[bound] !== "number" || !Number.isFinite(rule[bound]))) {
        throw new Error(`${where}: ${bound} is only for a number rule and must be a finite number`);
      }
    }
    if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) throw new Error(`${where}: min is above max`);
    if (rule.type === "number" && rule.min === undefined && rule.max === undefined && !rule.values) {
      throw new Error(`${where}: a number rule needs min and max (or values): an unbounded setpoint is not a rule`);
    }
    if (rule.values !== undefined && (!Array.isArray(rule.values) || rule.values.length === 0)) throw new Error(`${where}: values must be a non-empty list`);
    return { target: rule.target, type: rule.type, ...(rule.min !== undefined ? { min: rule.min } : {}), ...(rule.max !== undefined ? { max: rule.max } : {}), ...(rule.values ? { values: rule.values } : {}) };
  });
}

export class WriteGate {
  readonly enabled: boolean;
  private readonly rules: Map<string, WriteRule>;
  private readonly confirmTtlMs: number;
  private readonly cellState: CellStateProvider | undefined;
  private readonly cellStateMaxAgeMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();
  private readonly chain: ChainRecord[] = [];
  private nextSeq = 1;
  private lastHash = GENESIS;

  constructor(options: WriteGateOptions = {}) {
    this.enabled = options.enabled === true;
    this.rules = new Map((options.rules ?? []).map((rule) => [rule.target, rule]));
    this.confirmTtlMs = Math.min(Math.max(options.confirmTtlMs ?? 30_000, 1), MAX_CONFIRM_TTL_MS);
    this.cellState = options.cellState;
    this.cellStateMaxAgeMs = options.cellStateMaxAgeMs ?? 2000;
    this.maxPending = options.maxPending ?? 64;
    this.now = options.now ?? Date.now;
  }

  /** The records of the chain, oldest first (the last 1000). */
  auditChain(): readonly ChainRecord[] {
    return this.chain;
  }

  private record(event: string, caller: string | null, target: string, detail: string): void {
    const partial = { seq: this.nextSeq++, at: new Date(this.now()).toISOString(), event, caller, target, detail, prevHash: this.lastHash };
    const record: ChainRecord = { ...partial, hash: chainHash(partial) };
    this.lastHash = record.hash;
    this.chain.push(record);
    if (this.chain.length > MAX_CHAIN) this.chain.shift();
  }

  private refuse(event: string, caller: string | null, target: string, reason: string): { ok: false; reason: string } {
    this.record(event, caller, target, reason);
    return { ok: false, reason };
  }

  private async cellProblem(): Promise<string | null> {
    if (!this.cellState) return "no source of the cell state is configured: a write is not made blind";
    let reading: CellStateReading | null;
    try {
      reading = await this.cellState();
    } catch {
      return "the cell state could not be read: a write is not made blind";
    }
    if (!reading) return "the cell state is unknown: a write is not made blind";
    const age = this.now() - reading.atMs;
    if (!Number.isFinite(age) || age > this.cellStateMaxAgeMs || age < -this.cellStateMaxAgeMs) return `the cell state is ${Math.round(age)} ms old (limit ${this.cellStateMaxAgeMs} ms)`;
    if (reading.state !== "READY") return `the cell is ${reading.state}: writes are only made when it is READY`;
    return null;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.pending) if (entry.expiresAtMs <= now) this.pending.delete(id);
  }

  /** Step one: checks the write and, if it passes, hands out a confirmation id. Nothing is written. */
  async prepare(caller: string | null, target: string, value: unknown): Promise<GateDecision> {
    if (!this.enabled) return this.refuse("write_refused", caller, target, "writes are off (GATEWAY_WRITES is not 1)");
    const rule = this.rules.get(target);
    if (!rule) return this.refuse("write_refused", caller, target, "no write rule names this node");
    const problem = valueProblem(rule, value);
    if (problem) return this.refuse("write_refused", caller, target, problem);
    const cell = await this.cellProblem();
    if (cell) return this.refuse("write_refused", caller, target, cell);
    this.sweep();
    if (this.pending.size >= this.maxPending) return this.refuse("write_refused", caller, target, "too many writes wait for their confirmation");
    const confirmId = randomBytes(16).toString("hex");
    const expiresAtMs = this.now() + this.confirmTtlMs;
    this.pending.set(confirmId, { caller, target, value: value as WriteValue, expiresAtMs });
    this.record("write_prepared", caller, target, `value ${JSON.stringify(value)}, confirmation valid until ${new Date(expiresAtMs).toISOString()}`);
    return { ok: true, confirmId, expiresAtMs };
  }

  /** Step two: the confirmation id is used up whatever happens next, and the state of the cell is asked again. */
  async commit(caller: string | null, confirmId: unknown): Promise<CommitDecision> {
    if (!this.enabled) return this.refuse("commit_refused", caller, "", "writes are off (GATEWAY_WRITES is not 1)");
    const entry = typeof confirmId === "string" ? this.pending.get(confirmId) : undefined;
    if (typeof confirmId === "string") this.pending.delete(confirmId);
    if (!entry) return this.refuse("commit_refused", caller, "", "the confirmation id is unknown, expired or already used");
    if (entry.expiresAtMs <= this.now()) return this.refuse("commit_refused", caller, entry.target, "the confirmation id expired");
    if (entry.caller !== caller) return this.refuse("commit_refused", caller, entry.target, "the confirmation id was handed to another caller");
    const cell = await this.cellProblem();
    if (cell) return this.refuse("commit_refused", caller, entry.target, cell);
    this.record("write_committed", caller, entry.target, `value ${JSON.stringify(entry.value)} released to the executor`);
    return { ok: true, target: entry.target, value: entry.value };
  }

  /** Records what the executor did with a released write. */
  recordExecution(caller: string | null, target: string, detail: string): void {
    this.record("write_executed", caller, target, detail);
  }

  get pendingCount(): number {
    this.sweep();
    return this.pending.size;
  }
}

/** A stand-in for a controller: an in-memory table of node values, to try the whole path without a PLC. */
export function createSimulatedController(initial: Record<string, WriteValue> = {}) {
  const nodes = new Map<string, WriteValue>(Object.entries(initial));
  return {
    nodes,
    executor: async (req: { protocol: string; operation: string; target: string; value?: unknown }) => {
      if (req.operation === "write") {
        nodes.set(req.target, req.value as WriteValue);
        return { ok: true, detail: "written to the simulated controller" };
      }
      return nodes.has(req.target) ? { ok: true } : { ok: false, detail: `the simulated controller has no node ${req.target}` };
    },
  };
}

export function writesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.GATEWAY_WRITES ?? "").trim() === "1";
}
