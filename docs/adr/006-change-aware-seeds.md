# ADR 006: Change-aware seeds (M4)

Status: Implemented (Experimental, Off by Default)
Date: 2026-10-25

Status: implemented, experimental, off by default; benchmark showed no gain in recall (see negative outcome and keep-rule failure below). Shipped default retrieval behavior is unchanged.

## Context

### Goal

Feed OCC the developer's _current_ state, what is already changing, what is
open, what is selected, what is broken, as retrieval seeds and a wire
section, so the context package leads with the files the user is currently working on. This is the milestone the M2 audit ranked as the highest
context-quality gain for a local tool.

## Decision

### Seed scope

### a) Working-tree changes (extension layer, trust-gated)

Collected exclusively through `src/git/safeGit.ts` (offline, hardening
flags, async, timeout):

- `status --porcelain=v1 -z`, the authoritative map: staged/unstaged/
  untracked, renames (`R  new\0old\0`), deletions, and untracked files.
- `diff --no-ext-diff --no-textconv --name-only` and
  `diff --no-ext-diff --no-textconv --cached --name-only`: the cross-check for staged vs unstaged changes.
  Both `--no-ext-diff` and `--no-textconv` are mandatory on every diff invocation.
  An external diff driver (`diff.external`, git-config(1)) or textconv filter introduces repository-configurable command execution risks.

`npm run eval:seed-hazard-repro` reproduces this behavior for `diff.external`, textconv drivers, and clean/smudge filters.
Measurements with git 2.53 on 2026-10-25 show that raw `status` invokes the clean filter during index refreshes, whereas safeGit flags (`GIT_OPTIONAL_LOCKS=0`) prevent it.
A plain `diff` runs the external driver, textconv filter, and clean filter.
SafeGit global flags do not cover diff drivers, while the collector form (`diff --no-ext-diff --no-textconv`) neutralizes external diff and textconv drivers.

Diff collection is protected through two mechanisms:
1. The collector always passes `--no-ext-diff --no-textconv` to neutralize driver execution.
2. The workspace-trust gate prevents collector invocation in untrusted workspaces (`seedProvider.test.ts`). A plumbing-based self-computed diff (`cat-file` vs disk, no filters) remains the future hardening path.

Handling rules for changes:
- Untracked files act as path-only seeds by default. When small enough, their added content is rendered from disk under the size cap. Blocked paths never reach that step.
- Deleted paths provide seeds for retrieval only and are never read. Removed lines in a diff are treated as content and scanned like other diff text.
- Renames seed both the old and new paths.
- Binary files detected via NUL bytes act as path-only seeds.
- Diff content extraction skips files exceeding `maxFileSizeBytes`.
- Submodule paths (gitlink entries in status) act as path-only seeds.
- Line endings pass through unchanged with deterministic bytes.
- A diff larger than the `CURRENT CHANGES` budget is truncated per-file round-robin in deterministic order with a truncation note.
- Change collection is gated on `vscode.workspace.isTrusted`. Untrusted workspaces skip git execution entirely.

**Flood control**: changed-path seeds are capped (default 20,
`changeSeeds.maxPaths`), ordered deterministically, state priority
(staged < unstaged < untracked < deleted), then path, and lockfiles,
generated artifacts (`*.min.js`, `*.map`, lock files, build directories)
and git-ignored paths are excluded before the cap. A merge/rebase in
progress (`.git/MERGE_HEAD`, `.git/rebase-merge`, `.git/rebase-apply`)
adds a status note and keeps the (staged-conflict) seeds. A
500-changed-files repo must produce the same capped, ordered seed set as
any other input (tested).

### b) Diff content as a `## CURRENT CHANGES` section

- **Sensitive-path BLOCK rules are applied BEFORE any diff content is
  read**: a blocked path contributes a path-only WHY entry (like a blocked
  source file) and its diff is never collected, scanned, or rendered.
- Deleted-file removed lines are content: they are scanned and redacted
  exactly like added lines.
- Untracked files: path-only seed by default; when the file is small
  enough (≤ `maxFileSizeBytes`) its full content is rendered as an
  add-diff under the same cap, after the block check.
