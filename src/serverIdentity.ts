// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - The common identity of the family: src/serverIdentity.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The signed token of HYDRA-UMC-SERVER as the identity of a caller of this gateway. The SERVER is the one issuer of identity of the family; this file
// is the same rule as the canonical `server_identity.py` of HYDRA-UMC-SDK, written for Node with nothing but the standard library. It is an opt-in and
// the default changes nothing:
//
//   * Off (GATEWAY_IDENTITY_KEY_FILE not set): the gateway behaves exactly as before (GATEWAY_JWT_SECRET, a client certificate, or an open lab gateway).
//   * On: the file holds the signing key of the SERVER (its JWT_SECRET, at least 32 characters, never read from the command line or the environment). A request
//     is then accepted only with a valid token of the SERVER: any role may read (GET, HEAD, OPTIONS), `admin` and `operator` may also change (POST /command).
//     NOTHING is open: GET /health, /status, /status/stream and /metrics need an identity too, loopback included. The probe of the container signs a short-lived
//     token of its own with the same key file (dist/healthcheck.cjs), which never leaves the machine and needs no token of the SERVER.
//
// What is checked in a token: a JWT whose algorithm is exactly HS256 (`none` and any other are refused), the signature (constant time), a present and future
// finite `exp`, an `nbf` that has passed, an `iat` not in the future, a non-empty `username` and a role of `admin`, `operator` or `viewer`. What a service cannot
// check is a revocation kept on the SERVER's side: keep JWT_EXPIRES_IN of the SERVER short for the accounts that call this gateway. The key is symmetric, so
// whoever can verify could also forge: the key file must be readable only by the group of this service.
//
// What an identity may do on POST /command is the same default-deny as any other caller: the scopes (`<protocol>:<operation>`) come from GATEWAY_IDENTITY_SCOPES
// (default: exactly the operations the dispatcher allows without configuration, so an identity adds no power the allowlist did not already give).
// =============================================================================
import crypto from "node:crypto";
import fs from "node:fs";
import type { NextFunction, Request, Response } from "express";

export const MIN_IDENTITY_KEY_LENGTH = 32;
const MAX_TOKEN_CHARS = 4096;
const IAT_SKEW_SECONDS = 5;
export const IDENTITY_ROLES = ["admin", "operator", "viewer"] as const;
export type IdentityRole = (typeof IDENTITY_ROLES)[number];
const WRITE_ROLES: ReadonlySet<string> = new Set(["admin", "operator"]);
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export const DEFAULT_IDENTITY_SCOPES: readonly string[] = ["opc-ua:read", "mqtt:publish", "mtconnect:read", "modbus:read"];

export interface ServerIdentity {
  username: string;
  role: IdentityRole;
}

export class IdentityError extends Error {}

/** The key file named by GATEWAY_IDENTITY_KEY_FILE, or null when the identity of the SERVER is off. Throws (the gateway does not start) when the file is named but unusable. */
export function resolveIdentityKey(env: NodeJS.ProcessEnv = process.env, readFile: (path: string) => string = (path) => fs.readFileSync(path, "utf8")): Buffer | null {
  const file = (env.GATEWAY_IDENTITY_KEY_FILE ?? "").trim();
  if (!file) return null;
  let text: string;
  try {
    text = readFile(file);
  } catch {
    throw new Error("GATEWAY_IDENTITY_KEY_FILE cannot be read");
  }
  const key = text.trim();
  if (key.length < MIN_IDENTITY_KEY_LENGTH) throw new Error(`the identity key must have at least ${MIN_IDENTITY_KEY_LENGTH} characters`);
  return Buffer.from(key, "utf8");
}

