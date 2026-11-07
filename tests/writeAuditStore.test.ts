// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/writeAuditStore.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The file that keeps the audit chain of the write gate (src/writeAuditStore.ts): the key file, a missing or empty file, blank lines, the cap on what is
// read back, a chain that starts later than 1, a missing signature and the permissions of the file.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileAuditSink, loadAuditFile, readAuditKey } from "../src/writeAuditStore.js";
import { MIN_AUDIT_KEY_LENGTH, WriteGate, verifyChain, type ChainRecord, type WriteRule } from "../src/writeGate.js";

const KEY = "k".repeat(MIN_AUDIT_KEY_LENGTH);
const RULES: WriteRule[] = [{ target: "ns=2;s=Line1.Setpoint", type: "number", min: 0, max: 100 }];

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-audit-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function records(count: number, key?: string): Promise<ChainRecord[]> {
  const out: ChainRecord[] = [];
  const gate = new WriteGate({
    enabled: true,
    rules: RULES,
    cellState: async () => ({ state: "READY", atMs: Date.now() }),
    maxPending: count + 10,
    ...(key !== undefined ? { auditKey: key } : {}),
    auditSink: (record) => out.push(record),
  });
  for (let i = 0; out.length < count && i < count * 3; i++) await gate.prepare("tech", "ns=2;s=Line1.Setpoint", i % 100);
  expect(out).toHaveLength(count);
  return out;
}

function write(file: string, list: readonly ChainRecord[]): void {
  fs.writeFileSync(file, list.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

describe("the key file", () => {
  it("is read and trimmed", () => {
    const file = path.join(dir, "key");
    fs.writeFileSync(file, `  ${KEY}\n`);
    expect(readAuditKey(file)).toBe(KEY);
  });

  it("must hold at least the minimum length, and the message does not show the key", () => {
    const file = path.join(dir, "key");
    const shortKey = "secret-too-short";
    fs.writeFileSync(file, shortKey);
    expect(() => readAuditKey(file)).toThrow(new RegExp(`at least ${MIN_AUDIT_KEY_LENGTH}`));
    try {
      readAuditKey(file);
    } catch (error) {
      expect(String(error)).not.toContain(shortKey);
    }
    fs.writeFileSync(file, "   \n");
    expect(() => readAuditKey(file)).toThrow(/at least/);
  });

  it("a key file that does not exist is an error of the file system, not a silent default", () => {
    expect(() => readAuditKey(path.join(dir, "missing"))).toThrow();
  });
});

describe("loading the file", () => {
  it("gives an empty list for a file that does not exist yet, an empty one or one with blank lines only", () => {
    expect(loadAuditFile(path.join(dir, "none.jsonl"))).toEqual([]);
    const empty = path.join(dir, "empty.jsonl");
    fs.writeFileSync(empty, "");
    expect(loadAuditFile(empty, KEY)).toEqual([]);
    fs.writeFileSync(empty, "\n\n   \n");
    expect(loadAuditFile(empty, KEY)).toEqual([]);
  });

  it("ignores blank lines between records", async () => {
    const list = await records(3, KEY);
    const file = path.join(dir, "audit.jsonl");
    fs.writeFileSync(file, `\n${JSON.stringify(list[0])}\n\n${JSON.stringify(list[1])}\n   \n${JSON.stringify(list[2])}\n\n`);
    expect(loadAuditFile(file, KEY)).toEqual(list);
  });

  it("says which line is not JSON", async () => {
    const list = await records(2, KEY);
    const file = path.join(dir, "audit.jsonl");
    fs.writeFileSync(file, `${JSON.stringify(list[0])}\n{"seq":2,\n`);
    expect(() => loadAuditFile(file, KEY)).toThrow(/line 2/);
  });

  it("keeps only the newest 1000 records and still verifies a chain that starts after 1", async () => {
    const list = await records(1010, KEY);
    const file = path.join(dir, "audit.jsonl");
    write(file, list);
    const tail = loadAuditFile(file, KEY);
    expect(tail).toHaveLength(1000);
    expect(tail[0].seq).toBe(11);
    expect(tail[999].seq).toBe(1010);
    expect(verifyChain(tail, KEY)).toBe(true);
  }, 60_000);

  it("refuses a record taken out of the middle, a swapped pair and a repeated record", async () => {
    const list = await records(4, KEY);
    const file = path.join(dir, "audit.jsonl");
    write(file, [list[0], list[2], list[3]]);
    expect(() => loadAuditFile(file, KEY)).toThrow(/does not verify/);
    write(file, [list[0], list[2], list[1], list[3]]);
    expect(() => loadAuditFile(file, KEY)).toThrow(/does not verify/);
    write(file, [list[0], list[1], list[1], list[2]]);
    expect(() => loadAuditFile(file, KEY)).toThrow(/does not verify/);
  });

  it("refuses a signed chain read without the key it was signed with, and an unsigned chain read with a key", async () => {
    const signed = await records(2, KEY);
    const unsigned = await records(2);
    const file = path.join(dir, "audit.jsonl");
    write(file, signed);
    expect(() => loadAuditFile(file, "z".repeat(MIN_AUDIT_KEY_LENGTH))).toThrow(/does not verify/);
    expect(loadAuditFile(file)).toHaveLength(2);
    write(file, unsigned);
    expect(() => loadAuditFile(file, KEY)).toThrow(/does not verify/);
    expect(loadAuditFile(file)).toHaveLength(2);
  });

  it("refuses a record whose signature was removed", async () => {
    const list = await records(2, KEY);
    const bare: ChainRecord = { ...list[1] };
    delete bare.sig;
    const file = path.join(dir, "audit.jsonl");
    write(file, [list[0], bare]);
    expect(() => loadAuditFile(file, KEY)).toThrow(/does not verify/);
  });
});

describe("the sink", () => {
  it("appends one line per record and the file reads back as the same chain", async () => {
    const list = await records(5, KEY);
    const file = path.join(dir, "audit.jsonl");
    const sink = fileAuditSink(file);
    for (const record of list) sink(record);
    expect(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(5);
    expect(loadAuditFile(file, KEY)).toEqual(list);
  });

  it.skipIf(process.platform === "win32")("creates the file readable by its owner only", async () => {
    const list = await records(1, KEY);
    const file = path.join(dir, "audit.jsonl");
    fileAuditSink(file)(list[0]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps what was already in the file and adds to it", async () => {
    const list = await records(3, KEY);
    const file = path.join(dir, "audit.jsonl");
    const sink = fileAuditSink(file);
    sink(list[0]);
    sink(list[1]);
    const again = fileAuditSink(file);
    again(list[2]);
    expect(loadAuditFile(file, KEY)).toEqual(list);
  });

  it("throws when the file cannot be written, so the gate can count the failure", async () => {
    const list = await records(1, KEY);
    const sink = fileAuditSink(path.join(dir, "no-such-folder", "audit.jsonl"));
    expect(() => sink(list[0])).toThrow();
  });
});
