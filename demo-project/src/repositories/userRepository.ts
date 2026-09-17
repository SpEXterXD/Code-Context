/**
 * User repository: persistence for user accounts.
 *
 * Supports lookup by email, creation and page-based listing used by the
 * users endpoint for pagination.
 */
import { createLogger } from "../utils/logger";
import type { User, UserRecord } from "../models/user";

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export class UserRepository {
  private readonly users = new Map<string, UserRecord>();
  private readonly logger = createLogger();

  findByEmail(email: string): UserRecord | undefined {
    for (const record of this.users.values()) {
      if (record.email === email) return record;
    }
    return undefined;
  }

  create(record: UserRecord): User {
    this.users.set(record.id, record);
    this.logger.info(`user created: ${record.id}`);
    return { ...record };
  }

  count(): number {
    return this.users.size;
  }

  /** Returns one page of users ordered by creation time. */
  listUsers(page: number, pageSize: number): Page<User> {
    const all = [...this.users.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const start = (page - 1) * pageSize;
    return {
      items: all.slice(start, start + pageSize).map(({ passwordHash: _h, ...rest }) => rest),
      page,
      pageSize,
      total: all.length,
    };
  }
}
