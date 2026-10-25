# ADR 006: Change-aware seeds (M4)

Status: Implemented (Experimental, Off by Default)
Date: 2026-10-25

Status: implemented, experimental, off by default; benchmark showed no gain in recall (see negative outcome and keep-rule failure below). Shipped default retrieval behavior is unchanged.

## Context

### Goal

Feed OCC the developer's _current_ state, what is already changing, what is
open, what is selected, what is broken, as retrieval seeds and a wire
section, so the context package leads with the files the user is actually
working on. This is the milestone the M2 audit ranked as the highest
context-quality gain for a local tool.

## Decision

### Seed Scope

### a) Working-tree changes (extension layer, trust-gated)

Collected exclusively through `src/git/safeGit.ts` (offline, hardening
flags, async, timeout):

- `status --porcelain=v1 -z`, the authoritative map: staged/unstaged/
  untracked, renames (`R  new\0old\0`), deletions, and untracked files.
- `diff --no-ext-diff --no-textconv --name-only` and
  `diff --no-ext-diff --no-textconv --cached --name-only`, the cross-check
  for staged vs unstaged. **`--no-ext-diff` and `--no-textconv` are
  mandatory on every diff invocation**: an external diff driver
  (`diff.external`, git-config(1)) or a textconv filter is
  repo-configurable ARBITRARY COMMAND EXECUTION, exactly like fsmonitor.
  `npm run eval:seed-hazard-repro` reproduces this for `diff.external`,
  a textconv driver, and a clean/smudge filter, each run raw and through
  safeGit, for both `status` and `diff`. MEASURED (git 2.53, 2026-10-25):
  raw `status` executes the CLEAN filter (index refresh) but safeGit's
  `GIT_OPTIONAL_LOCKS=0` prevents it; a PLAIN `diff` executes the external
  driver, the textconv filter AND the clean filter, raw AND through
  safeGit's global flags, which do not cover diff drivers, while the
  collector's exact form (`diff --no-ext-diff --no-textconv`) still runs
  the CLEAN filter (there is no git flag to disable filters on diff).
  Therefore: diff content collection can never be made hazard-free by
  flags alone; it is protected by (1) the collector always passing
  `--no-ext-diff --no-textconv` (kills the two RCE-prone drivers), and
  (2) the workspace-trust gate, in untrusted workspaces the collector is
  never invoked (tested in seedProvider.test.ts). A plumbing-based
  self-computed diff (cat-file vs disk, no filters) is the future
  hardening if this is ever revisited.

Handling rules: untracked files are path-only seeds by default; their
add-diff is rendered under the size cap only when the file is small enough
(read from disk, never via diff content), blocked paths never reach that
step; deleted paths are seeds for _retrieval only_ (never read), and their
REMOVED LINES in a diff are content and are scanned like any other diff
text; renames seed both paths; binary files (NUL sniff, same rule as the
scanner) are path-only seeds; diff content extraction skips files above
`maxFileSizeBytes`; submodule paths (gitlink entries in status) are
path-only seeds; CRLF is irrelevant to path seeds and content passes
through unchanged (deterministic bytes); a diff larger than the
`CURRENT CHANGES` budget is truncated per-file round-robin (deterministic
order) with a truncation note. **Gated on `vscode.workspace.isTrusted`**
exactly like recency: untrusted workspaces skip git entirely.

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

- Seeds become **pinned candidates** (they survive zero-signal retrieval,
  like user pins today) and fire new signals with named, ablatable
  constants (one object, `M4_SEED_WEIGHTS = { diffTouched, openEditor,
diagnostic, stackFrame }`), disabled entirely by an `--ablate seeds`
  harness switch and a settings toggle. **Only `diffTouched` is tuned** by
  the simulation (see below); `openEditor`/`diagnostic`/`stackFrame` ship
  with conservative untuned defaults (0.3/0.4/0.4), documented as untuned,
  and their seed sources are **off by default** behind settings
  (`offlineCodeContext.seedEditors`, `seedDiagnostics`, `seedStackTraces`,
  and `changeSeeds`, all default false; `changeSeeds` has `maxPaths: 20`).
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
  symbol-level slicing). Consumers that do not know the section simply see
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

