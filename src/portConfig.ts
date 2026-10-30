// =============================================================================
// HYDRA-UMC-GATEWAY-INDUSTRIAL - src/portConfig.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The listen port of this service. Three services of the same machine used to
// read the one variable PORT, so a shared EnvironmentFile (or an `export
// PORT=3000`) silently moved this one onto another service's port. Each
// service now has a variable of its own, which wins; PORT is only a last
// resort and says so on the console.
// =============================================================================

export interface ResolvedPort {
  port: number;
  /** "specific" | "PORT" | "default" */
  source: "specific" | "PORT" | "default";
  warning?: string;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined;
}

export function resolveServicePort(
  env: Record<string, string | undefined>,
  specificName: string,
  fallback: number,
): ResolvedPort {
  const specific = parsePort(env[specificName]);
  if (specific !== undefined) return { port: specific, source: "specific" };
  const shared = parsePort(env.PORT);
  if (shared !== undefined) {
    return {
      port: shared,
      source: "PORT",
      warning: `${specificName} is not set: using the shared PORT=${shared}. Set ${specificName} so another service of this machine cannot move this one.`,
    };
  }
  return { port: fallback, source: "default" };
}
