# Retrieval Evaluation Methodology and Results

This document describes the evaluation framework, dataset construction, metric definitions, baselines, statistical analysis, milestone results, and threats to validity for Offline Code Context Compiler (OCC).

## Evaluation Question and Method

The core evaluation question is:
Given a developer task description in plain text, can OCC accurately identify and rank the repository files that must be modified to complete that task, and does it assemble a context package that covers those files within realistic token budgets?

To measure retrieval performance without synthetic queries, OCC uses commit-mined tasks. Each evaluation task is derived from an actual merged commit in an open-source repository:
- Task input: The developer commit message.
- Gold answer: The set of repository files modified by that commit.

### Contamination Handling and Parent-Snapshot Rule
To prevent contamination between task descriptions and file contents, evaluation tasks are evaluated against repository snapshots taken at the commit parent:
1. Ground Truth Alignment: The repository state indexed for each task represents the exact tree state before the commit landed.
2. New File Exclusion: Files introduced for the first time by the commit do not exist in the parent snapshot and cannot be discovered. They are excluded from the gold set before scoring.
3. Run-Once Guard: Holdout evaluation splits are guarded by run-once markers in the evaluation harness (`scripts/eval-retrieval.ts`). A split marked as holdout cannot be evaluated repeatedly during tuning.

## Evaluation Datasets

The evaluation suite uses five active open-source TypeScript and JavaScript repositories pinned to fixed commits (`docs/eval/dataset.json`):

| Repository | Pinned Commit | License | Source Files at Pin | Total Mined Commits | Accepted Tasks |
|---|---|---|---|---|---|
| `hono` | `5ca49b0720755c585c9a9835f0a479ceea36fb52` | MIT | 292 | 2,803 | 1,181 |
| `zod` | `afdac65e0f80c0ccf9e8909da97c411567908b57` | MIT | 319 | 2,935 | 494 |
| `undici` | `1f452240899a1bbbfa7cbd64ade03ec11c7cef2c` | MIT | 179 | 2,168 | 448 |
| `axios` | `e6b79d9cef796ca3a903bb83e51d4752b019fd67` | MIT | 96 | 1,732 | 309 |
| `fastify` | `ce41dc0fbb4ed75e9a42f3972ac896333f6a7396` | MIT | 57 | 4,204 | 933 |

Dataset Filtering Rules:
- Commit messages must be between 10 and 500 characters.
- Commits modifying more than 10 files are excluded as large refactorings.
- Version bumps, automated dependency updates (Dependabot, Renovate), reverts, merge commits, and CI-only or docs-only modifications are filtered out.
- Gold set must contain at least one localizable source file present in the parent tree.

### Splits
- Eval Split: 500 tasks (100 per repo, dataset hash `7d7187b6`, seed 20260918).
- Tuning Split: 300 tasks (60 per repo, dataset hash `ec50ab4f`, seed 20260918).
- Holdout Split: 300 tasks (60 per repo, dataset hash `ec50ab4f`, seed 20260918). Unsampled tasks drawn from the same pool.

## Metrics and Definitions

Retrieval quality is measured across six standard Information Retrieval metrics:

1. Top-1 Hit Rate: Fraction of tasks where the highest-ranked candidate file is in the gold set.
2. Recall@5: Fraction of gold files present in the top 5 ranked candidates.
3. Recall@10: Fraction of gold files present in the top 10 ranked candidates.
4. AllGold Acc@10: Fraction of tasks where all gold files appear within the top 10 candidates.
5. Mean Reciprocal Rank (MRR): Average of reciprocal ranks (`1 / rank`) for the first gold file encountered.
6. Package Recall: Fraction of gold files included inside the finalized context package (extracted from `### FILE:` headings in the `## SOURCE` section).

### Gold Evaluation Slices
Every evaluation reports numbers across two distinct gold file slices:
- Full Gold slice (`overall` in JSON): Evaluates against all modified files, including configuration, documentation, and build scripts.
- Source-Only slice (`overallSourceOnly` in JSON): Evaluates against files parsed with full AST analysis (TypeScript and JavaScript files).

