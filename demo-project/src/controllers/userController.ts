/**
 * User controller: HTTP handlers for the users endpoints.
 * The list endpoint supports pagination via page/pageSize query parameters.
 */
import type { Request, Response } from "./types";
import type { UserRepository, Page } from "../repositories/userRepository";
import type { User } from "../models/user";

export class UserController {
  constructor(private readonly users: UserRepository) {}

  /** GET /users: paginated user listing. */
  async listUsers(req: Request, res: Response): Promise<void> {
    const query = req.body as { page?: number; pageSize?: number };
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const pageResult: Page<User> = this.users.listUsers(page, pageSize);
    res.status(200).json({
      items: pageResult.items,
      pagination: { page: pageResult.page, pageSize: pageResult.pageSize, total: pageResult.total },
    });
  }
}
