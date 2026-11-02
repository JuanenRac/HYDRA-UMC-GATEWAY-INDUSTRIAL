// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Change journal of industrial orders: src/journal.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Every order that reached the dispatcher of POST /command (read or write, accepted or refused, with how it ended) is kept in a short list in
// memory (GET /command/journal) and, when GATEWAY_JOURNAL_URL names a HYDRA-UMC-DATALAKE, sent there so it can be queried later and read by
// HYDRA-UMC-PRODUCTION-REPORTS like any other series. Off unless GATEWAY_JOURNAL_URL (or GATEWAY_JOURNAL=1 for the list alone) is set.
//
// A sample of the lake holds numbers only, so the names go in the identity of the series:
//   sourceId  gw:<caller>                  who ordered it (the sub of the token, or "anonymous"; characters outside A-Z a-z 0-9 . _ : - become "_")
//   kind      cmd.<protocol>.<operation>   for example cmd.Modbus.write_commit
//   fields    <target>                     the value written or read when it is a number or a boolean (1/0), otherwise 1
//             status.<outcome>             1
//             latencyMs                    how long it took, when known
// The journal never decides anything and never delays an order: the sending is queued and a lake that is down loses samples (counted), not orders.
// The signed audit chain of the write gate stays the record of what the gate decided; the journal is the queryable timeline next to it.
// =============================================================================

export interface JournalEntry {
  atMs: number;
  protocol: string;
  operation: string;
  target: string;
  caller: string | null;
  outcome: string;
  latencyMs?: number;
  /** The value written, or the value read, when it is a number or a boolean. */
  value?: number | boolean;
}

export interface JournalOptions {
  /** `http://host:port` of the data lake. Without it the journal only keeps the list in memory. */
  lakeUrl?: string;
  token?: string;
  /** How many entries the list keeps (default 200). */
  keep?: number;
  /** How many samples wait to be sent at most (default 2000). */
  queueLimit?: number;
  /** How often the queue is sent (default 1000 ms). */
  flushMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Sample {
  sourceId: string;
  kind: string;
  timestamp: number;
  fields: Record<string, number>;
}

const SAFE = /[^A-Za-z0-9._:-]/g;

/** The samples the lake gets for one entry. */
export function journalSample(entry: JournalEntry, timestamp: number): Sample {
  const caller = (entry.caller ?? "anonymous").replace(SAFE, "_").slice(0, 96) || "anonymous";
  const fields: Record<string, number> = {};
  fields[entry.target] = typeof entry.value === "number" && Number.isFinite(entry.value) ? entry.value : typeof entry.value === "boolean" ? (entry.value ? 1 : 0) : 1;
  fields[`status.${entry.outcome}`] = 1;
  if (entry.latencyMs !== undefined && Number.isFinite(entry.latencyMs)) fields.latencyMs = entry.latencyMs;
  return { sourceId: `gw:${caller}`, kind: `cmd.${entry.protocol}.${entry.operation}`.replace(SAFE, "_"), timestamp, fields };
}

export class CommandJournal {
  private readonly entries: JournalEntry[] = [];
  private readonly queue: Sample[] = [];
  private readonly keep: number;
  private readonly queueLimit: number;
  private readonly lakeUrl: string | undefined;
  private readonly token: string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private lastTimestamp = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;
  /** Samples the lake accepted, dropped because the queue was full, and refused or unreachable. */
  sent = 0;
  dropped = 0;
  failed = 0;

  constructor(options: JournalOptions = {}) {
    this.keep = Math.max(1, options.keep ?? 200);
    this.queueLimit = Math.max(1, options.queueLimit ?? 2000);
    this.lakeUrl = options.lakeUrl?.replace(/\/+$/, "");
    this.token = options.token;
    this.doFetch = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    if (this.lakeUrl) {
      this.timer = setInterval(() => void this.flush(), Math.max(50, options.flushMs ?? 1000));
      this.timer.unref?.();
    }
  }

  get toLake(): boolean {
    return this.lakeUrl !== undefined;
  }

  /** The newest entries, newest first. */
  recent(limit = 100): JournalEntry[] {
    return this.entries.slice(-Math.max(1, limit)).reverse();
  }

  /** Adds one order. Never throws and never waits for the lake. */
  record(entry: JournalEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.keep) this.entries.shift();
    if (!this.lakeUrl) return;
    // every sample of the journal has a millisecond of its own, so two orders in the same millisecond do not replace one another in the lake
    const timestamp = Math.max(entry.atMs, this.lastTimestamp + 1);
    this.lastTimestamp = timestamp;
    if (this.queue.length >= this.queueLimit) {
      this.dropped += 1;
      return;
    }
    this.queue.push(journalSample(entry, timestamp));
  }

  /** Sends what is queued (one batch at a time). Resolves when that batch is answered. */
  async flush(): Promise<void> {
    if (!this.lakeUrl || this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, 100);
    try {
      const response = await this.doFetch(`${this.lakeUrl}/ingest/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify({ samples: batch }),
        signal: AbortSignal.timeout(3000),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok) this.sent += batch.length;
      else this.failed += batch.length;
    } catch {
      this.failed += batch.length;
    } finally {
      this.flushing = false;
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  stats(): { toLake: boolean; sent: number; dropped: number; failed: number; queued: number; kept: number } {
    return { toLake: this.toLake, sent: this.sent, dropped: this.dropped, failed: this.failed, queued: this.queue.length, kept: this.entries.length };
  }
}

/** The journal from the environment, or undefined while it is off (GATEWAY_JOURNAL_URL for the lake, GATEWAY_JOURNAL=1 for the list alone). */
export function journalFromEnv(env: NodeJS.ProcessEnv = process.env, read: (file: string) => string = () => ""): CommandJournal | undefined {
  const url = env.GATEWAY_JOURNAL_URL?.trim();
  const listOnly = (env.GATEWAY_JOURNAL ?? "").trim() === "1";
  if (!url && !listOnly) return undefined;
  if (url && !/^https?:\/\/[^/\s]+$/i.test(url.replace(/\/+$/, ""))) throw new Error("GATEWAY_JOURNAL_URL must be http://host:port of the data lake");
  const tokenFile = env.GATEWAY_JOURNAL_TOKEN_FILE?.trim();
  const token = tokenFile ? read(tokenFile).trim() : env.GATEWAY_JOURNAL_TOKEN?.trim();
  const keep = Number(env.GATEWAY_JOURNAL_KEEP);
  return new CommandJournal({
    ...(url ? { lakeUrl: url } : {}),
    ...(token ? { token } : {}),
    ...(Number.isInteger(keep) && keep > 0 ? { keep } : {}),
  });
}
