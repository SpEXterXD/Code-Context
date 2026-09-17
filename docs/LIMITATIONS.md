# Limitations

Honest, current as of v0.3.0.

## Analysis depth

- **Static analysis ≠ full semantics.** We extract what the TypeScript
  compiler and light parsers can see. Type inference across generics,
  runtime reflection, monkey-patching, and metaprogramming are not modeled.
- **Dynamic imports and reflection**: `import(variable)` is recorded as
  UNRESOLVED; by design we never fabricate a destination. Specifiers built
  at runtime, `require` with computed strings, and DI containers produce
  incomplete graphs.
- **Call graph is name-based within resolved scopes**: a call resolves
  STATIC_EXACT when the callee is a local symbol or a verified import;
  otherwise a *unique* global exported-name match is STATIC_HEURISTIC;
  anything else is unmodeled. Overloads, `apply/call`, and duck typing are
  not tracked.
- **Test relationships are a naming-convention heuristic**
  (`<name>.test.<ext>`), explicitly labeled STATIC_HEURISTIC and never claimed
  as complete.
- **Non-TS/JS/JSON/MD languages** get metadata only (size, lines, hash). No
  symbols, no imports, no deep claims.
- **Nested `.gitignore` handling** treats patterns as root-relative and
  supports a documented subset of gitignore syntax; parent-directory
  exclusion wins over later negation (documented deviation).

## Retrieval

- **No semantic understanding.** Ranking is lexical + structural. Queries
  whose vocabulary differs from the code's (pure synonyms, cross-language
  concepts) may miss; explanations show exactly which signals fired so a
  miss is diagnosable.
- **Ranking weights are empirical** (documented in ADR-004). The eval suite
  reports actual numbers; behavior may change if you change weights.
- **Prefix matching** (≥4 chars) can surface files sharing a prefix with a
  query term (e.g. "user" ~ "username"); the coordination factor and idf
  scaling mitigate but do not eliminate this.

## Context output

- **Token counts are estimates** (~chars/4), labeled as such everywhere. They
  vary by model tokenizer, sometimes by 20 percent or more.
- **Truncation degrades by design** (full → symbols → signatures →
  metadata). A metadata-only entry means "considered, did not fit"; the
  budget, not importance, excluded it.
- The PROJECT STRUCTURE tree and directory summary are depth/entry-capped.

## Security

- **Secret detection is heuristic.** Patterns + entropy catch common
  formats; novel encodings, short/low-entropy secrets, and split secrets can
  pass. Review the preview before pasting; that is its purpose. We do not
  claim detection completeness.
- **The `.gitignore` subset** may mis-handle exotic patterns.

## Platform

- Windows rename-over-existing is retried and falls back to a verified
  in-place write; under pathological antivirus interference an index write
  could theoretically fail; the error surfaces (STORE_CORRUPT / IO), and
  the next run reconciles.
- Benchmarks are reported for the machine that ran them (see
  IMPLEMENTATION_REPORT.md); your numbers will differ.

## Explicitly out of scope (v1)

- Reading file *contents* into the index (only hashes/paths/symbols are
  persisted), multi-root workspaces, remote/WSRP workspaces, and any form of
  network/telemetry.
