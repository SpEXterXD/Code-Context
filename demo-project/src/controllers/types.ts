/** Shared minimal HTTP handler types (stand-in for express types). */
export interface Request {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  ip?: string;
}

export interface Response {
  status(code: number): Response;
  json(payload: unknown): void;
}