/** The scopes an identity of `admin` or `operator` gets on POST /command (GATEWAY_IDENTITY_SCOPES, comma or space separated, lower case). */
export function identityScopes(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = (env.GATEWAY_IDENTITY_SCOPES ?? "").trim();
  if (!raw) return DEFAULT_IDENTITY_SCOPES;
  return raw.split(/[\s,]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function decodeSegment(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) throw new IdentityError("the token is malformed");
  return Buffer.from(segment, "base64url");
}

function jsonSegment(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decodeSegment(segment).toString("utf8"));
  } catch {
    throw new IdentityError("the token is malformed");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new IdentityError("the token is malformed");
  return value as Record<string, unknown>;
}

const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The identity in a signed token of the SERVER, or an IdentityError saying why there is none. The message names no key, token or path. */
export function verifyServerToken(token: string | undefined, key: Buffer, nowMs: number = Date.now()): ServerIdentity {
  if (!token) throw new IdentityError("a signed token of HYDRA-UMC-SERVER is required");
  if (token.length > MAX_TOKEN_CHARS) throw new IdentityError("the token is malformed");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) throw new IdentityError("the token is malformed");
  if (jsonSegment(parts[0]).alg !== "HS256") throw new IdentityError("the token algorithm is not accepted (only HS256)");
  const expected = crypto.createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest();
  const given = decodeSegment(parts[2]);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new IdentityError("the token signature is not valid");
  const claims = jsonSegment(parts[1]);
  const now = nowMs / 1000;
  if (!finiteNumber(claims.exp)) throw new IdentityError("the token has no expiry");
  if (claims.exp <= now) throw new IdentityError("the token has expired");
  if (claims.nbf !== undefined && (!finiteNumber(claims.nbf) || claims.nbf > now)) throw new IdentityError("the token is not valid yet");
  if (claims.iat !== undefined && (!finiteNumber(claims.iat) || claims.iat > now + IAT_SKEW_SECONDS)) throw new IdentityError("the token was issued in the future");
  const { username, role } = claims;
  if (typeof username !== "string" || username === "") throw new IdentityError("the token names no user");
  if (typeof role !== "string" || !(IDENTITY_ROLES as readonly string[]).includes(role)) throw new IdentityError("the token carries no known role");
  return { username, role: role as IdentityRole };
}

/** A short-lived token in the format of the SERVER, signed with the shared key: what the probe of a container presents (a viewer can only read). */
export function signServerToken(key: Buffer, username = "health-probe", role: IdentityRole = "viewer", ttlSeconds = 60, nowMs: number = Date.now()): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const head = part({ alg: "HS256", typ: "JWT" });
  const body = part({ username, role, exp: Math.floor(nowMs / 1000) + ttlSeconds });
  const signature = crypto.createHmac("sha256", key).update(`${head}.${body}`).digest().toString("base64url");
  return `${head}.${body}.${signature}`;
}

/** The bearer token of a request, or undefined. */
export function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
}

/** Whether an identity may make this request: any role reads, `admin` and `operator` also change. */
export const identityMayDo = (identity: ServerIdentity, method: string): boolean => READ_METHODS.has(method.toUpperCase()) || WRITE_ROLES.has(identity.role);

declare module "express-serve-static-core" {
  interface Request {
    /** Who the signed token of the SERVER says is calling (only while the identity of the SERVER is on). */
    serverIdentity?: ServerIdentity;
  }
}

/**
 * Middleware for the read-only routes (GET /health, /status, /status/stream, /metrics): with the identity on, a request without a valid token of the SERVER is
 * refused (401 when none is presented, 403 when it is not valid), loopback included. Any role may read.
 */
export function requireServerIdentity(key: Buffer) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "a signed token of HYDRA-UMC-SERVER is required (Authorization: Bearer <token>)" });
      return;
    }
    try {
      const identity = verifyServerToken(token, key);
      if (!identityMayDo(identity, req.method)) {
        res.status(403).json({ error: "this role may only read" });
        return;
      }
      req.serverIdentity = identity;
      next();
    } catch (error) {
      res.status(403).json({ error: `invalid identity: ${error instanceof Error ? error.message : "refused"}` });
    }
  };
}
