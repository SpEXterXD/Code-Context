/**
 * Auth middleware: authenticates requests via bearer token.
 * Rejects unauthenticated requests before they reach protected handlers.
 */
import type { Request, Response } from "../controllers/types";
import type { AuthService } from "../services/authService";

export function authenticateMiddleware(auth: AuthService): (req: Request, res: Response, next: () => void) => void {
  return (req, res, next) => {
    const header = req.headers["authorization"] ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!auth.verifyToken(token)) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    next();
  };
}