## Baselines

OCC is evaluated against three reference systems:
1. `bm25`: An in-memory Okapi BM25 implementation operating directly over full raw file contents.
2. `filename`: Ranks files purely by lexical match between the query and relative file paths.
3. `random`: Selects files by seeded pseudorandom sampling from the repository file list.

## Statistical Analysis

All metrics are reported as mean values accompanied by 95% bootstrap confidence intervals computed using 2,000 paired bootstrap draws (`pairedBootstrap` in JSON). Differences between systems are calculated per task pair (OCC minus baseline). An advantage is statistically significant at alpha = 0.05 when the 95% confidence interval of the difference excludes zero.

## Evaluation Results

### Tuning Split Results (300 Tasks)
Source file: `docs/eval/results-tuning.json`, OCC commit `0d66d834760c6cc2b9e36a3ddb2af70b7f860601`.

Full Gold Slice (`overall`):

| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR | Package Recall |
|---|---|---|---|---|---|---|
| `occ` | 0.473 [0.413, 0.527] | 0.543 [0.502, 0.580] | 0.675 [0.637, 0.713] | 0.437 [0.387, 0.493] | 0.621 [0.577, 0.665] | 0.669 [0.631, 0.706] |
| `bm25` | 0.293 [0.243, 0.350] | 0.427 [0.380, 0.475] | 0.592 [0.547, 0.636] | 0.373 [0.317, 0.430] | 0.460 [0.415, 0.502] | 0.534 [0.490, 0.580] |
| `filename` | 0.207 [0.160, 0.253] | 0.228 [0.188, 0.265] | 0.325 [0.282, 0.363] | 0.163 [0.123, 0.203] | 0.312 [0.268, 0.356] | 0.275 [0.235, 0.313] |
| `random` | 0.030 [0.013, 0.050] | 0.041 [0.028, 0.055] | 0.089 [0.066, 0.111] | 0.023 [0.007, 0.043] | 0.098 [0.078, 0.120] | 0.079 [0.059, 0.102] |

Source-Only Slice (`overallSourceOnly`):

| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| `occ` | 0.473 [0.413, 0.527] | 0.546 [0.506, 0.583] | 0.680 [0.642, 0.718] | 0.443 [0.393, 0.497] | 0.621 [0.577, 0.665] |
| `bm25` | 0.290 [0.240, 0.343] | 0.429 [0.382, 0.476] | 0.594 [0.550, 0.639] | 0.377 [0.320, 0.433] | 0.458 [0.414, 0.500] |
| `filename` | 0.203 [0.153, 0.247] | 0.227 [0.187, 0.264] | 0.324 [0.281, 0.362] | 0.163 [0.123, 0.203] | 0.307 [0.263, 0.350] |
| `random` | 0.030 [0.013, 0.050] | 0.041 [0.028, 0.055] | 0.089 [0.067, 0.112] | 0.023 [0.007, 0.043] | 0.098 [0.078, 0.120] |

On the tuning split, OCC generated packages averaged 25,593.5 tokens and 14.517 files included per task.

### Holdout Split Results (300 Tasks)
Source file: `docs/eval/results-holdout.json`, OCC commit `c0df0ba79d24797b2702635a291cb75d0d8209c9`.

Full Gold Slice (`overall`):

| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR | Package Recall |
|---|---|---|---|---|---|---|
| `occ` | 0.303 [0.253, 0.357] | 0.438 [0.395, 0.481] | 0.560 [0.518, 0.603] | 0.327 [0.277, 0.377] | 0.483 [0.437, 0.530] | 0.458 [0.414, 0.501] |
| `bm25` | 0.200 [0.157, 0.243] | 0.305 [0.263, 0.344] | 0.466 [0.419, 0.511] | 0.273 [0.220, 0.323] | 0.345 [0.308, 0.383] | 0.412 [0.367, 0.458] |
| `filename` | 0.203 [0.160, 0.250] | 0.279 [0.237, 0.320] | 0.379 [0.334, 0.426] | 0.257 [0.210, 0.307] | 0.307 [0.264, 0.347] | 0.335 [0.294, 0.379] |
| `random` | 0.000 [0.000, 0.000] | 0.005 [0.000, 0.010] | 0.015 [0.005, 0.028] | 0.007 [0.000, 0.017] | 0.017 [0.012, 0.023] | 0.015 [0.006, 0.027] |

