/**
 * Authentication types for JWT-based server auth.
 */

/** Standard JWT claims structure used by Mux server auth. */
export interface JwtClaim {
  /** Expiration time as Unix timestamp in seconds. */
  exp: number;
  /** Subject - session ID for this auth session. */
  sub: string;
}

/** Options passed when validating a session token. */
export interface ValidateSessionTokenOptions {
  userAgent?: string;
  ipAddress?: string;
}

/** Public view of an auth session for listing purposes. */
export interface ServerAuthSessionView {
  id: string;
  label: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  isCurrent: boolean;
}

/** Result of validating a session token. */
export interface SessionTokenValidation {
  sessionId: string;
}

/** Interface for JWT operations - implemented by JwtService. */
export interface JwtProvider {
  /**
   * Create a new JWT for a session.
   * @param sessionId - Unique session identifier (becomes the `sub` claim)
   * @param expiresInSeconds - Token validity duration
   * @returns Signed JWT string
   */
  createToken(sessionId: string, expiresInSeconds: number): string;

  /**
   * Verify and decode a JWT.
   * @param token - JWT string to verify
   * @returns Decoded claims if valid, null if invalid/expired
   */
  verifyToken(token: string): JwtClaim | null;
}