**What this CANNOT show:** real editor, selection, or diagnostics seeds,
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
  the task id; sorted for stability). The remaining gold is HIDDEN, the
  only thing scored.
- **Fairness (applies to EVERY arm)**: the revealed files are removed from
  each arm's ranked list AND from its delivered package before any
  hidden-gold metric is computed, no arm can score a hidden gold file it
  holds in hand, and no arm benefits or suffers from revealed files
  occupying ranked slots. This removal is a pure harness function,
  unit-tested. The same removal applies to the `## CURRENT CHANGES`
  comparison arms.
- **Conditions**: (1) OCC unseeded; (2) OCC seeded with revealed gold paths
  (paths only, snapshots have no working tree, so no diff content);
  (3) BM25 with the revealed file names appended to the query text
  (lexical-equivalent advantage); (4) **same-directory decoy control**:
  the same count of non-gold files picked deterministically from a gold
  file's directory; (5) **mixed-precision arm**: ~50% revealed gold +
  ~50% same-directory non-gold decoys; (6) **random-decoy arm**: the same
  count of random non-gold snapshot files; (7) **real-diff arm**: OCC
  seeded as in (2) PLUS the revealed files' REAL commit diff (from the
  pinned clone) rendered as `## CURRENT CHANGES`, measures token cost,
  effect on (hidden) package recall, secret handling and determinism of
  the full pipeline, reported separately.
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
- **Datasets**: tune on the tuning split only. Final confirmation runs ONCE
  per pool, from a clean committed tree, on TWO disjoint pools:
  (a) **pool A**, eval-stream picks 161–220 per repo: drawn from the same
  seeded stream, asserted in code to be disjoint from the committed eval
  sample (picks 1–100), from the M3b holdout (picks 101–160, reproduced
  and asserted), and from the tuning half by construction;
  (b) **pool B**, 2–3 NEW TS/JS repositories never used before, pinned and
  recorded in `repos.json` as an independent confirmation pool.
  If upstream repos have advanced enough past the pins, post-pin tasks are
  preferred for pool A and labeled; otherwise unsampled tasks as above.
- **Determinism**: fixed seeds everywhere (task-id-derived sampler seed;
  the harness seed for bootstrap); same dataset + same commit ⇒ identical
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

The ten changes approved at CHECKPOINT 1 are incorporated above; the
load-bearing ones: fairness removal of revealed files in every arm (unit-
tested), mixed-precision and random-decoy arms, DIFF_TOUCHED-only tuning
with untuned OFF-by-default editor/diagnostic/stack signals, mandatory
`--no-ext-diff --no-textconv` plus the seed-hazard repro for
`diff.external`/textconv/clean-smudge filters, sensitive-path BLOCK before
diff content is read, deleted-line scanning, untracked add-diff under the
cap, NO CONTEXT_VERSION bump (v2 stays a roadmap item), flood control
(cap 20, state-then-path order, lockfile/generated exclusion,
merge/rebase note, 500-file test), the real-diff budget arm, two disjoint
confirmation pools (picks 161–220 asserted + 2–3 new repos) with
**hidden-gold package recall pre-registered as the single primary
metric**, and a linear-time, length-capped (64 KB) stack-trace parser with
adversarial and timing tests.

## Consequences

### Evaluation Outcome (Measured 2026-10-25): Keep Rule Failed, seeds ship default-OFF

The corrected simulation (weight actually applied; traversal hints appended
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

## M4b OUTCOME (2026-10-25): S1/S2 tested, direction reversed but keep rule still not met

S1 (seeds as signal + graph-expansion origin only, never pinned, excluded
from content slots, their ~1.6 freed slots go to other files) and S2
(S1 + one-hop graph neighbors of seeds boosted via a SEED_NEIGHBOR signal,
named constant `neighborBoost`) were run on the full tuning split
(234 qualifying tasks, paired CIs vs unseeded):

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
