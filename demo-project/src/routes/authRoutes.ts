/**
 * Authentication routes: /auth/login and /auth/signup.
 *
 * The login endpoint currently runs WITHOUT rate limiting: adding
 * rateLimitMiddleware here is the recommended hardening step.
 */
import { AuthController } from "../controllers/authController";
import { authenticateMiddleware } from "../middleware/auth";
import type { AuthService } from "../services/authService";

export function registerAuthRoutes(
  router: RouteRegistry,
  auth: AuthService
): void {
  const controller = new AuthController(auth);

  // POST /auth/login: login endpoint (candidate for strict rate limiting).
  router.post("/auth/login", async (req, res) => controller.login(req, res));

  // POST /auth/signup: account creation.
  router.post("/auth/signup", async (req, res) => controller.signup(req, res));

  // GET /auth/me: returns the authenticated user profile.
  router.get("/auth/me", authenticateMiddleware(auth), async (req, res) => {
    res.status(200).json({ path: req.path });
  });
}

export interface RouteRegistry {
  post(path: string, ...handlers: Handler[]): void;
  get(path: string, ...handlers: Handler[]): void;
}

export type Handler = (req: never, res: never) => Promise<void> | void;
