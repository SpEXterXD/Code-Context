# Changelog

## Unreleased

### Added (M2: retrieval evaluation harness)

- Dev-time retrieval evaluation harness (`npm run eval:build-dataset`,
  `npm run eval:retrieval`; scripts under `scripts/eval/`, see
  docs/eval/README.md). It mines (task, gold-files) pairs from pinned
  public-repo histories (hono, zod, undici, axios, fastify; 200 tasks),
  materializes each task's **parent-commit** snapshot into a git-ignored
  scratch dir with git plumbing only (`read-tree` into a temporary
  `GIT_INDEX_FILE` → `update-index --force-remove` → `checkout-index -a`;
  no tar), runs the OCC pipeline headlessly through `OccApplication`
  (no vscode import), and scores file localization (Top-1, Recall@5/10,
  strict AllGold Acc@10, MRR) against the filename-overlap,
  BM25-over-contents, and seeded-random baselines with seeded 95% bootstrap
  CIs. Dataset and results are deterministic for a given commit
  (timings/environment are quarantined into separate sections; results.json
  records the OCC commit hash and that the working tree was clean at run
  start). Dataset builder filters, stream parsers, ls-tree mode parsing,
  mode-based gold filtering, metrics, and baselines are unit tested as pure
  functions; the dataset hash is verified before every run.
- The snapshot file universe is decided by `git ls-tree -r <parent>` modes on
  every platform: only regular files (100644/100755) are materialized and
  indexed; symlinks (120000) and gitlinks/submodules (160000) are excluded
  from the snapshot AND from gold, with `core.symlinks=false
  core.autocrlf=false core.eol=lf` forced so file bytes are identical across
  Windows/macOS/Linux. Gold dropped by mode is counted per repo (empty-gold
  tasks are excluded from the dataset and reported); a TS/JS gold file that
  would be dropped aborts the build instead of being silently absorbed.
  Baselines read file contents up to 1 MiB — OCC's own scanner limit — so
  all four systems rank the same file universe.
- `docs/eval/README.md` documents the methodology, metric conventions
  (citing SWE-bench, LocAgent, CommitBench, and the SWE-bench
  future-history-leak mitigation), dataset funnel statistics, and known
  limitations (commit message as a noisy task proxy, gold-set bias, filtered
  task slice). docs/eval/{dataset,results}.json are generated artifacts.
- Statistical addendum to the harness (analysis only; no retrieval/context/
  security changes): seeded **paired bootstrap** over per-task differences
  (OCC − BM25) for every metric, with "excludes 0" flags; per-metric 95%
  CIs for all systems in results.md; **source-only gold slice** (gold
  restricted to TS/JS/JSON/MD files the structured parsers fully parse)
  with every metric reported on both slices and per-slice gold/task counts;
  **package recall** (gold coverage of OCC's generated package, parsed from
  its `### FILE:` headings; Recall@8 equivalent for baselines); and an
  **all-gold gap analysis** listing, for tasks where BM25 placed all gold in
  its top 10 and OCC did not, each missing file's OCC candidate rank (or
  absence), BM25 rank, and file type.
- `--split tuning` runs the harness on the EARLIER half of the time split
  and writes `docs/eval/results-tuning.{json,md}` only, keeping tuning
  experiments strictly separate from the eval-half results. Default remains
  `--split eval`.
- `npm run eval:fsmonitor-repro` reproduces the untrusted-workspace
  `core.fsmonitor` risk on this machine: a repo-controlled config executes
  an arbitrary script on `git status` / `git diff --name-only` (NOT on OCC's
  exact `git log` invocation), and `-c core.fsmonitor=false` suppresses it.

### Fixed

- Search (`OCC: Search Codebase`) now follows the configured
  `maxGraphDepth` setting instead of a hardcoded 3 (F13), with a
  black-box activation-audit regression test that observes graph-reachable
  picks at depth 1 vs 3. Dead recorded-but-unused measured variables were
  also removed from `scripts/benchmark.ts`.
- `package.json` now declares its VS Code capability surface (F8):
  `untrustedWorkspaces.supported: true` (OCC only reads files; it never
  writes workspace files or executes workspace content) and
  `virtualWorkspaces.supported: false` (indexing requires direct local
  file system access).
- The final leak gate now checks every high-confidence finding regardless
  of match length (F10). Matches shorter than 8 characters were previously
  exempt from the fail-closed check, so a short high-confidence match could
  slip past it; the length floor now applies only to medium-confidence
  (entropy-heuristic) matches, keeping short strings from tripping the gate
  against arbitrary payload text. Covered by tests in both directions.
- JSON parsing no longer rescans the whole document per key (F9): a
  single pass builds the key→line index and the walk does O(1) lookups
  (previously O(keys × lines)). Line resolution behavior is unchanged.
- Docs and metadata hygiene (F2, F12): removed all dangling references to
  a non-existent IMPLEMENTATION_REPORT.md and "spec §" citations; replaced
  the undocumented performance claims with actual measured benchmark
  numbers (5,000-file index = 16.1 s on the audit machine: node v24.15.0,
  Windows_NT 10.0.26300, AMD Ryzen 7 4800H, 15 GB RAM; startup store
  load+rebuild = 5–6 s for ~5,000 entries). The extension is now MIT
  licensed (`license: MIT` + LICENSE file, "private" removed) and the
  README wire-format sketch now matches the actual output
  (`### LINES: 1-45` fenced blocks instead of `[ORIGINAL LINES 1-45]`).
- Test-count documentation updated to the new 18 suites / 183 tests;
  docs-sync verifies against a real vitest run.
- The watcher debounce no longer resets its timer on every incoming event
  (F6): a continuous save stream used to postpone indexing indefinitely
  because each event pushed the flush further out. The flush is now anchored
  to the first pending event, bounding indexing latency to one debounce
  window (600 ms); events arriving after a flush schedule the next batch.
  Covered by a new dedicated watcher suite (fake timers).
- The index manifest's `projectFingerprint` is now verified at load (F5).
  A manifest copied from a different workspace root (schema-valid, correct
  entry count) was previously accepted as-is; it is now rebuilt from the
  entries, which are the source of truth. Entries are untouched, so the
  index stays valid and the next run reconciles as usual.
- The retrieval candidate cap now scales with the configured `maxFiles`
  budget instead of a hardcoded 60 (F4). Previously `maxFiles` values above
  60 were unreachable in Task/File/Selection modes because the ranker
  truncated its candidate list before budgeting ever saw the tail.
- Secret findings are now ordered with the same code-point comparator used
  everywhere else (F3). The findings sort previously used
  `String.prototype.localeCompare`, whose collation is locale- and
  platform-dependent — a hidden cross-platform determinism leak that could
  reorder WHY reasons for files with multiple findings and therefore change
  payload bytes. A new test proves the payload is byte-identical under a
  hostile `localeCompare` replacement.
- Content-aware source-block fences (F1): the emitted ``` fence for each
  `## SOURCE` block is now longer than any backtick run inside the block's
  content (and language label), so repository content can never close a
  source block and masquerade as payload structure. Previously the fence
  length only depended on the language label.

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