- Bounded: a dedicated budget slice (setting `currentChangesMaxTokens`,
  default ≈1500 tokens, counted in the SAME ledger, it competes with file
  content, never exceeds `maxTokens`).
- Hunks ordered deterministically: by path, then hunk start line; unified
  diff format via `git diff --no-ext-diff --no-textconv` (safeGit, no
  pager); the diff text is passed through the SAME secret scanner +
  redaction as source files (diffs routinely contain secrets), and the
  final payload goes through the existing fail-closed leak gate, no new
  security code paths.
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
the index are ignored, no path traversal outside the root is possible
because only indexed paths survive. Fully unit-tested on fixed trace
fixtures of all five formats.

### e) Retrieval integration

- Seeds become pinned candidates and survive zero-signal retrieval, similar to user pins.
  They fire signals defined by named constants (`M4_SEED_WEIGHTS = { diffTouched, openEditor, diagnostic, stackFrame }`).
  These signals can be disabled via the `--ablate seeds` flag or settings toggles.
  Only `diffTouched` is tuned by the simulation.
  The parameters `openEditor`, `diagnostic`, and `stackFrame` ship with conservative untuned defaults (0.3, 0.4, 0.4).
  Their seed sources remain disabled by default behind configuration settings (`offlineCodeContext.seedEditors`, `seedDiagnostics`, `seedStackTraces`, and `changeSeeds`, with `changeSeeds.maxPaths: 20`).
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

- `## CURRENT CHANGES` is **additive and optional** (present only when diff
  content exists). **`CONTEXT_VERSION` stays 1**, "v2" is reserved for the
  roadmap item (task repetition, OMITTED BUT RELEVANT, repo conventions,
  symbol-level slicing). Consumers that do not know the section see
  one more inert section; the fence-safety fix applies to every diff block.
  Section order: after `## DEVELOPER TASK`, before `## PROJECT STRUCTURE`,
  the user's working state is the second-most-important context after the
  task.
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

Commit-message benchmark tasks do not carry working-tree state.
Consequently, the simulation cannot measure real editor, selection, or diagnostic seeds.
Those capabilities rely on unit tests, an integration test against a temporary git repository, and manual checklists.
The simulation tests whether OCC propagates partial change information to graph and lexical neighbors better than lexical retrieval alone.
It also tests whether seeds reduce accuracy when they are irrelevant.

- **Qualifying tasks**: gold with k ≥ 2 regular source files. Tuning:
  234/300 tasks; eval: 379/500 (measured 2026-10-25). Multi-gold tasks are
  exactly where "some files already changed" is meaningful.
- **Seed reveal**: deterministic seeded sampler picks
  `ceil(k/2)` gold files per qualifying task as "already edited" (seeded by
  the task id; sorted for stability). The remaining gold is HIDDEN, the
  only thing scored.
- **Fairness (applies to EVERY arm)**: the revealed files are removed from
  each arm's ranked list AND from its delivered package before any
  hidden-gold metric is computed, no arm can score a hidden gold file it
  holds in hand, and no arm benefits or suffers from revealed files
  occupying ranked slots. This removal is a pure evaluation tooling function,
  unit-tested. The same removal applies to the `## CURRENT CHANGES`
  comparison arms.
- Evaluated arms and conditions:
  1. OCC unseeded baseline.
  2. OCC seeded with revealed gold paths (paths only, snapshots have no working tree, so no diff content).
  3. BM25 with revealed file names appended to the query text for lexical-equivalent comparison.
  4. Same-directory decoy control: matching count of non-gold files picked deterministically from a gold file's directory.
  5. Mixed-precision arm: approximately 50% revealed gold and 50% same-directory non-gold decoys.
  6. Random-decoy arm: matching count of random non-gold snapshot files.
  7. Real-diff arm: OCC seeded paths plus commit diffs rendered in `## CURRENT CHANGES` to measure token cost, hidden package recall, and secret handling.
