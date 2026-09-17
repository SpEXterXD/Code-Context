# ADR-005: Context Budgeting & Truncation

Date: 2026-09-11 · Status: Accepted

## Context

The generated package must never exceed configured limits (files, chars,
lines, estimated tokens, graph depth, lines per file), yet should degrade
gracefully instead of dropping whole files abruptly.

## Decision

- A `BudgetLedger` accounts files, chars, lines, and tokens. Every limit is
  enforced, never silently exceeded (verified against the rendered payload
  on fixtures larger than the budget).
- Selection priority (explicit, in code, in this order):
  USER_SELECTED → EXACT_SYMBOL → DIRECT_DEPENDENCY → DIRECT_DEPENDENT →
  RELEVANT_TESTS → STRONG_LEXICAL → ARCHITECTURAL → LOWER_CONFIDENCE.
  Within a tier: score desc, then path asc. User-pinned files always appear.
- Per-file truncation ladder, applied in budget order: FULL (up to
  maxCodeLinesPerFile), SYMBOLS (ranges of defined symbols), SIGNATURES
  (signatures plus locations), METADATA (listed with reasons, no source).
  The chosen level is recorded per file and reported in CONTEXT METADATA.
- Static sections (structure tree, architecture, why-selected) are reserved
  in the ledger up front. A deterministic degrade loop demotes the
  lowest-priority included file whenever the exact rendered payload still
  exceeds a budget, so the guarantee holds against rendered bytes, not
  estimates.
- Token counts use the chars/4 estimate and are labeled as estimates
  everywhere they appear.

## Alternatives

- Hard character cropping of files: destroys syntax and line-number
  integrity. Rejected.
- Dropping whole files when the budget is tight: throws away cheap,
  high-value metadata. The ladder keeps a path and reason trail instead.

## Consequences

- Output may include metadata-only entries for files that did not fit. This
  is intentional: the LLM sees that the files exist and why they were
  considered.
