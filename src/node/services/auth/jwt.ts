/**
 * JWT service for server authentication.
 *
 * Uses HMAC-SHA256 for JWT signing. The JWT format is:
 * base64url(header).base64url(payload).base64url(signature)
 *
 * The signature is HMAC-SHA256 of "header.payload" using the secret key.
 */

import * as crypto from "crypto";
import type { JwtClaim, JwtProvider } from "./types";

const ALGORITHM_HEADER = "mux-hs256";
const HMAC_ALGORITHM = "sha256";

interface JwtHeader {
  alg: string;
  typ: string;
}

const JWT_SECRET_ENV = process.env.JWT_SECRET ?? process.env.SESSION_SECRET;

function getJwtSecret(): Buffer {
  if (JWT_SECRET_ENV && JWT_SECRET_ENV.length >= 32) {
    return crypto.scryptSync(JWT_SECRET_ENV, "mux-jwt-salt", 32);
  }
  // Derive a consistent key from a fixed secret for development
  return crypto.scryptSync("mux-dev-jwt-secret-do-not-use-in-production", "mux-jwt-salt-v1", 32);
}

function base64UrlEncode(data: Buffer | string): string {
  return data.toString("base64url");
}

function base64UrlDecode(str: string): Buffer | null {
  try {
    return Buffer.from(str, "base64url");
  } catch {
    return null;
  }
}

function hmacSign(input: string, secret: Buffer): Buffer {
  return crypto.createHmac(HMAC_ALGORITHM, secret).update(input).digest();
}

/**
 * Encode a payload into a JWT-like format (header.payload.signature) using HMAC-SHA256.
 */
function encodeToken(payload: JwtClaim, secret: Buffer): string {
  const header: JwtHeader = { alg: ALGORITHM_HEADER, typ: "JWT" };
  const headerJson = JSON.stringify(header);
  const payloadJson = JSON.stringify(payload);
  const headerB64 = base64UrlEncode(Buffer.from(headerJson, "utf-8"));
  const payloadB64 = base64UrlEncode(Buffer.from(payloadJson, "utf-8"));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = hmacSign(signingInput, secret);
  const signatureB64 = base64UrlEncode(signature);
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/**
 * Decode and verify a JWT-like token (header.payload.signature) using HMAC-SHA256.
 */
function decodeToken(token: string, secret: Buffer): JwtClaim | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  // Verify signature first
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSignature = hmacSign(signingInput, secret);
  const actualSignatureBytes = base64UrlDecode(signatureB64);
  if (!actualSignatureBytes) {
    return null;
  }

  // Constant-time comparison to prevent timing attacks
  if (
    expectedSignature.length !== actualSignatureBytes.length ||
    !crypto.timingSafeEqual(expectedSignature, actualSignatureBytes)
  ) {
    return null;
  }

  // Verify header algorithm
  const headerBytes = base64UrlDecode(headerB64);
  if (!headerBytes) {
    return null;
  }
  try {
    const header = JSON.parse(headerBytes.toString("utf-8")) as JwtHeader;
    if (header.alg !== ALGORITHM_HEADER || header.typ !== "JWT") {
      return null;
    }
  } catch {
    return null;
  }

  // Decode the payload
  const payloadBytes = base64UrlDecode(payloadB64);
  if (!payloadBytes) {
    return null;
  }

  try {
    const payload = JSON.parse(payloadBytes.toString("utf-8")) as Record<string, unknown>;
    const exp = payload.exp;
    const sub = payload.sub;

    if (typeof exp !== "number" || typeof sub !== "string" || !sub) {
      return null;
    }

    // Verify expiration
    const now = Math.floor(Date.now() / 1000);
    if (exp < now) {
      return null; // Token expired
    }

    return { exp, sub };
  } catch {
    return null;
  }
}

/**
 * JwtService provides JWT creation and verification for server auth.
 * Uses HMAC-SHA256 with a symmetric secret from environment variables.
 */
export class JwtService implements JwtProvider {
  private readonly secret: Buffer;

  constructor() {
    this.secret = getJwtSecret();
  }

  createToken(sessionId: string, expiresInSeconds: number): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: JwtClaim = {
      exp: now + expiresInSeconds,
      sub: sessionId,
    };
    return encodeToken(claims, this.secret);
  }

  verifyToken(token: string): JwtClaim | null {
    return decodeToken(token, this.secret);
  }
}

/** Singleton instance for use across the application. */
let jwtServiceInstance: JwtService | null = null;

export function getJwtService(): JwtService {
  return (jwtServiceInstance ??= new JwtService());
}

export type { JwtProvider } from "./types";
