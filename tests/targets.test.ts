// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/targets.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The format of a target for each protocol (src/targets.ts): tables of what is accepted and refused, the limits, and a fixed-seed fuzz that a refused
// target never slips into a command line made only of safe characters.
// =============================================================================
import { describe, expect, it } from "vitest";
import { strictTargetsEnabled, targetFormatProblem } from "../src/targets.js";

const OPC_VALID = [
  "ns=1;s=HydraNode_1.SwarmOnline",
  "i=2253",
  "ns=0;i=85",
  "ns=65535;i=1",
  "ns=2;s=Line1.Setpoint",
  "s=plain",
  "g=09087e75-8e5e-499b-954f-f2a9603db28a",
  "ns=3;g=09087E75-8E5E-499B-954F-F2A9603DB28A",
  "b=SGVsbG8=",
  "ns=4;b=AAAA",
  `s=${"a".repeat(256)}`,
  "i=4294967295",
];
const OPC_INVALID = [
  "",
  " ",
  "ns=;s=a",
  "ns=123456;i=1",
  "i=12345678901",
  "i=",
  "i=-1",
  "i=1.5",
  "s=",
  `s=${"a".repeat(257)}`,
  "s=a\u0000b",
  "s=a\nb",
  "s=a\u007fb",
  "ns=1;x=2",
  "ns=1",
  "ns=1;",
  "b=%%%",
  "b=AA=A",
  "b=AAAA===",
  "g=zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
  "g=09087e75-8e5e-499b-954f-f2a9603db28",
  "NS=1;s=a",
  " ns=1;s=a",
];
const MTC_VALID = ["/current", "/probe", "/sample", "/assets", "/sample?from=10&count=5", "/HydraNode_1/probe", "/dev-1.a:b/current", "/sample?at=5;x=1"];
const MTC_INVALID = [
  "",
  "/",
  "current",
  "/other",
  "/a/b/current",
  "/current/..",
  "/../probe",
  "/a..b/probe",
  "/current?x= y",
  "/current?x=\n",
  "/current#frag",
  "/current/",
  "//current",
  `/${"d".repeat(129)}/probe`,
  `/current?${"q".repeat(257)}`,
  "http://host/current",
  "/CURRENT ",
];
const MODBUS_VALID = ["modbus:plc1/setpoint", "modbus:a/b", "modbus:Plc_1.a-b/Reg.1_x", `modbus:${"a".repeat(64)}/${"b".repeat(64)}`, "modbus:1/2"];
const MODBUS_INVALID = [
  "",
  "modbus:",
  "modbus:/x",
  "modbus:a/",
  "modbus:-a/b",
  "modbus:a/-b",
  "modbus:.a/b",
  "modbus:a/b/c",
  "modbus:a b/c",
  "modbus:a/b c",
  "modbus:a\n/b",
  `modbus:${"a".repeat(65)}/b`,
  `modbus:a/${"b".repeat(65)}`,
  "Modbus:a/b",
  "modbus:a/b ",
  "plc1/setpoint",
];

describe("the target of an OPC-UA command", () => {
  it.each(OPC_VALID)("accepts %j", (target) => {
    expect(targetFormatProblem("OPC-UA", target)).toBeNull();
  });
  it.each(OPC_INVALID)("refuses %j and says what a NodeId looks like", (target) => {
    expect(targetFormatProblem("OPC-UA", target)).toContain("NodeId");
  });
});

describe("the target of an MTConnect command", () => {
  it.each(MTC_VALID)("accepts %j", (target) => {
    expect(targetFormatProblem("MTConnect", target)).toBeNull();
  });
  it.each(MTC_INVALID)("refuses %j and says what a path looks like", (target) => {
    expect(targetFormatProblem("MTConnect", target)).toContain("MTConnect target is a path");
  });
});

describe("the target of a Modbus command", () => {
  it.each(MODBUS_VALID)("accepts %j", (target) => {
    expect(targetFormatProblem("Modbus", target)).toBeNull();
  });
  it.each(MODBUS_INVALID)("refuses %j and says what the form is", (target) => {
    expect(targetFormatProblem("Modbus", target)).toContain("modbus:<device>/<register>");
  });
});

describe("the target of an MQTT command", () => {
  it("is not judged here (its own stricter check lives in the command module)", () => {
    for (const target of ["", "a/b/c", "#", "+/x", "a\nb", "x".repeat(5000)]) expect(targetFormatProblem("MQTT", target)).toBeNull();
  });
});

describe("a fixed-seed fuzz of the formats", () => {
  function lcg(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }
  const ALPHABET = "abcXYZ019 ;=&?/:._-+%#\n\u0000\u007f$`'\"\\*";

  it("never accepts a target with a control character, and a path or a register name never with a space or a quote", () => {
    const random = lcg(20261107);
    let accepted = 0;
    for (let round = 0; round < 6000; round++) {
      const length = Math.floor(random() * 30);
      let text = "";
      for (let i = 0; i < length; i++) text += ALPHABET[Math.floor(random() * ALPHABET.length)];
      const prefix = ["", "ns=1;s=", "i=", "/", "/sample?", "modbus:", "modbus:a/"][Math.floor(random() * 7)];
      const target = prefix + text;
      for (const protocol of ["OPC-UA", "MTConnect", "Modbus"] as const) {
        if (targetFormatProblem(protocol, target) === null) {
          accepted++;
          expect(target).not.toMatch(/[\u0000-\u001f\u007f]/);
          // a NodeId string may hold spaces and quotes (it is data, sent as a parameter); a path or a register name never does
          if (protocol !== "OPC-UA") expect(target).not.toMatch(/[\s"'`\\*$]/);
        }
      }
    }
    expect(accepted).toBeGreaterThan(50);
  });

  it("gives the same answer for the same target every time", () => {
    for (const target of [...OPC_VALID, ...OPC_INVALID, ...MTC_VALID, ...MODBUS_INVALID]) {
      for (const protocol of ["OPC-UA", "MTConnect", "Modbus", "MQTT"] as const) {
        expect(targetFormatProblem(protocol, target)).toBe(targetFormatProblem(protocol, target));
      }
    }
  });
});

describe("GATEWAY_STRICT_TARGETS", () => {
  it("is on only for the exact value 1 (blanks around it are ignored)", () => {
    expect(strictTargetsEnabled({ GATEWAY_STRICT_TARGETS: "1" })).toBe(true);
    expect(strictTargetsEnabled({ GATEWAY_STRICT_TARGETS: " 1 " })).toBe(true);
    for (const value of ["", "0", "true", "yes", "on", "11", "01", "1.0"]) expect(strictTargetsEnabled({ GATEWAY_STRICT_TARGETS: value })).toBe(false);
    expect(strictTargetsEnabled({})).toBe(false);
  });
});
