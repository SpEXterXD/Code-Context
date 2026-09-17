/**
 * Validation helpers for user input.
 *
 * Signup validation: email format, password strength and profile completeness.
 */
export function validateEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

export function validatePassword(password: string): boolean {
  return password.length >= 8 && /[A-Z]/.test(password) && /[0-9]/.test(password);
}

export interface SignupInput {
  email: string;
  password: string;
  displayName: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Validates a signup request body before it reaches the auth service. */
export function validateSignup(input: SignupInput): ValidationResult {
  const errors: string[] = [];
  if (!validateEmail(input.email)) errors.push("invalid email");
  if (!validatePassword(input.password)) errors.push("weak password");
  if (!input.displayName || input.displayName.trim().length < 2) errors.push("display name too short");
  return { ok: errors.length === 0, errors };
}
