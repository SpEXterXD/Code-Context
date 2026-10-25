# Retrieval evaluation (M2)

This directory holds the machine-generated artifacts of the M2 retrieval
evaluation. **Everything here is generated; re-running the pipelines below
regenerates it deterministically** (except for the explicitly non-deterministic
timing/environment sections of `results.*`).

- `dataset.json` — the pinned (task, gold files) pairs, built by
  `npm run eval:build-dataset` (needs network access once; clones live in the
  git-ignored `.eval-cache/repos/`).
- `results.json` / `results.md` — metric tables, per repository and overall,
  written by `npm run eval:retrieval` (no network needed after the dataset
  build; requires the pinned clones under `.eval-cache/repos/`).

## What is measured

The harness `scripts/eval-retrieval.ts` runs the existing OCC retrieval
pipeline **headlessly** for every task in `dataset.json`:

1. Each task's **parent commit** (the state a developer would see before making
   the change) is materialized into a scratch directory with git plumbing
   only — `read-tree` into a temporary `GIT_INDEX_FILE`, `update-index
--force-remove` for non-regular-file entries, `checkout-index -a` into the
   scratch dir — from a pinned, git-ignored clone. The user's repository is
   never touched, and no tar is involved.
2. The **file universe** of every snapshot is decided by `git ls-tree -r
<parent>` modes, not by what a filesystem happens to create: only regular
   files (git modes `100644`/`100755`) are materialized and indexed; symlinks
   (`120000`) and gitlinks/submodules (`160000`) are excluded — from the
   snapshot AND from gold — identically on Windows, macOS and Linux
   (`core.symlinks=false core.autocrlf=false core.eol=lf` are forced on every
   call, so file bytes are byte-identical across platforms too).
3. `OccApplication` indexes that snapshot and answers the task text with the
   `task` context mode. We record the ranked file list (`context.retrieval.ranked`)
   and the generated package size.
4. The same snapshot is ranked by three comparison baselines
   (`scripts/eval/baselines.ts`): a **filename-overlap** baseline, **BM25 over
   file contents**, and a **seeded random** baseline (floor). All rankings are
   truncated to the same depth (50 files). Baselines read file contents up to
   1 MiB — OCC's own scanner limit — so every system ranks the same universe.
5. Every ranking is scored against the commit's **gold files** with the
   metrics of `scripts/eval/metrics.ts`.
6. **Gold slices**: all metrics are reported twice — on the full effective
   gold and on the **source-only slice** (gold files OCC parses with a full
   structured parser: TS/JS, JSON/JSONC, Markdown; `isOccParsedPath`).
   Tasks whose source-only slice is empty are excluded from that slice's
   aggregation and counted in `goldSliceStats`.
