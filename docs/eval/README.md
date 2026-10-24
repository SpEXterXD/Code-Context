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
```

`--repos` filters to the given repo ids (from `repos.json`). Snapshots and the
index store are recreated under the git-ignored `.eval-cache/` on each run.
