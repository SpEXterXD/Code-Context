/** Auth tests: covers the login and signup flows end to end. */
import { describe, expect, it } from "@jest/globals";
import { AuthService, hashPassword } from "../src/services/authService";
import { UserRepository } from "../src/repositories/userRepository";
import { validateSignup, validatePassword } from "../src/utils/validators";

describe("authentication", () => {
  it("login succeeds with correct credentials", async () => {
    const users = new UserRepository();
    const auth = new AuthService(users);
    const created = await auth.signup({ email: "dev@example.com", password: "Sup3rSecret", displayName: "Dev" });
    expect(created.ok).toBe(true);
    const user = await auth.login("dev@example.com", "Sup3rSecret");
    expect(user).not.toBe(null);
  });

  it("login rejects a bad password", async () => {
    const users = new UserRepository();
    const auth = new AuthService(users);
    await auth.signup({ email: "dev@example.com", password: "Sup3rSecret", displayName: "Dev" });
    const user = await auth.login("dev@example.com", "wrong");
    expect(user).toBe(null);
  });

  it("signup validation rejects weak passwords", () => {
    expect(validatePassword("short")).toBe(false);
    const result = validateSignup({ email: "nope", password: "short", displayName: "" });
    expect(result.ok).toBe(false);
  });

  it("hashPassword is deterministic", () => {
    expect(hashPassword("same")).toBe(hashPassword("same"));
  });
});
