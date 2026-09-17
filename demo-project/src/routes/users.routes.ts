/** Users routes: paginated user listing under /users. */
import { UserController } from "../controllers/userController";
import { authenticateMiddleware } from "../middleware/auth";
import type { AuthService } from "../services/authService";
import type { UserRepository } from "../repositories/userRepository";
import type { RouteRegistry } from "./authRoutes";

export function registerUsersRoutes(
  router: RouteRegistry,
  auth: AuthService,
  users: UserRepository
): void {
  const controller = new UserController(users);

  // GET /users: users endpoint with pagination support.
  router.get("/users", authenticateMiddleware(auth), async (req, res) => controller.listUsers(req, res));
}
