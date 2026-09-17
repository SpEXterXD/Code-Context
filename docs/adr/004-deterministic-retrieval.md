# ADR-004: Deterministic Retrieval & Ranking

Date: 2026-09-11 · Status: Accepted

## Context

Given a task/query, the tool selects files with a score that must be
explainable, reproducible, and free of any ML component.

## Decision

A hybrid, fully deterministic scorer. All weights live in one place
(`src/retrieval/relevanceScorer.ts`) and are mirrored in ARCHITECTURE.md.

```
score = 1.0 · exactSymbol        (× kind weight × term specificity)
      + 0.8 · fileName           (exact base name, 0.5× for prefix match)
      + 0.9 · lexical            (tf-idf over weighted fields, normalized)
      + ≤1.0 · structural        (sum, capped, see below)
      + 0.15 · recency           (optional, git, off by default)
```

Signals and their provenance:

- EXACT_SYMBOL: canonical identifier match (camelCase/snake_case/
  kebab-case treated as related) against API-level symbols. Weighted by kind
  (function/method 1.0, class 0.9, enum 0.7, interface/type 0.4) and by term
  specificity (idf/ln(1+N)): an exact hit on a rare term beats one on
  "user". Local variables and fields are excluded.
- LEXICAL: tf-idf over fields symbol(3.0) > path(2.0) = imports/exports
  names(2.0) > summary(1.2) > identifiers(0.8), with sublinear tf (1+ln tf),
  a prefix-match rule (four or more characters, 0.7 weight; "authentication"
  matches "auth"), and a coordination factor (0.6 + 0.4 x coverage): files
  matching more distinct query terms outrank files repeating one term.
- Structural: bidirectional depth-limited graph expansion around
  content-based seeds. Dependency 0.6, dependent 0.5, call edge 0.5, test 0.7,
  inheritance 0.6, same-directory 0.2. The per-file structural total is
  capped at 1.0 so hubs cannot outrank strong content matches, and seeds use
  content scores only so hubs do not amplify themselves.
- RECENCY: optional git log recency rank (read-only, local, off by default).

Every fired signal is recorded; explanation strings are derived *only* from
fired signals and are verified by tests to reference real symbols/edges.

## Alternatives

- Embeddings and semantic search: rejected (ADR-001). Non-deterministic,
  model-dependent, and contrary to the privacy promise.
- Plain tf-idf without structure measured poorly on "where is X handled"
  queries: test files and hubs drowned the core files.

## Trade-offs

- Weight choices are empirical. They are frozen here and in tests so that
  changes are deliberate. The evaluation suite reports actual numbers rather
  than tuned ones (see TESTING.md).
