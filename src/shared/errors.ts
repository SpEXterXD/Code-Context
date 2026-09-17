/**
 * Domain-specific error types. All errors carry a stable `code` so callers can
 * branch on failure kinds without string matching.
 */

export type ErrorCode =
  | "CANCELLED"
  | "STORE_CORRUPT"
  | "STORE_IO"
  | "PARSE_FAILED"
  | "BUDGET_INVALID"
  | "SECURITY_BLOCKED"
  | "NOT_INDEXED"
  | "INVALID_STATE"
  | "CLIPBOARD_FAILED";

export class OccError extends Error {
  readonly code: ErrorCode;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "OccError";
    this.code = code;
    this.cause = cause;
  }

  static is(error: unknown, code: ErrorCode): boolean {
    return error instanceof OccError && error.code === code;
  }
}

export class CancelledError extends OccError {
  constructor() {
    super("CANCELLED", "Operation was cancelled");
    this.name = "CancelledError";
  }
}

/** Thrown when the local index store cannot be read/parsed; callers may recover by rebuilding. */
export class StoreCorruptError extends OccError {
  constructor(detail: string, cause?: unknown) {
    super("STORE_CORRUPT", `Local index store is unreadable: ${detail}`, cause);
    this.name = "StoreCorruptError";
  }
}