- **Tuning scope**: ONLY `DIFF_TOUCHED` is tuned by simulation, its weight
  is swept on the tuning split and chosen to maximize hidden-gold gain
  subject to the MIXED arm not significantly regressing.
  `OPEN_EDITOR`, `DIAGNOSTIC` and `STACK_FRAME` get conservative untuned
  defaults, are documented as untuned, and are **off by default** behind
  settings.
- **Metrics**: hidden-gold Recall@8 / Recall@10 / MRR on the ranked list,
  hidden-gold package recall, Top-1 on hidden gold. All aggregated with
  the existing paired bootstrap.
- **Pre-registered primary metric**: **hidden-gold package recall**
  (seeded vs unseeded; the paired 95% CI must exclude 0 for the milestone
  to ship the default-on DIFF_TOUCHED signal). Every other metric and arm
  is secondary and labeled as such in results.
- **Keep rule**: the primary metric's paired CI excludes 0 (seeded >
  unseeded) AND unseeded-task metrics (k=1 tasks, which receive no seeds)
  do not significantly regress AND the mixed/random-decoy arms do not
  significantly degrade hidden-gold recall.
- Datasets: tuning runs on the tuning split only.
  Final confirmation runs once per pool from a clean committed tree across two disjoint pools:
  - Pool A (eval-stream picks 161 to 220 per repo): drawn from the same seeded stream, verified disjoint from the committed eval sample (picks 1 to 100) and the M3b holdout (picks 101 to 160).
  - Pool B: two to three new TypeScript and JavaScript repositories recorded in `repos.json` as an independent confirmation pool.
  If upstream repositories advance past pinned commits, post-pin tasks are used for Pool A; otherwise unsampled tasks are used.
- **Determinism**: fixed seeds everywhere (task-id-derived sampler seed;
  the runner seed for bootstrap); same dataset + same commit ⇒ identical
  metric sections; per-task checkpoint/resume as in the existing runner.

## Risks

- **Prompt injection via diff content**, diffs are repo-controlled text;
  mitigations: content-aware fences (existing), the same leak gate, and
  the diff section rendered as inert data exactly like `## SOURCE`.
- **Secrets in diffs**, mitigated by scanning diff text with the same
  scanner, redacting under the same policy, and the fail-closed leak gate.
- **Token budget blowups**, the `CURRENT CHANGES` slice has its own
  budget and competes inside the existing ledger; large diffs are
  truncated deterministically.
- **Git cost on large repos**, status/diff are local and cheap; still
  async via safeGit with a timeout, trust-gated, and skipped entirely when
  the repo is absent.

## Test plan

- Unit: stack-trace parser (5 formats, edge cases, non-workspace paths),
  status `-z` parser (renames, deletes, untracked, gitlinks), SeedSet
  normalization/order rules, diff truncation determinism.
- Property (seeded PRNG): seeded retrieval determinism; SeedSet fuzz, no
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

## Amendments (approved at implementation start, 2026-10-25)

The ten changes approved at CHECKPOINT 1 are incorporated above.
Key additions include fairness removal of revealed files across all arms and mixed-precision and random-decoy comparison arms.
Tuning is restricted to `DIFF_TOUCHED`, with editor, diagnostic, and stack signals disabled by default.
Diff invocations mandate `--no-ext-diff --no-textconv` to neutralize external drivers, verified by the seed-hazard test suite.
Sensitive-path blocking occurs before diff content is read.
Deleted lines are scanned for secrets, and untracked file additions are rendered under the token budget.
Wire format `CONTEXT_VERSION` remains 1.
Flood control enforces a 20-path cap with state-then-path ordering and lockfile exclusions.
Stack traces are parsed via a linear-time, 64 KB capped parser with adversarial and timing tests.
Finally, hidden-gold package recall was pre-registered as the single primary evaluation metric across two disjoint confirmation pools (picks 161 to 220 plus two to three new repositories).

## Consequences

### Evaluation outcome (measured 2026-10-25): keep rule failed, seeds ship default-off

In the corrected simulation, the weight was applied and traversal hints were appended
after content seeds per the semantics above) ran the full tuning split
(234 qualifying tasks) at three DIFF_TOUCHED weights. Hidden-gold package
recall (seeded − unseeded, paired 95% CI):

