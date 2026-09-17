/**
 * Auth controller: HTTP handlers for the authentication endpoints (login, signup).
 * Delegates all credential logic to the AuthService.
 */
import type { Request, Response } from "./types";
import { AuthService } from "../services/authService";
import { sendEmail } from "../services/emailService";

export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** POST /auth/login: the login endpoint protected by rate limiting. */
  async login(req: Request, res: Response): Promise<void> {
    const { email, password } = req.body as { email: string; password: string };
    const user = await this.auth.login(email, password);
    if (user === null) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    res.status(200).json({ token: `signed:${user.id}` });
  }

  /** POST /auth/signup: creates an account and sends a welcome email. */
  async signup(req: Request, res: Response): Promise<void> {
    const result = await this.auth.signup(req.body as Parameters<AuthService["signup"]>[0]);
    if (!result.ok) {
      res.status(400).json({ errors: result.errors ?? [] });
      return;
    }
    void sendEmail(result.user!.email, "welcome to taskflow");
    res.status(201).json({ user: result.user });
  }
}
