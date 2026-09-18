// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Real immutable audit trail: src/audit.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real gap this closes: POST /command had no record anywhere of who
// asked for what and what happened - not even in the console, once the
// process log scrolled past. This logs a real, append-only entry for
// EVERY real attempt this gateway receives, whatever the outcome:
// accepted, rejected by the allowlist, rejected by rate limiting,
// unauthenticated, an invalid request body - not just the successful
// ones.
//
// Mirrors HYDRA-UMC-SERVER's own industrialLog() convention (see that
// project's src/server.ts): one persistent fs.WriteStream kept open for
// the life of the process instead of an open+write+close on every single
// call (which would block Node's single-threaded event loop on every
// command), append-mode so a restart never truncates history, and the
// same size-based single-file rotation (current -> .1) once the file
// passes MAX_AUDIT_LOG_BYTES - simple, "immutable by convention" (an
// append-only file an operator or SIEM can tail/ship), not a
// cryptographically-tamper-proof ledger, which this v0 does not claim.
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

export interface CommandAuditEntry {
  timestamp: string;
  /** Bearer-token subject (auth.ts's own req.commandCaller), or null when
   * this deployment has no caller auth configured, or the request never
   * got past authentication to be attributed to anyone. */
  caller: string | null;
  protocol?: unknown;
  operation?: unknown;
  target?: unknown;
  /** e.g. "accepted", "rejected_unauthorized", "rejected_backpressure",
   * "auth_missing_token", "auth_invalid_token", "rate_limited",
   * "invalid_request" - always the real, specific reason this attempt
   * ended the way it did, never just an HTTP status code. */
  outcome: string;
  reason?: string;
  httpStatus: number;
}

export interface CommandAuditLogger {
  record(entry: Omit<CommandAuditEntry, "timestamp">): void;
}

const DEFAULT_AUDIT_LOG_PATH = "logs/command-audit.log";
// Same rotation threshold as HYDRA-UMC-SERVER's own industrialLog() - see
// that file's own comment: enough for a real tail view, not meant to
// replace journalctl/a real log aggregator for long-term retention.
const MAX_AUDIT_LOG_BYTES = 10 * 1024 * 1024;

/** Pure path resolution, no file I/O - shared by FileCommandAuditLogger's
 * own default and by server.ts's startup banner, so the banner can print
 * the real path a request will actually be logged to without opening a
 * second real WriteStream onto the same file just to find out. */
export function resolveAuditLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.GATEWAY_AUDIT_LOG_PATH?.trim() || DEFAULT_AUDIT_LOG_PATH;
}

/** Real file-backed logger - the actual audit trail a running gateway
 * writes to disk. */
export class FileCommandAuditLogger implements CommandAuditLogger {
  readonly filePath: string;
  private readonly rotatedPath: string;
  // Opened lazily, on the first real record() call - not in the
  // constructor. buildApp() constructs a default logger on every call
  // (including for GET /status-only tests and app instances that never
  // see a POST /command), and a real gateway may run a long time before
  // its first command - neither should touch disk or hold a file handle
  // for a log that may never receive an entry.
  private stream: fs.WriteStream | null = null;

  constructor(filePath: string = resolveAuditLogPath()) {
    this.filePath = filePath;
    this.rotatedPath = `${filePath}.1`;
  }

  private ensureStream(): fs.WriteStream {
    if (!this.stream) this.stream = this.openStream();
    return this.stream;
  }

  private openStream(): fs.WriteStream {
    const dir = path.dirname(this.filePath);
    if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
    const stream = fs.createWriteStream(this.filePath, { flags: "a" });
    stream.on("error", (err) => console.error("[commandAudit] log stream error", err));
    return stream;
  }

  private rotateIfNeeded(): void {
    let size = 0;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return; // file doesn't exist yet (fresh install/first entry) - nothing to rotate
    }
    if (size < MAX_AUDIT_LOG_BYTES) return;

    this.stream?.end();
    try {
      fs.rmSync(this.rotatedPath, { force: true });
      fs.renameSync(this.filePath, this.rotatedPath);
    } catch (err) {
      console.error("[commandAudit] log rotation failed", err);
    }
    this.stream = this.openStream();
  }

  record(entry: Omit<CommandAuditEntry, "timestamp">): void {
    this.ensureStream();
    // May replace this.stream with a fresh handle onto the now-empty
    // current file - always read this.stream again below rather than
    // reusing a reference captured before this call.
    this.rotateIfNeeded();
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
    this.ensureStream().write(line + "\n");
  }
}

/** In-memory double for tests: real entries, zero file I/O, so a test can
 * assert on the exact audit record a request produced without depending
 * on (or polluting) a real log file on disk. */
export class InMemoryCommandAuditLogger implements CommandAuditLogger {
  readonly entries: CommandAuditEntry[] = [];

  record(entry: Omit<CommandAuditEntry, "timestamp">): void {
    this.entries.push({ timestamp: new Date().toISOString(), ...entry });
  }
}

// Wired as the FIRST middleware on POST /command (server.ts), before rate
// limiting and auth - hooking res.on("finish") here means this fires
// whichever later middleware/handler ends the response, so every real
// attempt is recorded regardless of where in the chain it was decided:
// rate-limited, unauthenticated, allowlist-rejected, or accepted. Each of
// those exit points sets res.locals.auditOutcome (and optionally
// auditReason) right before responding - see auth.ts/rateLimit.ts/
// server.ts's own /command handler - so the real, specific reason is
// always captured, never guessed back from the HTTP status code alone
// (multiple real outcomes share the same status code, e.g. 403 for both
// an invalid token and an allowlist rejection).
export function recordCommandAttempt(logger: CommandAuditLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on("finish", () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const outcome = typeof res.locals.auditOutcome === "string" ? res.locals.auditOutcome : `http_${res.statusCode}`;
      const reason = typeof res.locals.auditReason === "string" ? res.locals.auditReason : undefined;
      logger.record({
        caller: req.commandCaller ?? null,
        protocol: body.protocol,
        operation: body.operation,
        target: body.target,
        outcome,
        ...(reason !== undefined ? { reason } : {}),
        httpStatus: res.statusCode,
      });
    });
    next();
  };
}
