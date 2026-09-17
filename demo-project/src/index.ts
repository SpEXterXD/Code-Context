/**
 * Application bootstrap: wires repositories, services, controllers, routes
 * and middleware together.
 */
import { loadAppConfig } from "./config/env";
import { createConnection } from "./db/connection";
import { AuthService } from "./services/authService";
import { PaymentService } from "./services/paymentService";
import { UserRepository } from "./repositories/userRepository";
import { PaymentRepository } from "./repositories/paymentRepository";
import { registerAuthRoutes, type RouteRegistry } from "./routes/authRoutes";
import { registerUsersRoutes } from "./routes/users.routes";
import { registerPaymentRoutes } from "./routes/paymentRoutes";
import { loginRateLimiter } from "./middleware/rateLimit";
import { errorHandlerMiddleware } from "./middleware/errorHandler";
import { createLogger } from "./utils/logger";

const logger = createLogger();

export function bootstrap(): void {
  const config = loadAppConfig();
  createConnection({ host: "localhost", database: "taskflow", poolSize: 10 });

  const users = new UserRepository();
  const payments = new PaymentRepository();
  const auth = new AuthService(users);
  const paymentService = new PaymentService(payments);

  const router: RouteRegistry = {
    post: (path, ...handlers) => logger.info(`route POST ${path} (${handlers.length} handlers)`),
    get: (path, ...handlers) => logger.info(`route GET ${path} (${handlers.length} handlers)`),
  };

  registerAuthRoutes(router, auth);
  registerUsersRoutes(router, auth, users);
  registerPaymentRoutes(router, auth, paymentService);

  void loginRateLimiter;
  void errorHandlerMiddleware;
  logger.info(`bootstrap complete on port ${config.port}`);
}

bootstrap();
