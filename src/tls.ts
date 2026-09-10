// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - Real TLS/mTLS configuration: src/tls.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Found while auditing the code: this project's
// own README already advertised "Mutual TLS (mTLS) and certificate-based
// authentication for all factory connections" (Key Features) and a
// "Security: mTLS / TLS 1.3" badge, but src/server.ts was, for real,
// plain HTTP (bare app.listen()) with zero TLS code anywhere - a real,
// serious gap between a public security claim and the actual behavior,
// not a cosmetic one. This module is the real fix: TLS is opt-in via
// real certificate files (TLS_CERT_PATH/TLS_KEY_PATH), and becomes real
// mutual TLS the moment a CA bundle is also configured
// (TLS_CLIENT_CA_PATH) - server.ts's own main() switches between plain
// http and https.createServer(resolveTlsConfig(), app) based on this.
//
// Deliberately fails LOUD, not soft: a configured-but-unreadable
// TLS_CERT_PATH/TLS_KEY_PATH/TLS_CLIENT_CA_PATH throws - an industrial
// gateway silently falling back to plaintext HTTP because of a typo'd
// path is a real security regression a startup crash is the right price
// to pay to prevent. Only the complete absence of TLS_CERT_PATH AND
// TLS_KEY_PATH means "this deployment hasn't configured TLS yet",
// matching every other real-cert-optional pattern in this ecosystem
// (e.g. HYDRA-UMC-MQTT-BROKER's own optional TLS listener).
import { readFileSync } from "node:fs";

export interface TlsConfig {
  cert: Buffer;
  key: Buffer;
  // Present only when mutual TLS is configured (TLS_CLIENT_CA_PATH set).
  ca?: Buffer;
  // Real mTLS: the server asks for and validates a client certificate
  // against `ca`, refusing the TLS handshake itself for anyone who can't
  // present one signed by it - never a soft, request-time check.
  requestCert: boolean;
  rejectUnauthorized: boolean;
  // A real, meaningful floor for an industrial gateway: TLS 1.0/1.1 (both
  // deprecated by every major standards body - IETF RFC 8996) are never
  // negotiated, regardless of what an old client offers. Not pinned to
  // TLS 1.3 only: 1.2 is still real, current, and widely required for
  // interoperability with older industrial equipment on the other side
  // of a real factory network.
  minVersion: "TLSv1.2";
}

// Reads and validates the real TLS environment configuration. Returns
// null (never a partial/guessed config) when neither TLS_CERT_PATH nor
// TLS_KEY_PATH is set - the caller's own signal to fall back to plain
// HTTP for a local-development or not-yet-hardened deployment. Throws a
// clear, specific error for every other invalid combination (only one of
// cert/key set; a path that doesn't exist or can't be read) rather than
// silently downgrading security.
export function resolveTlsConfig(env: NodeJS.ProcessEnv = process.env): TlsConfig | null {
  const certPath = env.TLS_CERT_PATH?.trim();
  const keyPath = env.TLS_KEY_PATH?.trim();
  const caPath = env.TLS_CLIENT_CA_PATH?.trim();

  if (!certPath && !keyPath) {
    if (caPath) {
      throw new Error("TLS_CLIENT_CA_PATH is set but TLS_CERT_PATH/TLS_KEY_PATH are not - mutual TLS needs a real server certificate first");
    }
    return null;
  }
  if (!certPath || !keyPath) {
    throw new Error("TLS_CERT_PATH and TLS_KEY_PATH must both be set to enable TLS - only one was provided");
  }

  const cert = readCertFile(certPath, "TLS_CERT_PATH");
  const key = readCertFile(keyPath, "TLS_KEY_PATH");

  if (!caPath) {
    return { cert, key, requestCert: false, rejectUnauthorized: false, minVersion: "TLSv1.2" };
  }
  const ca = readCertFile(caPath, "TLS_CLIENT_CA_PATH");
  return { cert, key, ca, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2" };
}

function readCertFile(path: string, envVarName: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read ${envVarName}=${path}: ${detail}`);
  }
}

// One human-readable line for the real startup banner - so an operator
// can see, at boot, exactly which of the three real modes is active
// (never silently defaulting).
export function describeTlsMode(config: TlsConfig | null): string {
  if (!config) return "plain HTTP (TLS_CERT_PATH/TLS_KEY_PATH not set)";
  return config.requestCert
    ? "mutual TLS (client certificates required)"
    : "TLS (server certificate only, no client certificate required)";
}
