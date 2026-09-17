/** Payment routes: /payments endpoints. */
import { PaymentController } from "../controllers/paymentController";
import { authenticateMiddleware } from "../middleware/auth";
import type { AuthService } from "../services/authService";
import type { PaymentService } from "../services/paymentService";
import type { RouteRegistry } from "./authRoutes";

export function registerPaymentRoutes(
  router: RouteRegistry,
  auth: AuthService,
  payments: PaymentService
): void {
  const controller = new PaymentController(payments);

  // POST /payments: payment processing entry point.
  router.post("/payments", authenticateMiddleware(auth), async (req, res) => controller.create(req, res));
}
