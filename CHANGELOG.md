# Changelog

## Unreleased

### Added

- `scripts/check-docs-sync.ts` verifies the suite/test counts published in
  README.md and docs/TESTING.md against a real `vitest run`; CI fails on
  drift.
- The layered-architecture dependency rule (docs/ARCHITECTURE.md) is now
  machine-enforced with `eslint-plugin-boundaries`: cross-layer imports
  outside the documented allow list fail lint, and `vscode` imports outside
  `src/extension/` fail via `no-restricted-imports`.

### Fixed

- The `maxFiles` budget is now actually enforced. Previously the setting was
  validated and displayed but never incremented, so context packages could
  include more files than configured (the retrieval candidate limit was the
  only effective cap). The file count is now committed to the budget ledger
  when a file enters the package, the FULL→SYMBOLS→SIGNATURES ladder is
  short-circuited for files beyond the cap, and metadata-only WHY entries
  name the binding budget (`file budget reached (maxFiles=N)`) instead of a
  generic note. Packages for large repositories may now include fewer files
  than before; that is the configured cap working as documented.

## 0.2.0 (first public release, 2026-09-12)

Full feature set of the initial push.

### Added

- Local indexing pipeline: workspace discovery with `.gitignore` support and
  configurable exclusions, SHA-256 content hashing, binary and oversized
  file detection, incremental re-analysis gated on content hash, and a
  crash-safe sharded JSON index store with atomic per-entry commits
  (ADR-002, ADR-008).
- Parsing and analysis: TypeScript/JavaScript via the TypeScript Compiler
  API, purpose-built JSON and Markdown parsers, metadata-only fallback for
  other file types (ADR-003). Import resolution for relative paths,
  `/index` files, `.js` to `.ts` mapping, and tsconfig `paths` aliases.
  Relationship graph with imports, references, calls, inheritance, and
  naming-convention test edges, each carrying provenance
  (`STATIC_EXACT`, `STATIC_HEURISTIC`, `UNRESOLVED`).
- Deterministic hybrid retrieval: exact symbol matching, file-name and
  tf-idf lexical scoring, depth-limited dependency-graph expansion, optional
  local git recency, and per-file explanations derived from fired signals
  (ADR-004).
- Context generation in four modes (Project, File, Task, Selection) with
  explicit selection tiers, hard budgets (files, chars, lines, estimated
  tokens, graph depth), and a full-to-symbols-to-signatures-to-metadata
  truncation ladder (ADR-005). Versioned output format with original line
  numbers.
- Security screening: sensitive-path rules, pattern and entropy secret
  scanning, BLOCK/WARN/ALLOW policy with deterministic non-reversible
  redaction, and a fail-closed leak gate before preview and copy
  (ADR-006).
- Clipboard export with byte-exact preview: the preview document shows the
  exact string that Copy writes (ADR-007).
- Right-click context-menu entry points: Explorer folder commands
  (Generate/Copy Project Context scoped to the folder subtree) and
  editor/editor-tab commands (Generate/Copy File Context seeded from that
  file). Copy variants skip the preview and confirm with a toast that
  includes file, line, and token counts plus security notices.
- Fifteen commands total, a live Index Status view, and a status bar item.
- 17 Vitest suites with 169 tests covering the domain headless, including a
  retrieval evaluation set, security fixtures, and seeded property tests
  (see docs/TESTING.md).

### Fixed

- File-mode seed queries no longer include the file-extension fragment
  (`"ts"`), which previously diluted retrieval toward all TypeScript files.
- Startup cancellation during background indexing is now reported as
  cancellation instead of an index error.

### Known limitations

See docs/LIMITATIONS.md and docs/SECURITY.md (secret detection is
heuristic; the preview is the final check before pasting).