| Weight | Seeded dPkg                   | Mixed dPkg                | Random-decoy dPkg         |
| ------ | ----------------------------- | ------------------------- | ------------------------- |
| 0.3    | **−0.016 [−0.030, −0.006]\*** | −0.019 [−0.034, −0.006]\* | (not better)              |
| 0.6    | **−0.033 [−0.053, −0.015]\*** | −0.031 [−0.051, −0.014]\* | −0.021 [−0.037, −0.009]\* |
| 1.2    | **−0.031 [−0.051, −0.013]\*** | −0.033 [−0.055, −0.015]\* | (similar)                 |

Every weight is significantly NEGATIVE; even the random-decoy arm (pure
slot cost, no plausible relevance) loses package recall. Top-1/MRR/R@8/R@10
are unchanged in every arm. The mechanism: seeded paths enter the ranking
at a flat weight and consume content slots in the ~8-file package,
displacing ranked gold; the neighbor-propagation benefit only fires when
content seeds are scarce, and never pays back the slot cost. Root cause on
this benchmark: gold sets are small (2–3 files) and weakly coupled, hidden
gold is rarely a graph neighbor of revealed gold beyond what the task text
already retrieves.

v0.3 decision: the default `slotPolicy` for the (default-off) feature is
**"signal-only"**, if a user enables change seeds, the measured-harmful
"slots" behavior must not be what they get; "signal-only" reversed the
direction and removed all regressions even though its own gain was not
significant. Documented here and in the constant's doc comment.

Decision per the keep rule: **no confirmation pools were run** (they would
measure a known-harmful configuration); `offlineCodeContext.changeSeeds`
ships **default false**; `M4_SEED_WEIGHTS.diffTouched` stays 0.6 as an
untuned default documented as "no tested weight met the keep rule". All
machinery remains, is fully tested, ablatable (`--ablate seeds`), and can
be enabled for experimentation. A future attempt should change the
mechanism, not the weight: e.g. seeds influence only the CURRENT CHANGES
section (no ranking/packaging participation), or co-change-coupled
neighbors instead of graph neighbors.

## M4b outcome (2026-10-25): S1/S2 tested, direction reversed but keep rule still not met

Two additional arms were evaluated on the full tuning split (234 qualifying tasks, paired CIs vs unseeded).
Under S1 (signal-only), seeds provide retrieval signals and graph origins but are never pinned, freeing roughly 1.6 package slots.
Under S2 (signal-only plus neighbor boost), one-hop graph neighbors receive an additional boost via `neighborBoost = 0.4`:

| Arm                                    | Hidden-gold package recall | dPkg vs unseeded                | Top-1 |
| -------------------------------------- | -------------------------- | ------------------------------- | ----- |
| unseeded                               | 0.597                      | -                               | 0.325 |
| seeded (M4 slots policy)               | 0.564                      | −0.033 [−0.053, −0.015]\*       | 0.325 |
| **S1 signal-only**                     | 0.612                      | **+0.015 [−0.007, 0.040]** n.s. | 0.325 |
| **S2 signal-only + neighborBoost 0.4** | 0.616                      | **+0.019 [−0.012, 0.048]** n.s. | 0.346 |
| decoy-samedir (signal-only)            | 0.596                      | −0.001 n.s.                     | 0.316 |
| mixed (signal-only)                    | 0.609                      | +0.011 n.s.                     | 0.321 |
| random-decoy (signal-only)             | 0.592                      | −0.005 n.s.                     | 0.312 |

Direction reversed (slot-policy fix turned −0.033\* into +0.015/+0.019 and
removed all significant regressions, decoy arms clean), but the primary
metric's CI still includes 0: **the keep rule is not met**. S3 (query-term
expansion from seeded symbols) was therefore not run. Final state:
`slotPolicy` stays `"slots"` in the constant (the extension default is
`changeSeeds: false` anyway, behavior unchanged unless enabled), the
policies ship as named, ablatable constants, and the honest conclusion
stands: **tested, no recall gain; the CURRENT CHANGES diff section still
provides direct context for the LLM.**
