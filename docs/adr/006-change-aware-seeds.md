# ADR 006: Change-aware seeds (M4) — DESIGN, NOT IMPLEMENTED

Status: design approved for implementation planning; no source code exists
for this yet. Shipped retrieval behavior is unchanged.

## Goal

Feed OCC the developer's _current_ state — what is already changing, what is
open, what is selected, what is broken — as retrieval seeds and a wire
section, so the context package leads with the files the user is actually
working on. This is the milestone the M2 audit ranked as the highest
context-quality gain for a local tool.

## Seed scope

### a) Working-tree changes (extension layer, trust-gated)

Collected exclusively through `src/git/safeGit.ts` (offline, hardening
flags, async, timeout):

- `status --porcelain=v1 -z` — the authoritative map: staged/unstaged/
  untracked, renames (`R  new\0old\0`), deletions, and untracked files.
- `diff --name-only` and `diff --cached --name-only` — used to distinguish
  staged vs unstaged edits (the status codes already encode this; the diffs
  are the cross-check).

Handling rules: untracked files are seeds (they exist on disk); deleted
paths are seeds for _retrieval only_ (never read); renames seed both paths;
binary files (NUL sniff, same rule as the scanner) are path-only seeds;
diff content extraction skips files above `maxFileSizeBytes`; submodule
paths (gitlink entries in status) are path-only seeds; CRLF is irrelevant
to path seeds and content passes through unchanged (deterministic bytes);
a diff larger than the `CURRENT CHANGES` budget is truncated per-file
round-robin (deterministic order) with a truncation note. **Gated on
`vscode.workspace.isTrusted`** exactly like recency: untrusted workspaces
skip git entirely.

### b) Diff content as a `## CURRENT CHANGES` section

- Bounded: a dedicated budget slice (setting `currentChangesMaxTokens`,
  default ≈1500 tokens, counted in the SAME ledger — it competes with file
  content, never exceeds `maxTokens`).
- Hunks ordered deterministically: by path, then hunk start line; unified
  diff format via `git diff` (safeGit, no pager); the diff text is passed
  through the SAME secret scanner + redaction as source files (diffs
  routinely contain secrets), and the final payload goes through the
  existing fail-closed leak gate — no new security code paths.
- Rendered inside the existing content-aware fence (M1/F1) so diff content
  cannot forge structure.

### c) Editor state (typed `SeedSet`, domain stays vscode-free)

The extension layer builds a plain-data `SeedSet` and hands it to the
domain; the domain never imports vscode:

```ts
interface SeedSet {
  changedPaths: { path: string; state: "staged" | "unstaged" | "untracked" | "deleted" }[];
  diffSections?: Array<{ path: string; diff: string }>; // pre-screened text
  openEditors: { path: string; active: boolean }[]; // capped, ordered
  selection?: { path: string; startLine: number; endLine: number };
  selectionSymbol?: string; // resolved domain-side
  diagnostics: { path: string; message: string }[]; // capped, deterministic order
}
```

