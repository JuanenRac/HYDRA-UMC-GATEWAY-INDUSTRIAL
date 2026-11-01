// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - The audit chain of the write gate on disk: src/writeAuditStore.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// One JSON record per line, appended as the gate decides. At the start the file is read back and checked (hash chain and, with a key, the
// signatures) so the chain continues where it stopped; a file that does not verify stops the start instead of being silently replaced.
// =============================================================================

import fs from "node:fs";
import { MIN_AUDIT_KEY_LENGTH, verifyChain, type ChainRecord } from "./writeGate.js";

/** The most records read back at the start (the gate keeps the last 1000 in memory). */
const MAX_RESUME = 1000;

/** Reads the audit key from a file (its text, trimmed). The key never appears in a log or an error message. */
export function readAuditKey(file: string): string {
  const key = fs.readFileSync(file, "utf8").trim();
  if (key.length < MIN_AUDIT_KEY_LENGTH) throw new Error(`the audit key file must hold at least ${MIN_AUDIT_KEY_LENGTH} characters`);
  return key;
}

/** The records kept in the file (the newest MAX_RESUME), verified; an empty list when the file does not exist yet. */
export function loadAuditFile(file: string, key?: string): ChainRecord[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  const records: ChainRecord[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      records.push(JSON.parse(line) as ChainRecord);
    } catch {
      throw new Error(`the audit file ${file} has a line that is not JSON (line ${index + 1})`);
    }
  }
  const tail = records.slice(-MAX_RESUME);
  if (!verifyChain(tail, key)) throw new Error(`the audit file ${file} does not verify: it was edited, cut or signed with another key`);
  return tail;
}

/** A sink that appends each record to `file` (created with owner-only permissions). */
export function fileAuditSink(file: string): (record: ChainRecord) => void {
  return (record) => {
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  };
}
