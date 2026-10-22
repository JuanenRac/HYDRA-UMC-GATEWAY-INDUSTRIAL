// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Prometheus metrics: src/metrics.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Counters the gateway keeps anyway (how many commands ended each way, how many status probes ran) and the last reachability of each child, in the Prometheus text
// format. GET /metrics exists only with GATEWAY_METRICS=1; it carries numbers and the names of the three children, nothing else.
// =============================================================================

export interface ChildSample {
  name: string;
  protocol: string;
  reachable: boolean;
  latencyMs: number;
}

/** GATEWAY_METRICS: off unless it is exactly "1". */
export function metricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.GATEWAY_METRICS ?? "").trim() === "1";
}

// Label values come from fixed lists or from the gateway's own outcome names, but they are escaped anyway.
function label(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export class MetricsRegistry {
  private readonly startedAt = Date.now();
  private statusProbes = 0;
  private readonly commands = new Map<string, number>();
  private children: ChildSample[] = [];

  /** One round of child probes finished. */
  statusProbed(children: ChildSample[]): void {
    this.statusProbes += 1;
    this.children = children;
  }

  /** One POST /command attempt ended with this outcome (accepted, rate_limited, auth_invalid_token, ...). */
  commandEnded(outcome: string): void {
    this.commands.set(outcome, (this.commands.get(outcome) ?? 0) + 1);
  }

  render(): string {
    const lines: string[] = [];
    const header = (name: string, help: string, kind: "counter" | "gauge") => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${kind}`);
    };
    header("hydra_gateway_uptime_seconds", "Seconds since the process started.", "gauge");
    lines.push(`hydra_gateway_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`);
    header("hydra_gateway_status_probes_total", "Rounds of child probes run for GET /status.", "counter");
    lines.push(`hydra_gateway_status_probes_total ${this.statusProbes}`);
    header("hydra_gateway_commands_total", "POST /command attempts by outcome.", "counter");
    for (const [outcome, count] of [...this.commands].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`hydra_gateway_commands_total{outcome="${label(outcome)}"} ${count}`);
    }
    header("hydra_gateway_child_reachable", "1 when the child answered the last probe.", "gauge");
    for (const child of this.children) lines.push(`hydra_gateway_child_reachable{child="${label(child.name)}",protocol="${label(child.protocol)}"} ${child.reachable ? 1 : 0}`);
    header("hydra_gateway_child_probe_latency_milliseconds", "How long the last probe of the child took.", "gauge");
    for (const child of this.children) lines.push(`hydra_gateway_child_probe_latency_milliseconds{child="${label(child.name)}",protocol="${label(child.protocol)}"} ${child.latencyMs}`);
    return lines.join("\n") + "\n";
  }
}
