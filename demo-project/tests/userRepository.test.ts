/** User repository tests: pagination behavior of listUsers. */
import { describe, expect, it } from "@jest/globals";
import { UserRepository } from "../src/repositories/userRepository";

describe("user repository pagination", () => {
  it("listUsers returns a stable page", () => {
    const users = new UserRepository();
    const page = users.listUsers(1, 20);
    expect(page.items).toHaveLength(0);
    expect(page.page).toBe(1);
    expect(page.total).toBe(0);
  });
});
