# ADR-007: Clipboard Export & Byte-Exact Preview

Date: 2026-09-11 · Status: Accepted

## Context

The user must be able to see exactly what will be pasted into the external
LLM before copying. The preview must not be a "rendering" of the payload
that can drift from it.

## Decision

- `ClipboardExporter` is a domain interface; the only implementation in the
  extension calls `vscode.env.clipboard.writeText`. Tests use an in-memory
  mock; no OS clipboard access in unit tests, ever.
- **Preview = the payload itself.** A `TextDocumentContentProvider` serves the
  exact string produced by the context builder; the Copy command writes that
  same in-memory string (it never regenerates). Preview and clipboard are
  byte-identical by construction.
- Generation happens only on explicit Generate commands (never on a timer or
  on file changes); copying happens only on the explicit Copy command. This
  is the single egress point of the product.
- A failed clipboard write surfaces an error message and leaves no partial
  state (the last generated payload remains previewable).

## Alternatives

- A Webview preview: requires escaping untrusted repo content for HTML,
  adds CSP complexity, and invites drift between preview and payload.
  A plain text document is byte-exact for free.

## Trade-offs

- The text-document preview is plain text (no syntax highlighting of the
  embedded code fences), accepted in exchange for the byte-exact guarantee.