7. **Package recall**: the fraction of gold files inside OCC's _delivered
   answer_ — the generated package, parsed from its `### FILE:` headings —
   versus Recall@8 for the baselines (8 ≈ OCC's mean package size).
8. **Paired bootstrap**: seeded CIs over per-task differences (OCC − BM25)
   for every metric, resampling task indices jointly so within-task
   correlation is preserved (`pairedDiffCi`). The unpaired per-system CIs
   cannot remove shared-task variance; the paired ones are the comparison
   to quote.
9. **All-gold gap analysis**: for every task where BM25 placed all gold in
   its top 10 and OCC did not, each OCC-missed gold file is listed with its
   rank in OCC's untruncated candidate ranking (or "not in candidates"),
   its BM25 rank, and its file type — evidence for diversity analysis.
10. **Splits**: `--split eval` (default) measures the eval half and writes
    `results.{json,md}`; `--split tuning` samples the EARLIER half of the
    time split (same filters, mode filter included) and writes
    `results-tuning.{json,md}` only — tuning experiments can never touch
    the eval-half results.

Systems only ever see the pre-commit snapshot; no post-commit state is
reachable through the index, the graph, or git metadata.

## Dataset construction

`scripts/eval-build-dataset.ts` mines non-merge commits from the pinned
histories of the repos in `scripts/eval/repos.json` and turns them into
(task, gold-file) pairs:

- **Task text** = commit subject + body, stripped of trailers
  (`Signed-off-by`, `Co-authored-by`, etc.), issue numbers and URLs.
- **Gold files** = the non-test source files touched by the commit, restricted
  to paths that already exist in the parent snapshot (files created by the
  commit cannot be retrieved from the pre-commit snapshot, so counting them
  would unfairly punish every system — they are counted separately as
  `excludedNewFiles` in the per-repo stats).
- **Mode filter**: gold is further restricted to the parent tree's REGULAR
  files. Symlink (`120000`) and gitlink (`160000`) gold is dropped and counted
  per repo (`droppedGoldSymlink` / `droppedGoldGitlink` / `droppedGoldMissing`
  in the per-repo stats, plus `tasksDroppedEmptyGold` for tasks whose entire
  gold was non-materializable and `tasksWithPartialGoldDrop` for partially
  affected ones). A TS/JS gold file that would be dropped aborts the dataset
  build — that is never silently absorbed.
- **Filters** (see `scripts/eval/lib.ts`, machine-readable reasons in the
  per-repo stats): merges and bot commits are skipped; pure
  rename/format/lockfile/docs-only/version-bump/CI-only commits are rejected as
  not localizable; commits touching too many files (>8) or too few (<1 source
  file) are rejected; identical task texts are de-duplicated (keeping the
  earliest commit).
- **Time split**: for each repo, the later half of the accepted commits forms
  the eval pool; the earlier half stays untouched for tuning. Sampling is
  seeded (`seed` in `repos.json`), so the same inputs always yield the same
  40 tasks per repo.

## Metrics

Per task, with `gold` the set of gold files and `top-k` a system's ranking cut
at k:

- **Top-1** — the first ranked file is a gold file. Reported as a mean over
  tasks.
- **Recall@k** — |gold ∩ top-k| / |gold|, macro-averaged over tasks (At a
  single gold file, Recall@k coincides with the accuracy "any-gold hit"
  convention; we always state which convention a column uses).
- **AllGold Acc@10** — 1 when _every_ gold file appears in the top 10, i.e.
  the strict all-relevant-files localization convention used by LocAgent
  (https://arxiv.org/html/2503.09089v2, §5.1) rather than the "any hit"
  convention some papers use.
- **MRR** — the reciprocal rank of the best-ranked gold file.
- Confidence intervals: **95% percentile bootstrap CIs on the per-task mean**,
  resampling tasks with replacement (1000 draws, fixed seed). The task is the
  natural resampling unit for a macro-averaged retrieval metric; see SciPy's
  bootstrap documentation (https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html)
  and Hesterberg, _What Teachers Should Know About the Bootstrap_
  (https://pmc.ncbi.nlm.nih.gov/articles/PMC4784504/) for the procedure. All
  four systems are compared on the same tasks; the CIs are unpaired, so a
  **paired** comparison is the intended next step (M3 concern).

## Baselines

- **filename** — ranks files whose path tokens overlap with the task text
  (the "the developer names the file" trivial lower bound).
- **bm25** — BM25 over file contents (term frequency saturation + IDF +
  length normalization), a standard lexical baseline in code search and the
  retrieval baseline in the original SWE-bench pipeline
  (https://arxiv.org/html/2310.06770v3, §4.1; retrieval datasets documented at
  https://www.swebench.com/SWE-bench/guides/datasets/). Sourcegraph's BM25F
  work is the practical reference for field-boosted lexical code search
  (https://sourcegraph.com/blog/keeping-it-boring-and-relevant-with-bm25f).
- **random** — seeded random ordering; sanity floor for "not worse than
  chance".

## Known limitations

1. **Commit messages are a noisy proxy for real tasks** (CommitBench documents
   how noisy commit-derived task data is:
   https://arxiv.org/html/2403.05188v1). A message describes a recorded
   change, not the problem statement a developer or agent sees; message quality
   and conventions differ per repo. Scores should be read as _relative_
   comparisons between systems on this proxy distribution, not as absolute
   production predictions.
2. **Gold = actually-touched files, not necessarily the only valid answer.** A
   commit may touch incidental files (tests, refactors bundled in); a real
   change could legitimately be implemented elsewhere. This can only make the
   eval conservative for a system that ranks semantically adjacent files.
3. **Task selection is a filtered slice**: 1–8 files, source-only, messages
   long enough to be informative, non-bot. That slice is biased toward small
   , well-described changes. The per-repo stats in `results.md` quantify the
   funnel (mined → accepted → sampled) so the selection effect stays visible.
4. **Historical leakage risk** is mitigated but not eliminated: tasks are
   evaluated against their _parent_ snapshot only, and the snapshot contains
   no post-commit git metadata; but OCC could still see a "future fix" for an
   adjacent bug in a neighboring file. Time-splitting the eval pool from the
   tuning half reduces tuning-visible overfitting (cf. the SWE-bench
   future-commit leak and its mitigation:
   https://github.com/SWE-bench/SWE-bench/issues/465).
5. **Two files, same basename, different repos**: the filename baseline keys on
   path tokens, so it cannot distinguish `lib/parser.ts` in two projects; OCC
   sees the same limitation unless the graph disambiguates.
6. **Small per-repo samples** (40 tasks each): CI widths are wide; differences
   within the CI band are not signals.
7. **Snapshot universe**: symlinks and submodule gitlinks are excluded from
   every indexed snapshot and from gold by git tree MODE, so the dataset is
   identical on Windows, macOS and Linux (an earlier tar-based
   materialization behaved differently per OS — symlinks materialized as file
   copies or were skipped depending on the tar build). In the current pinned
   dataset this excludes zod's 4 repo-root symlinks and undici's 2 test
   fixture submodules; none of them are gold in the sampled tasks (see the
   per-repo mode-filter stats in `results.md`).

## Reproducing

```bash
npm run eval:build-dataset   # once, needs network; writes docs/eval/dataset.json
npm run eval:retrieval               # writes docs/eval/results.json + results.md
npm run eval:retrieval -- --repos hono,zod   # subset run
npm run eval:retrieval -- --split tuning     # tuning half -> results-tuning.{json,md}
npm run eval:retrieval -- --split tuning --ablate fusion   # A/B a named M3 change
npm run eval:compare -- <old.json> <new.json> # paired old-vs-new bootstrap
npm run eval:diagnose                       # stage-loss diagnostics (tuning split)
npm run eval:fsmonitor-repro        # reproduction of the core.fsmonitor risk
```

`--repos` filters to the given repo ids (from `repos.json`). Snapshots and the
index store are recreated under the git-ignored `.eval-cache/` on each run.

The fsmonitor reproduction (`scripts/eval/fsmonitor-repro.ts`) creates a
throwaway repo whose `.git/config` points `core.fsmonitor` at a marker-writing
script, then runs OCC's exact `git log` invocation plus `git status` and
`git diff --name-only`, each with and without `-c core.fsmonitor=false`.

## M3 retrieval improvements (E1 + E2)

M3 datasets are larger than M2's: **100 tasks/repo eval (n=500)** and
**60 tasks/repo tuning (n=300)**, dataset hash `7d7187b6`. The M2 n=200
results are NOT comparable. Full eval-split runs are budgeted: results.json
records `evalSplitRunsIncludingThis`, and only runs that COMPLETE consume a
slot (a crashed run measures nothing).

Two ablatable scoring changes were accepted on the tuning split (paired
bootstrap vs the ablated configuration, same commit):

- **E2 — content-score fusion** (`M3_CONTENT_FUSION` in
  `src/retrieval/hybridRetriever.ts`): Step-0 diagnostics showed the dominant
  gold loss was ranking — content-matching files buried under graph-structural
  bonuses. The final score gains `weight × contentScore` (weight 2.0), so a
  0.25+ content match outranks a graph-only neighbor while exact-symbol
  leaders keep their lead. Tuning: AllGold@10 **+0.033 [0.013, 0.053]**,
  package recall **+0.007 [0.002, 0.015]**, Recall@10 +0.026*, Top-1/MRR
  n.s. (no regression).
- **E1 — body lexical field** (`M3_BODY_FIELD` in
  `src/retrieval/invertedIndex.ts`, `extractBodyTokens` in
  `src/parser/bodyTokens.ts`): comments/strings/prose become a searchable
  field (weight 0.5, below every structured field) with BM25F-style length
  normalization against a FIXED 2000-token reference (incremental and full
  rebuilds score identically); STORE_SCHEMA_VERSION 2 (older stores rebuild
  once). Cost: index time +15%, store size unchanged at 0.1MB resolution,
  startup unchanged. Tuning (vs E2-only): Recall@5 +0.026*, Recall@10
  +0.022*, MRR +0.024*, Top-1 +0.020 n.s., AllGold@10 +0.013 n.s., package
  recall +0.006 n.s. Cumulatively with E2 vs pre-M3: AllGold@10
  **+0.047 [0.020, 0.077]**, Recall@10 +0.048*, no Top-1/MRR regression.

Ablate with `--ablate fusion` / `--ablate body` (recorded in results.json);
`npm run eval:compare -- old.json new.json` runs the paired bootstrap over
the per-task values both results files record. E3 (test-file boost: only
29/155 test-gold files carry a `tests` edge) and E4 (diversity) were
skipped — see the milestone report for the evidence-based justification.

## M3b packaging (P1 rank-priority + holdout)

Step-0 packaging diagnostics (`npm run eval:diagnose`, both splits)
showed that on the eval split **OCC's ranking already beat BM25 top-8
(0.480 vs 0.437) while the package lost 0.145 of ranked recall**: packages
averaged 7.76 files holding only 4.27 of the top-8, 129 top-8 gold files
were budget-degraded, and packages contained ZERO unranked/structural
extras — inclusion order (tier, score) let tier-boosted files ranked 9–30
consume slots before top-ranked gold.

**P1 — `M3B_RANK_PRIORITY`** (ablatable, `--ablate rankPriority`): the
first six retrieval-ranked eligible files claim content slots in rank
order before tier-ordered extras. Pure ordering — tiers, budgets, ledger
and WHY reasons unchanged. Tuning paired A/B (n=300, same commit):
**package recall +0.060 [0.040, 0.083]** with every ranking metric
byte-identical.

**Holdout** (`--split holdout`, single shot, run-once guarded): the
intended post-pin holdout was impossible — upstreams had advanced only
0/0/1/1/6 non-merge commits past the pins (fetched 2026-10-25). The
implemented holdout is **unsampled eval-half tasks**: the
(tasksPerRepo+holdoutTasksPerRepo) draw of the same seeded sample stream
minus the committed eval sample (containment asserted; disjoint from the
eval sample and, by construction, from the tuning half). n=300 (60/repo),
hash recorded in results-holdout.json. The single holdout run also
computes the paired OCC(M3b) − OCC(M3, P1 ablated in-process) comparison
so no second run is needed.

## M4 change-aware seeds: simulation outcome (negative)

The seed simulation (`npm run eval:seeds-sim`, tuning split, 234 qualifying
tasks with k>=2 gold) measured hidden-gold package recall with
ceil(k/2)-of-gold revealed as seeds, revealed files stripped from every arm
before scoring. Result: significantly NEGATIVE at every tested
DIFF_TOUCHED weight (0.3: −0.016 [−0.030, −0.006]; 0.6: −0.033
[−0.053, −0.015]; 1.2: −0.031 [−0.051, −0.013]; even random-decoy seeds:
−0.021). Ranking metrics (Top-1/MRR/Recall) were unchanged in all arms.
The keep rule failed, no confirmation pools were run, and
`offlineCodeContext.changeSeeds` ships default false. Details and the
mechanism (seed slot cost vs weak gold coupling) in
[ADR-006](../adr/006-change-aware-seeds.md).

## M4b: slot-policy experiments (signal-only) — no recall gain

After the M4 negative result, M4b tested whether seeds help when they do
NOT consume package slots (`slotPolicy: "signal-only"` — seeds fire
signals and originate graph expansion but are never pinned and are
excluded from content slots) with and without a SEED_NEIGHBOR boost for
one-hop graph neighbors of seeds. On the full 234-task tuning split both
variants reversed the direction (S1 +0.015 [−0.007, 0.040]; S2 +0.019
[−0.012, 0.048]) with no decoy/unseeded regressions, but the paired CIs
include 0: the keep rule is not met and S3 was not run. Arm table in
ADR-006; per-task records in `.eval-cache/seeds-sim/` (git-ignored).
