/**
 * Outbound transmission policy.
 *
 * This module is the codified guarantee that the extension makes NO network
 * calls anywhere in its pipeline. There is no HTTP client, fetch wrapper, or
 * telemetry sink anywhere in `src/`; the only data egress is the user
 * explicitly invoking "Copy Context" (VS Code clipboard API) and manually
 * pasting the result elsewhere. See SECURITY.md for the full trust boundary:
 * after the user copies, whatever they do with the text is outside this
 * program's control; the extension cannot and does not claim otherwise.
 */
export const OUTBOUND_POLICY_STATEMENT =
  "No network transmission by design. The pipeline (indexing, analysis, " +
  "retrieval, context generation, preview) performs zero network I/O. The " +
  "single egress point is the user-triggered clipboard copy, followed by a " +
  "manual paste performed by the user.";

/** Audit helper (used by tests + self-review): all Node modules the codebase may import. */
export const FORBIDDEN_NODE_MODULES = [
  "http",
  "https",
  "http2",
  "net",
  "dgram",
  "tls",
  "dns",
  "undici",
  "axios",
  "node-fetch",
  "got",
  "request",
  "ws",
  "grpc",
] as const;