Source-Only Slice (`overallSourceOnly`):

| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| `occ` | 0.300 [0.250, 0.353] | 0.443 [0.400, 0.487] | 0.567 [0.525, 0.610] | 0.333 [0.283, 0.387] | 0.480 [0.433, 0.528] |
| `bm25` | 0.187 [0.143, 0.230] | 0.302 [0.261, 0.340] | 0.462 [0.413, 0.507] | 0.277 [0.223, 0.327] | 0.328 [0.292, 0.367] |
| `filename` | 0.197 [0.153, 0.240] | 0.278 [0.236, 0.321] | 0.377 [0.332, 0.424] | 0.257 [0.210, 0.307] | 0.301 [0.259, 0.340] |
| `random` | 0.000 [0.000, 0.000] | 0.005 [0.000, 0.010] | 0.015 [0.005, 0.028] | 0.007 [0.000, 0.017] | 0.017 [0.012, 0.023] |

On the holdout split, OCC generated packages averaged 27,403.1 tokens and 7.933 files included per task. In paired comparisons, OCC outranked BM25 on Top-1 by +0.103 [0.040, 0.170]. Package recall difference was +0.046 [-0.004, 0.100], representing statistical parity.

### Secret-Token Filtering Verification
Following the implementation of secret-token blanking in index shards, verified facts are as follows:
- Ranking metrics remained identical across both the full gold and source-only slices.
- Package contents were byte-identical for 298 out of 300 tuning tasks.
- Exactly two tasks exhibited token length differences (40 tokens and 80 tokens respectively), with the exact mechanism not established.

### Negative Results: Change-Aware Seeds Experiments
During development milestone M4 (ADR-006), working-tree change seeds were evaluated via simulation (`results-seeds-sim-tuning-*.json`):
- Across all tested weights (w=0.3, w=0.6, w=1.2), injecting change seeds reduced package recall on hidden gold files compared to unseeded retrieval.
- Seeded files displaced relevant unseeded candidates from token budgets.
- Outcome: The feature was designated experimental and shipped default OFF (`changeSeeds: false`, slotPolicy: `signal-only`).

## Threats to Validity

1. Commit Messages as Task Proxies: Commit messages are written retrospectively by authors who already know what they changed. Real user prompts are often vaguer or express high-level behavioral goals.
2. Homogeneous Tech Stack: All five benchmark repositories are written in TypeScript and JavaScript. Performance on other languages (which receive metadata-only parsing) is not measured by this benchmark.
3. Token Count Estimates: Token totals are estimated as characters divided by 4 (`chars / 4`) rather than tokenizer-exact counts (such as cl100k_base).
4. Single Test Machine: Indexing benchmarks and evaluation runs were executed on a single developer machine (AMD Ryzen 7 4800H, Windows 11, Node 24).
5. Holdout Pool: The holdout split was drawn from the same pool of mined commits because upstream repositories had not advanced significantly since the initial pin date.

## Reproduction Instructions

To reproduce evaluation results from scratch:

```bash
# Build dataset from repository pins (requires internet access to clone pins; ~15 min, 2 GB disk)
npm run eval:build-dataset

# Run retrieval evaluation on tuning split (~12 min)
npm run eval:retrieval -- --split tuning

# Run retrieval evaluation on holdout split (~12 min)
npm run eval:retrieval -- --split holdout
```

Evaluation progress is saved to checkpoint files in `.eval-cache/`. If interrupted, running the command resumes from the last completed task.
