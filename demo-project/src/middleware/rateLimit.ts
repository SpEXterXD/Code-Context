/**
 * Rate limiting middleware.
 *
 * Applies a per-client-IP sliding window. Factories are configured per route
 * group using the limits from config/rateLimit. Attach rateLimitMiddleware to
 * credential endpoints (login/signup) for the strictest policy.
 */
import type { Request, Response } from "../controllers/types";
import { resolveRateLimit, type RateLimitConfig } from "../config/rateLimit";
import { createLogger } from "../utils/logger";

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimitMiddleware(config: RateLimitConfig): (req: Request, res: Response, next: () => void) => void {
  const logger = createLogger();
  return (req, res, next) => {
    if (!config.enabled) {
      next();
      return;
    }
    const key = req.ip ?? "unknown";
    const nowSeconds = Math.floor(Date.now() / 1000);
    const bucket = buckets.get(key);
    if (!bucket || nowSeconds - bucket.windowStart >= config.windowSeconds) {
      buckets.set(key, { count: 1, windowStart: nowSeconds });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > config.maxRequests) {
      logger.warn(`rate limiting: request rejected for ${key}`);
      res.status(429).json({ error: "too many requests" });
      return;
    }
    next();
  };
}

export const loginRateLimiter = rateLimitMiddleware(resolveRateLimit("login"));