Order rule for open editors: active first, then most-recently-modified
(VS Code's `tabGroups` order), capped at 10. Diagnostics: errors before
warnings, then by path, capped at 20; message text is truncated to one line
and treated as untrusted content (scanned like everything else).

### d) Stack-trace / error-text parsing (pure function)

`src/seeds/stackTrace.ts`: parses Node (`at fn (file:line:col)`), Python
(`File "file", line N`), Java (`at pkg.Class.method(File.java:N)`), Go
(`file:line:col` + `goroutine` blocks), TypeScript (as Node). Path
resolution: candidate paths are matched against the index entries (exact
relpath, then suffix match); paths outside the workspace or not present in
the index are ignored — no path traversal outside the root is possible
because only indexed paths survive. Fully unit-tested on fixed trace
fixtures of all five formats.

### e) Retrieval integration

- Seeds become **pinned candidates** (they survive zero-signal retrieval,
  like user pins today) and fire new signals with named, ablatable
  constants (one object, `M4_SEED_WEIGHTS = { diffTouched, openEditor,
diagnostic, stackFrame }`), disabled entirely by an `--ablate seeds`
  harness switch and a settings toggle.
- WHY reasons are derived from the fired signals (existing
  explainSignals machinery), so the "signal is real" test verifies each
  new reason against actual seed data.
- Interaction with P1 (rank-priority packaging): seeds are pinned into the
  candidate list BEFORE ranking; if a seed also ranks in the top-6 it keeps
  its rank-priority slot; seed-only files enter at their signal score, and
  the existing budget/degradation ladder applies unchanged.
- The `## CURRENT CHANGES` section is emitted when diff content exists,
  regardless of package contents; it consumes budget before file content.

### f) Wire format

- `## CURRENT CHANGES` is **additive**; we propose **bumping
  `CONTEXT_VERSION` to 2** (byte-compat break is acceptable per the M1
  decision, and the version line lets consumers branch). Section order:
  after `## DEVELOPER TASK`, before `## PROJECT STRUCTURE` — the user's
  working state is the second-most-important context after the task.
- Fence safety (content-aware fence length) applies to the diff blocks.
- Determinism: same repo state + same `SeedSet` ⇒ byte-identical payload
  (no timestamps; diff text is deterministic for a given tree state;
  diagnostics/open-editor order is normalized at the SeedSet boundary).

### g) Failure behavior (never throws)

No git repo, detached HEAD, untrusted workspace, git timeout, huge diff,
unreadable files: the affected seed source degrades to "absent" (empty
SeedSet fields), the package is built unseeded, and a visible status note
(`OCC: change seeds unavailable (<reason>)`) appears. The only global
failure is the existing budget-unreachable error, unchanged.

## Evaluation design (simulation; stated limits first)

**What this CANNOT show:** real editor, selection, or diagnostics seeds —
commit-message tasks carry no working-tree state. Those get unit tests,
an integration test with a temp git repo, and a manual test checklist.
**What the simulation CAN show:** whether OCC propagates from partial
change information (seeded files → their graph/lexical neighbors) better
than lexical-only retrieval, and whether seeds hurt when they are
irrelevant.

- **Qualifying tasks**: gold with k ≥ 2 regular source files. Tuning:
  234/300 tasks; eval: 379/500 (measured 2026-10-25). Multi-gold tasks are
  exactly where "some files already changed" is meaningful.
- **Seed reveal**: deterministic seeded sampler picks
  `ceil(k/2)` gold files per qualifying task as "already edited" (seeded by
  the task id; sorted for stability). The remaining gold is HIDDEN — the
  only thing scored.
- **Conditions**: (1) OCC unseeded, (2) OCC seeded with revealed gold paths
  (+ their diffs synthesized? no — the simulation seeds PATHS only, no diff
  content, since snapshots have no working tree), (3) BM25 with the
  revealed file names appended to the query text (lexical-equivalent
  advantage), (4) **decoy control**: reveal the same count of non-gold
  changed-looking files (deterministic pick from the snapshot: same
  directory as a gold file, not gold) to verify seeds do not hurt when
  irrelevant.
- **Metrics**: hidden-gold Recall@8 / Recall@10 / MRR on the ranked list,
  hidden-gold package recall, Top-1 on hidden gold. All aggregated with
  the existing paired bootstrap.
- **Keep rule**: seeded-vs-unseeded hidden-gold recall improves with a
  paired CI excluding 0 AND unseeded-task metrics (Top-1/MRR/package
  recall on the k=1 tasks, which receive no seeds) do not significantly
  regress. The decoy arm must not degrade hidden-gold recall (CI includes
  0 at worst).
- **Datasets**: tune on the tuning split only. Final confirmation on a
  fresh pool built exactly like the M3b holdout: first check upstream
  advancement (`git fetch` in the eval cache, report non-merge counts past
  the pins); if enough (≥40/repo post-pin candidates), re-pin and use
  post-pin tasks; otherwise use never-measured unsampled tasks and label
  them as such in results.json. Run ONCE.
- **Determinism**: fixed seeds everywhere (task-id-derived sampler seed;
  the harness seed for bootstrap); same dataset + same commit ⇒ identical
  metric sections; per-task checkpoint/resume as in the existing runner.

## Risks

- **Prompt injection via diff content** — diffs are repo-controlled text;
  mitigations: content-aware fences (existing), the same leak gate, and
  the diff section rendered as inert data exactly like `## SOURCE`.
- **Secrets in diffs** — mitigated by scanning diff text with the same
  scanner, redacting under the same policy, and the fail-closed leak gate.
- **Token budget blowups** — the `CURRENT CHANGES` slice has its own
  budget and competes inside the existing ledger; large diffs are
  truncated deterministically.
- **Git cost on large repos** — status/diff are local and cheap; still
  async via safeGit with a timeout, trust-gated, and skipped entirely when
  the repo is absent.

## Test plan

- Unit: stack-trace parser (5 formats, edge cases, non-workspace paths),
  status `-z` parser (renames, deletes, untracked, gitlinks), SeedSet
  normalization/order rules, diff truncation determinism.
- Property (seeded PRNG): seeded retrieval determinism; SeedSet fuzz — no
  input crashes, all degrade to valid packages.
- Integration (temp git repo, through safeGit): uncommitted/staged/
  untracked/deleted/renamed files produce the right SeedSet; untrusted
  veto skips git; timeout degrades to unseeded with a note.
- Security: diff content containing secrets is redacted under WARN and
  blocks under BLOCK; adversarial diff text cannot forge payload structure;
  leak gate covers the new section.
- fsmonitor/hook safety: the existing `eval:fsmonitor-repro` covers the
  status/diff invocations the seed collector adds (already proven for
  status/diff raw-vs-helper).
