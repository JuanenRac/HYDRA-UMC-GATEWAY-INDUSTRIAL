// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Real per-command caller authentication: src/auth.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
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
/**
 * Optional certificate login for POST /command: with mutual TLS on, a client whose verified certificate has a CN in GATEWAY_CERT_ALLOWED_CN is the caller (as
 * `cert:<CN>`) and needs no token. Anything else still has to present a valid token when GATEWAY_JWT_SECRET is set. Off unless the list is set.
 */
export function resolveCertAuthAllowedCommonNames(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return (env.GATEWAY_CERT_ALLOWED_CN ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

/** The CN of the verified client certificate of this connection, or null (plain connection, no certificate, or one the TLS layer did not accept). */
export function verifiedClientCertificateCommonName(req: Request): string | null {
  const socket = req.socket as unknown as { authorized?: boolean; getPeerCertificate?: () => { subject?: { CN?: string | string[] } } | null };
  if (socket.authorized !== true || typeof socket.getPeerCertificate !== "function") return null;
  const common = socket.getPeerCertificate()?.subject?.CN;
  const name = Array.isArray(common) ? common[0] : common;
  return typeof name === "string" && name !== "" ? name : null;
}

/** GATEWAY_REQUIRE_TLS_FOR_AUTH: off unless it is exactly "1". */
export function requireTlsForAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.GATEWAY_REQUIRE_TLS_FOR_AUTH ?? "").trim() === "1";
}

/** Whether a peer address is this machine (IPv4 127/8, IPv6 ::1, or the IPv4-mapped form). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return bare === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/**
 * With GATEWAY_REQUIRE_TLS_FOR_AUTH=1 a request that carries credentials (an Authorization header) over plain HTTP from another machine is refused before the credential is even
 * looked at: a bearer token on the wire without TLS is a token anybody on the path can copy. Loopback is exempt (a reverse proxy that terminates TLS on the same machine).
 */
export function requireTlsForCredentials() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const encrypted = (req.socket as unknown as { encrypted?: boolean }).encrypted === true;
    if (!req.headers.authorization || encrypted || isLoopbackAddress(req.socket?.remoteAddress)) {
      next();
      return;
    }
    res.locals.auditOutcome = "auth_plain_http";
    res.locals.auditReason = "Authorization header over plain HTTP from a non-loopback address";
    res.status(403).json({ error: "credentials are not accepted over plain HTTP: use TLS (TLS_CERT_PATH and TLS_KEY_PATH) or connect from the same machine" });
  };
}

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
  if (resolveCertAuthAllowedCommonNames(env).length > 0) {
    // certificate login only works over mutual TLS: the list without a client CA would let nobody in (or, worse, look protected)
    if (!env.TLS_CERT_PATH?.trim() || !env.TLS_KEY_PATH?.trim() || !env.TLS_CLIENT_CA_PATH?.trim()) {
      return "GATEWAY_CERT_ALLOWED_CN needs mutual TLS: set TLS_CERT_PATH, TLS_KEY_PATH and TLS_CLIENT_CA_PATH";
    }
    if (!secret) return null; // the certificate is the credential
  }
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
export function requireCommandAuth(config: CommandAuthConfig | null, certificateCommonNames: readonly string[] = []) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (certificateCommonNames.length > 0) {
      const commonName = verifiedClientCertificateCommonName(req);
      if (commonName !== null && certificateCommonNames.includes(commonName)) {
        req.commandCaller = `cert:${commonName}`;
        next();
        return;
      }
      if (config === null) {
        res.locals.auditOutcome = "auth_cert_required";
        res.status(403).json({ error: "a client certificate whose CN is in GATEWAY_CERT_ALLOWED_CN is required" });
        return;
      }
    }
    if (config === null) {
      next();
      return;
    }
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
export function describeCommandAuthMode(config: CommandAuthConfig | null, certificateCommonNames: readonly string[] = []): string {
  if (certificateCommonNames.length > 0) {
    return `POST /command accepts a verified client certificate with CN in [${certificateCommonNames.join(", ")}]${config ? " or a valid Bearer token" : ""}`;
  }
  return config
    ? `POST /command requires a valid Bearer token (HS256, GATEWAY_JWT_SECRET, exp and sub required${config.audience ? `, aud=${config.audience}` : ""})`
    : "POST /command has NO caller authentication (GATEWAY_JWT_SECRET not set) - configure it or restrict network access";
}
