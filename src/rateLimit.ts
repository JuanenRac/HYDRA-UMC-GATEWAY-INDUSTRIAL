// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Real rate limiting for POST /command: src/rateLimit.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real gap this closes: POST /command had no volumetric protection at
// all - authenticated or not, a caller could fire commands as fast as
// the gateway (and its downstream OPC-UA/MQTT/MTConnect children) could
// take them, on top of CommandDispatcher's own concurrency backpressure
// (command.ts), which only bounds requests IN FLIGHT right now, not the
// real rate a caller is allowed to send them at over time.
//
// This project's own package.json deliberately lists only `express` and
// `jsonwebtoken` as real dependencies - no `express-rate-limit`. A hand-
// rolled, in-memory, per-key fixed-window counter needs neither a new
// dependency nor an external store (Redis etc.) for what this endpoint
// actually needs: bounding how often ANY one caller can call an internal
// industrial-gateway endpoint, not rate-limiting a public API at scale.
// =============================================================================
import type { NextFunction, Request, Response } from "express";

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 60;

// Same opt-out-via-env convention as resolveCommandAuthConfig()/
// resolveTlsConfig(): sane, real defaults out of the box, overridable per
// deployment - never a config a real operator is forced to set by hand
// before this endpoint is safe to expose.
export function resolveRateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const windowMs = Number(env.GATEWAY_COMMAND_RATE_WINDOW_MS);
  const maxRequests = Number(env.GATEWAY_COMMAND_RATE_MAX);
  return {
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS,
    maxRequests: Number.isFinite(maxRequests) && maxRequests > 0 ? maxRequests : DEFAULT_MAX_REQUESTS,
  };
}

interface Bucket {
  count: number;
  windowStart: number;
}

// Pruned opportunistically rather than on a timer - this gateway has no
// other background interval, and a real deployment sees far fewer
// distinct callers than would ever make an unbounded Map a real problem
// before the next prune runs.
const PRUNE_THRESHOLD = 10_000;

/** Real per-key fixed-window rate limiter. A fresh instance owns its own
 * state (same per-app-instance reasoning as CommandDispatcher in
 * command.ts) - never a module-level singleton shared across tests or
 * across an app that gets rebuilt. */
export class CommandRateLimiter {
  private readonly config: RateLimitConfig;
  private readonly buckets = new Map<string, Bucket>();

  constructor(config: RateLimitConfig = resolveRateLimitConfig()) {
    this.config = config;
  }

  private pruneExpired(now: number): void {
    if (this.buckets.size < PRUNE_THRESHOLD) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.config.windowMs) this.buckets.delete(key);
    }
  }

  /** A caller right at a window boundary can be admitted up to ~2x
   * `maxRequests` within a short span in the worst case - the known,
   * accepted trade-off of a fixed-window counter over a sliding one, and
   * a reasonable one for a hand-rolled v0 limiter guarding an internal
   * gateway endpoint rather than a public API. */
  check(key: string, now: number = Date.now()): { allowed: boolean; retryAfterMs: number } {
    this.pruneExpired(now);
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.config.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (bucket.count >= this.config.maxRequests) {
      return { allowed: false, retryAfterMs: this.config.windowMs - (now - bucket.windowStart) };
    }
    bucket.count++;
    return { allowed: true, retryAfterMs: 0 };
  }
}

// Keyed by remote address rather than caller identity: this middleware
// runs before requireCommandAuth (auth.ts) below it in server.ts's own
// middleware chain, so an authenticated caller's identity isn't known
// yet - and a real caller hammering the endpoint with invalid/missing
// tokens needs limiting just as much as one sending valid commands too
// fast, so gating on the pre-auth remote address covers both.
export function requireCommandRateLimit(limiter: CommandRateLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? "unknown";
    const result = limiter.check(key);
    if (!result.allowed) {
      const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
      res.locals.auditOutcome = "rate_limited";
      res.locals.auditReason = `rate limit exceeded for ${key}`;
      res.status(429).set("Retry-After", String(retryAfterSec)).json({
        error: `rate limit exceeded - try again in ${retryAfterSec}s`,
      });
      return;
    }
    next();
  };
}

export function describeRateLimitMode(config: RateLimitConfig): string {
  return `POST /command limited to ${config.maxRequests} request(s) per ${config.windowMs}ms per caller`;
}
