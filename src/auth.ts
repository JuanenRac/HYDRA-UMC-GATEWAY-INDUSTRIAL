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
  /** When set (GATEWAY_JWT_AUDIENCE), a token must carry this `aud`, so a token minted for another service with the same secret is not accepted here. */
  audience?: string;
}

// Returns null (never a partial config) when GATEWAY_JWT_SECRET is
// unset - the caller's own signal that command authentication is not
// configured for this deployment yet, matching resolveTlsConfig()'s own
// convention in tls.ts.
export function resolveCommandAuthConfig(env: NodeJS.ProcessEnv = process.env): CommandAuthConfig | null {
  const secret = env.GATEWAY_JWT_SECRET?.trim();
  if (!secret) return null;
  const audience = env.GATEWAY_JWT_AUDIENCE?.trim();
  return audience ? { secret, audience } : { secret };
}

export const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER = /(set[_ -]?locally|change[_ -]?me|replace[_ -]?me|your[_ -]?(secret|password)|example|placeholder|remove[_ -]?after)/i;

/**
 * Why the gateway must refuse to start (null when it may go on). POST /command can relay an operation to the plant floor: a missing, short or example secret means anybody
 * who can reach the port can issue it (or forge a token), so the gateway does not start in ANY environment, unless GATEWAY_ALLOW_ANONYMOUS=1 says on purpose that this is an open lab gateway.
 */
export function commandAuthStartupProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if ((env.GATEWAY_ALLOW_ANONYMOUS ?? "").trim() === "1") return null;
  const secret = env.GATEWAY_JWT_SECRET?.trim() ?? "";
  if (!secret) return "GATEWAY_JWT_SECRET is not set: POST /command would accept commands from anybody on the network";
  if (PLACEHOLDER.test(secret)) return "GATEWAY_JWT_SECRET is an example value: generate a real one (for example `openssl rand -hex 32`)";
  if (secret.length < MIN_SECRET_LENGTH) return `GATEWAY_JWT_SECRET must have at least ${MIN_SECRET_LENGTH} characters`;
  if (new Set(secret).size < 8) return "GATEWAY_JWT_SECRET is too repetitive to be a random value";
  return null;
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
      res.locals.auditOutcome = "auth_missing_token";
      res.status(401).json({ error: "missing Authorization: Bearer <token> header" });
      return;
    }
    try {
      const payload = jwt.verify(token, config.secret, {
        algorithms: ["HS256"],
        ...(config.audience ? { audience: config.audience } : {}),
      });
      if (typeof payload !== "object" || payload === null) throw new Error("token payload must be an object");
      // A token that never expires is valid forever once it leaks, and one without a subject cannot be attributed in the audit trail.
      if (typeof payload.exp !== "number") throw new Error("token must carry an exp claim");
      if (typeof payload.sub !== "string" || payload.sub.trim() === "") throw new Error("token must carry a sub claim");
      req.commandCaller = payload.sub;
      next();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      res.locals.auditOutcome = "auth_invalid_token";
      res.locals.auditReason = detail;
      res.status(403).json({ error: `invalid or expired command token: ${detail}` });
    }
  };
}

// One human-readable line for the real startup banner - same reasoning
// as describeTlsMode() in tls.ts: an operator must see, at boot, whether
// /command is actually gated or wide open, never silently.
export function describeCommandAuthMode(config: CommandAuthConfig | null): string {
  return config
    ? `POST /command requires a valid Bearer token (HS256, GATEWAY_JWT_SECRET, exp and sub required${config.audience ? `, aud=${config.audience}` : ""})`
    : "POST /command has NO caller authentication (GATEWAY_JWT_SECRET not set) - configure it or restrict network access";
}
