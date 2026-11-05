// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Container health probe: src/healthcheck.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// `node dist/healthcheck.cjs`: asks GET /health of the gateway on this machine and exits 0 when it answers 200. With the identity of HYDRA-UMC-SERVER on
// (GATEWAY_IDENTITY_KEY_FILE) nothing is open, so the probe signs a short-lived token of its own with the same key file; the token never leaves the machine.
// Without the identity it asks plainly, as the container always did.
// =============================================================================
import { resolveIdentityKey, signServerToken } from "./serverIdentity.js";

async function main(): Promise<number> {
  const port = process.env.HYDRA_UMC_GATEWAY_PORT || process.env.PORT || "8000";
  try {
    const key = resolveIdentityKey();
    const headers: Record<string, string> = key ? { Authorization: `Bearer ${signServerToken(key)}` } : {};
    const response = await fetch(`http://127.0.0.1:${port}/health`, { headers, signal: AbortSignal.timeout(2500) });
    return response.status === 200 ? 0 : 1;
  } catch {
    return 1;
  }
}

void main().then((code) => process.exit(code));
