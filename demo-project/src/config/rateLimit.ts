/**
 * Rate limiting configuration.
 *
 * Rate limiting is applied per client IP using a sliding window. The login
 * endpoint should use the strictest limits because it is the primary
 * credential-guessing target.
 */
export interface RateLimitConfig {
  /** Requests allowed per window. */
  maxRequests: number;
  /** Sliding window length in seconds. */
  windowSeconds: number;
  enabled: boolean;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 100,
  windowSeconds: 60,
  enabled: true,
};

/** Stricter limits intended for credential endpoints such as login. */
export const LOGIN_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 5,
  windowSeconds: 300,
  enabled: true,
};

export function resolveRateLimit(section: "global" | "login"): RateLimitConfig {
  return section === "login" ? LOGIN_RATE_LIMIT : DEFAULT_RATE_LIMIT;
}
