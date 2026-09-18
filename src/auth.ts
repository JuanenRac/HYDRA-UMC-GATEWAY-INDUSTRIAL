// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Real per-command caller authentication: src/auth.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real gap this closes: without TLS_CLIENT_CA_PATH configured (see
// tls.ts), POST /command has no way at all to tell WHO is issuing a
// command - only WHAT operation they asked for (command.ts's own
// allowlist). A caller on the same network segment as the gateway could
// issue any allowlisted operation with nothing to attribute it to. This
// module is the same kind of opt-in, honest-about-its-own-state control
// as tls.ts: GATEWAY_JWT_SECRET absent means "this deployment hasn't
// configured caller authentication yet" (server.ts logs that loudly at
// startup, it is never silent) - set, it becomes a real, enforced
// Bearer-token check on every POST /command.
//
// algorithms: ["HS256"] is pinned explicitly (never left to the
// library's own default) - the same defense-in-depth against
// algorithm-confusion attacks already applied in HYDRA-UMC-SERVER's own
// jwt.verify() call sites.
// =============================================================================
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";

export interface CommandAuthConfig {
  secret: string;
}

// Returns null (never a partial config) when GATEWAY_JWT_SECRET is
// unset - the caller's own signal that command authentication is not
// configured for this deployment yet, matching resolveTlsConfig()'s own
// convention in tls.ts.
export function resolveCommandAuthConfig(env: NodeJS.ProcessEnv = process.env): CommandAuthConfig | null {
  const secret = env.GATEWAY_JWT_SECRET?.trim();
  if (!secret) return null;
  return { secret };
}

declare module "express-serve-static-core" {
  interface Request {
    commandCaller?: string;
  }
}

// Express middleware enforcing a valid HS256 Bearer token on the request
// it guards. Only ever wired onto POST /command in server.ts - GET
// /status and GET /health stay open (read-only diagnostics, not commands
// that alter plant-floor state).
export function requireCommandAuth(config: CommandAuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
    if (!token) {
      res.status(401).json({ error: "missing Authorization: Bearer <token> header" });
      return;
    }
    try {
      const payload = jwt.verify(token, config.secret, { algorithms: ["HS256"] });
      req.commandCaller = typeof payload === "object" && payload !== null && typeof payload.sub === "string" ? payload.sub : "unknown";
      next();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      res.status(403).json({ error: `invalid or expired command token: ${detail}` });
    }
  };
}

// One human-readable line for the real startup banner - same reasoning
// as describeTlsMode() in tls.ts: an operator must see, at boot, whether
// /command is actually gated or wide open, never silently.
export function describeCommandAuthMode(config: CommandAuthConfig | null): string {
  return config
    ? "POST /command requires a valid Bearer token (HS256, GATEWAY_JWT_SECRET)"
    : "POST /command has NO caller authentication (GATEWAY_JWT_SECRET not set) - configure it or restrict network access";
}
