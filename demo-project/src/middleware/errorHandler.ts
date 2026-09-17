/** Error handling middleware: converts thrown errors into JSON responses. */
import type { Request, Response } from "../controllers/types";
import { createLogger } from "../utils/logger";

export function errorHandlerMiddleware(): (err: unknown, req: Request, res: Response, next: () => void) => void {
  const logger = createLogger();
  return (err, _req, res, _next) => {
    const message = err instanceof Error ? err.message : "internal error";
    logger.error(`request failed: ${message}`);
    res.status(500).json({ error: message });
  };
}
