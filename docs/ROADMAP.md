# Roadmap

Planned work, with scope exactly as designed. Nothing below is shipped in
the current release; shipped retrieval/packaging work is described in
[docs/eval/README.md](eval/README.md) and the CHANGELOG.

## Change-aware context — Planned (not shipped)

Seeds from the developer's current state, fed into retrieval as pinned
candidates and scoring signals:

- Working-tree changes: uncommitted and staged files (status/diff via the
  hardened `safeGit` helper), including renames, deletions, untracked and
  binary files; a bounded `CURRENT CHANGES` wire section that passes through
  the same secret scanner and redaction as source files and counts against
  the token budget.
- Editor state, supplied by the extension layer through a typed, vscode-free
  `SeedSet` interface: open editor tabs, the active file, the selection and
  its containing symbol, and diagnostics for seeded files.
- Stack-trace / error-text parsing (pure function; Node, Python, Java, Go
  and TypeScript formats) mapped to workspace files.
- New signals (`DIFF_TOUCHED`, `OPEN_EDITOR`, `DIAGNOSTIC`, `STACK_FRAME`)
  with named, ablatable weights and WHY reasons, integrated with
  rank-priority packaging and the budget; every failure mode (no repo,
  detached HEAD, untrusted workspace, git timeout, huge diff) degrades to
  unseeded behavior with a visible note.

## Wire format v2 — Planned (not shipped)

- The developer task repeated at the start and the end of the payload.
- An `OMITTED BUT RELEVANT` section (ranked files that did not fit, with
  their reasons).
- A repository-conventions section (agent instructions, test framework,
  run commands).
- Symbol-level slicing: matched symbol bodies first, callee signatures and
  used types next, so more distinct relevant files fit in the same budget.

## More languages — Planned (not shipped)

Tree-sitter (WASM) structured parsing starting with **Python** and **Go**,
then more languages. Today non-TS/JS/JSON/MD files get metadata-only
indexing (size, lines, hash) — see `docs/LIMITATIONS.md`.

## Headless CLI and MCP server — Planned (not shipped)

A CLI and a stdio MCP server wrapping the same engine core, still 100%
offline and byte-identical to the extension output for the same inputs.

---

Roadmap items are plans, not commitments.
