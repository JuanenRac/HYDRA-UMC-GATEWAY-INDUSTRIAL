// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/metrics.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The Prometheus text of GET /metrics (src/metrics.ts): the shape of the lines, the counters, the escaping of labels and the switch.
// =============================================================================
import { describe, expect, it } from "vitest";
import { MetricsRegistry, metricsEnabled } from "../src/metrics.js";

function lines(registry: MetricsRegistry): string[] {
  return registry.render().split("\n");
}

describe("GATEWAY_METRICS", () => {
  it("is on only for the exact value 1 (blanks around it are ignored)", () => {
    expect(metricsEnabled({ GATEWAY_METRICS: "1" })).toBe(true);
    expect(metricsEnabled({ GATEWAY_METRICS: "  1\n" })).toBe(true);
    for (const value of ["", "0", "true", "yes", "on", "2", "1a"]) expect(metricsEnabled({ GATEWAY_METRICS: value })).toBe(false);
    expect(metricsEnabled({})).toBe(false);
  });
});

describe("the text of a fresh registry", () => {
  it("ends with one newline and has a HELP and a TYPE line before each family", () => {
    const text = new MetricsRegistry().render();
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    const all = text.split("\n");
    for (const family of [
      "hydra_gateway_uptime_seconds",
      "hydra_gateway_status_probes_total",
      "hydra_gateway_commands_total",
      "hydra_gateway_child_reachable",
      "hydra_gateway_child_probe_latency_milliseconds",
    ]) {
      const help = all.findIndex((line) => line.startsWith(`# HELP ${family} `));
      expect(help, family).toBeGreaterThanOrEqual(0);
      expect(all[help + 1]).toMatch(new RegExp(`^# TYPE ${family} (counter|gauge)$`));
    }
  });

  it("counts counters as counters and levels as gauges", () => {
    const text = new MetricsRegistry().render();
    expect(text).toContain("# TYPE hydra_gateway_status_probes_total counter");
    expect(text).toContain("# TYPE hydra_gateway_commands_total counter");
    expect(text).toContain("# TYPE hydra_gateway_uptime_seconds gauge");
    expect(text).toContain("# TYPE hydra_gateway_child_reachable gauge");
  });

  it("starts at zero probes, no command and no child", () => {
    const registry = new MetricsRegistry();
    expect(lines(registry)).toContain("hydra_gateway_status_probes_total 0");
    expect(registry.render()).not.toContain("hydra_gateway_commands_total{");
    expect(registry.render()).not.toContain("hydra_gateway_child_reachable{");
    expect(lines(registry).find((line) => line.startsWith("hydra_gateway_uptime_seconds "))).toMatch(/^hydra_gateway_uptime_seconds \d+$/);
  });
});

describe("the counters", () => {
  it("count the rounds of probes and keep the children of the last round only", () => {
    const registry = new MetricsRegistry();
    registry.statusProbed([{ name: "opcua", protocol: "OPC-UA", reachable: true, latencyMs: 12 }]);
    registry.statusProbed([
      { name: "mtconnect", protocol: "MTConnect", reachable: false, latencyMs: 3000 },
      { name: "modbus", protocol: "Modbus", reachable: true, latencyMs: 4 },
    ]);
    const text = registry.render();
    expect(text).toContain("hydra_gateway_status_probes_total 2");
    expect(text).not.toContain('child="opcua"');
    expect(text).toContain('hydra_gateway_child_reachable{child="mtconnect",protocol="MTConnect"} 0');
    expect(text).toContain('hydra_gateway_child_reachable{child="modbus",protocol="Modbus"} 1');
    expect(text).toContain('hydra_gateway_child_probe_latency_milliseconds{child="mtconnect",protocol="MTConnect"} 3000');
    expect(text).toContain('hydra_gateway_child_probe_latency_milliseconds{child="modbus",protocol="Modbus"} 4');
  });

  it("count the commands by outcome and list the outcomes in alphabetical order", () => {
    const registry = new MetricsRegistry();
    for (const outcome of ["rate_limited", "accepted", "accepted", "auth_invalid_token", "accepted", "rate_limited"]) registry.commandEnded(outcome);
    const rows = lines(registry).filter((line) => line.startsWith("hydra_gateway_commands_total{"));
    expect(rows).toEqual([
      'hydra_gateway_commands_total{outcome="accepted"} 3',
      'hydra_gateway_commands_total{outcome="auth_invalid_token"} 1',
      'hydra_gateway_commands_total{outcome="rate_limited"} 2',
    ]);
  });

  it("is not changed by rendering it twice", () => {
    const registry = new MetricsRegistry();
    registry.commandEnded("accepted");
    const first = registry.render().replace(/uptime_seconds \d+/, "");
    const second = registry.render().replace(/uptime_seconds \d+/, "");
    expect(second).toBe(first);
  });
});

describe("the labels", () => {
  it("escape a backslash, a quote and a line break so a name cannot add a line or a label", () => {
    const registry = new MetricsRegistry();
    registry.commandEnded('bad"outcome\\with\nbreak');
    registry.statusProbed([{ name: 'x"} 1\nhydra_fake 9', protocol: "a\\b", reachable: true, latencyMs: 1 }]);
    const text = registry.render();
    expect(text).toContain('outcome="bad\\"outcome\\\\with\\nbreak"');
    expect(text).not.toMatch(/^hydra_fake 9/m);
    for (const line of text.split("\n")) {
      if (line === "" || line.startsWith("#")) continue;
      expect(line).toMatch(/^hydra_gateway_[a-z_]+(\{.*\})? -?\d+$/);
    }
  });
});
