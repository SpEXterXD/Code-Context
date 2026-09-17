/** Validator unit tests (signup validation rules). */
import { describe, expect, it } from "@jest/globals";
import { validateEmail, validatePassword, validateSignup } from "../src/utils/validators";

describe("signup validation", () => {
  it("accepts a valid signup input", () => {
    const result = validateSignup({ email: "a@b.co", password: "Sup3rSecret", displayName: "Ann" });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid emails", () => {
    expect(validateEmail("not-an-email")).toBe(false);
  });

  it("rejects weak passwords", () => {
    expect(validatePassword("alllowercase1")).toBe(false);
  });
});
