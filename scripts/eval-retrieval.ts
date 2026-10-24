/**
 * M2 retrieval evaluation harness (dev-time only; clones live in the
 * git-ignored .eval-cache/). For every task in docs/eval/dataset.json it:
 *   1. materializes the task's PARENT commit snapshot into a scratch dir
 *      with git plumbing only (read-tree → update-index → checkout-index;
 *      the file universe is the parent tree's REGULAR files — symlinks and
 *      gitlinks are excluded by tree mode on every platform, matching the
 *      dataset builder's gold filter; the user's repo is untouched),
 *   2. runs the full OCC pipeline headlessly (OccApplication, no vscode
 *      import) and records the ranked file list + generated package stats,
 *   3. ranks the same snapshot with the three baselines,
 *   4. scores everything with the M2 metrics and aggregates per repo and
 *      overall with seeded bootstrap confidence intervals.
 *
 * Determinism: same dataset + same OCC commit ⇒ byte-identical metric
 * sections in docs/eval/results.json. Wall-clock timings, the OCC commit,
 * the working-tree-clean flag and machine info live only in the dedicated
 * timing/environment sections.
 *
 * Splits: `--split eval` (default) runs the eval half and writes
 * docs/eval/results.{json,md}; `--split tuning` samples the EARLIER half of
 * the time split and writes docs/eval/results-tuning.{json,md} only, so
 * tuning experiments can never touch the eval-half results.
 *
 * Usage: npm run eval:retrieval [-- [--repos id1,id2] [--split tuning]]
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

import { OccApplication } from "../src/application/contextService";
import { CancellationSource } from "../src/shared/cancellation";

import { bm25Baseline, filenameBaseline, randomBaseline } from "./eval/baselines";
import type { DatasetTask } from "./eval/dataset";
import { cloneDirFor, materializeSnapshot, verifyPinnedCommit } from "./eval/gitminer";
import {
  aggregateRuns,
  pairedDiffCi,
  recallAtK,
  summarize as summarizeMetric,
  taskMetrics,
  type MetricSummary,
  type PairedDiff,
  type RankedFile,
  type RunMetrics,
} from "./eval/metrics";
import {
  hashString,
  isCiConfigPath,
  isDocsPath,
  isLockFilePath,
  isOccParsedPath,
  isSourcePath,
  isTestPath,
} from "./eval/lib";
import {
  buildTuningDataset,
  loadEvalDataset,
  loadReposFile,
  readSnapshot,
  type DatasetFile,
  type RepoEntry,
  type ReposFile,
} from "./eval/splitLoader";

const ROOT = path.resolve(import.meta.dirname ?? path.join(process.cwd(), "scripts"), "..");
const RESULTS_JSON = path.join(ROOT, "docs", "eval", "results.json");
const RESULTS_MD = path.join(ROOT, "docs", "eval", "results.md");
const TUNING_RESULTS_JSON = path.join(ROOT, "docs", "eval", "results-tuning.json");
const TUNING_RESULTS_MD = path.join(ROOT, "docs", "eval", "results-tuning.md");
const SCRATCH_ROOT = path.join(ROOT, ".eval-cache", "scratch");

const SEED = 20260918;
const RETRIEVE_LIMIT = 50;

type SystemName = "occ" | "filename" | "bm25" | "random";
const SYSTEMS: SystemName[] = ["occ", "filename", "bm25", "random"];
type GoldSlice = "full" | "sourceOnly";
/** Metric keys used by the paired OCC−BM25 analysis (RunMetrics keys + package recall). */
type PairedMetricKey = "top1" | "recall5" | "recall10" | "allGoldAcc10" | "mrr" | "packageRecall";
const PAIRED_METRIC_KEYS: PairedMetricKey[] = [
  "top1",
  "recall5",
  "recall10",
  "allGoldAcc10",
  "mrr",
  "packageRecall",
];

interface SystemSummary {
  overall: RunMetrics;
  perRepo: Record<string, RunMetrics>;
  /** Same metrics on the source-only gold slice (OCC-fully-parsed gold). */
  overallSourceOnly: RunMetrics;
  /**
   * Gold coverage of the delivered answer: OCC = fraction of gold files in
   * the generated package (parsed from its `### FILE:` headings); baselines
   * = Recall@8, matching OCC's mean package size.
   */
  packageRecall: MetricSummary;
  /** OCC only, from the generated context package. */
  packageStats?: { meanTokens: number; meanFilesIncluded: number };
}

/** One gold file OCC's top-10 missed on a task where BM25 got all gold. */
interface GapMissingFile {
  path: string;
  /** source | test | docs | lockfile | ci-config | other. */
  type: string;
  /** 1-based rank in OCC's UNTRUNCATED candidate ranking, or null. */
  occRank: number | null;
  /** 1-based rank in BM25's ranking (≤ 10 by construction), or null. */
  bm25Rank: number | null;
  /** Whether OCC's retrieval returned the file at all. */
  inOccCandidates: boolean;
}

interface GoldSliceStats {
  full: { goldFiles: number; tasks: number };
  sourceOnly: { goldFiles: number; tasks: number; tasksExcludedEmpty: number };
  perRepo: Record<string, { fullFiles: number; sourceFiles: number; sourceTasks: number }>;
}

interface CaseStudy {
  id: string;
  repoId: string;
  subject: string;
  task: string;
  gold: string[];
  topRanked: string[];
  mrr: number;
  recall10: number;
}

interface ResultsFile {
  /** Which half of the time split this run measured. */
  split: "eval" | "tuning";
  /**
   * M3 eval-run budget: how many full eval-split runs (including this one)
   * have happened on this machine across the milestone. null for tuning.
   */
  evalSplitRunsIncludingThis: number | null;
  seed: number;
  /** OCC commit the run was executed from (captured at run start). */
  occCommit: string;
  /** True when `git status --porcelain` was empty when the run started. */
  workingTreeClean: boolean;
  datasetHash: string;
  tasks: number;
  /** Tasks where buildContext threw (e.g. budget-unreachable) and were skipped. */
  skippedTasks: Array<{ task: string; error: string }>;
  systems: Record<SystemName, SystemSummary>;
  goldSliceStats: GoldSliceStats;
  /** Seeded PAIRED bootstrap over per-task differences (OCC − BM25). */
  pairedBootstrap: Record<GoldSlice, Record<PairedMetricKey, PairedDiff>>;
  /** Tasks where BM25 placed all gold in its top 10 and OCC did not. */
  allGoldGap: {
    tasks: Array<{ id: string; repoId: string; missing: GapMissingFile[] }>;
    summary: {
      tasks: number;
      missingFiles: number;
      byType: Record<string, number>;
      notInOccCandidates: number;
      occRankMedian: number | null;
      bm25RankMedian: number | null;
    };
  };
  caseStudies: { worst: CaseStudy[]; best: CaseStudy[] };
  timingMs: { snapshotMs: number; indexMs: number; occMs: number; baselinesMs: number };
  environment: { node: string; platform: string; cpu: string; totalMemGB: number };
}

function argReposFilter(): string[] | undefined {
  const i = process.argv.indexOf("--repos");
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value ? value.split(",").filter((s) => s.length > 0) : undefined;
}

function argSplit(): "eval" | "tuning" {
  const i = process.argv.indexOf("--split");
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (value === "tuning") return "tuning";
  if (value !== undefined && value !== "eval") {
    console.error(`--split must be "eval" or "tuning" (got ${value})`);
    process.exit(1);
  }
  return "eval";
}

function occHeadCommit(): string {
  try {
    return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** True when the OCC working tree had no modifications when the run started. */
function occWorkingTreeClean(): boolean {
  try {
    return execFileSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)
      .every((l) => l.length === 0);
  } catch {
    return false;
  }
}

/**
 * M3 budget guard: counts FULL eval-split runs in a git-ignored counter file
 * so results.json can prove how many eval runs happened in the milestone
 * (tuning runs are unlimited and never counted).
 */
const EVAL_RUN_COUNTER = path.join(ROOT, ".eval-cache", "eval-split-runs.json");
function nextEvalRunIndex(): number {
  let n = 0;
  try {
    n = (JSON.parse(fs.readFileSync(EVAL_RUN_COUNTER, "utf8")) as { count?: number }).count ?? 0;
  } catch {
    /* fresh counter */
  }
  n += 1;
  fs.mkdirSync(path.dirname(EVAL_RUN_COUNTER), { recursive: true });
  fs.writeFileSync(EVAL_RUN_COUNTER, `${JSON.stringify({ count: n })}\n`);
  return n;
}

async function run(): Promise<void> {
  const split = argSplit();
  const evalRunIndex = split === "eval" ? nextEvalRunIndex() : null;
  const outJson = split === "tuning" ? TUNING_RESULTS_JSON : RESULTS_JSON;
  const outMd = split === "tuning" ? TUNING_RESULTS_MD : RESULTS_MD;
  const repos = loadReposFile();
  const filter = argReposFilter();
  let dataset: DatasetFile;
  if (split === "tuning") {
    console.log(
      "======================================================================\n" +
        " TUNING SPLIT RUN — writes docs/eval/results-tuning.* only;\n" +
        " docs/eval/results.* (the eval half) is never touched.\n" +
        "======================================================================",
    );
    dataset = buildTuningDataset(repos, filter);
  } else {
    try {
      dataset = loadEvalDataset();
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }
  }

  const tasks = filter ? dataset.tasks.filter((t) => filter.includes(t.repoId)) : dataset.tasks;
  const repoIds = [...new Set(tasks.map((t) => t.repoId))].sort();

  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });

  for (const repoId of repoIds) {
    const repo = repos.repos.find((r) => r.id === repoId);
    if (!repo) {
      console.error(`repos.json has no entry for dataset repo ${repoId}`);
      process.exit(1);
    }
    try {
      verifyPinnedCommit(cloneDirFor(repoId), repo.pinnedCommit);
    } catch (error) {
      console.error(`[${repoId}] ${(error as Error).message}`);
      process.exit(1);
    }
  }
  for (const repoId of repoIds) {
    const s = dataset.repos[repoId]?.stats;
    if (s) {
      console.log(
        `[${repoId}] sampled=${s.sampled} evaluated=${s.evaluatedTasks}` +
          ` (empty-gold dropped=${s.tasksDroppedEmptyGold}, partial-gold tasks=${s.tasksWithPartialGoldDrop},` +
          ` gold dropped: symlink=${s.droppedGoldSymlink} gitlink=${s.droppedGoldGitlink} missing=${s.droppedGoldMissing})`,
      );
    }
  }

  const ranks = new Map<SystemName, Map<string, RankedFile[]>>(SYSTEMS.map((s) => [s, new Map()]));
  const occPackageStats: Array<{ tokens: number; files: number }> = [];
  const timingMs = { snapshotMs: 0, indexMs: 0, occMs: 0, baselinesMs: 0 };
  const skippedTasks: Array<{ task: string; error: string }> = [];
  /** OCC's UNTRUNCATED candidate ranking per task (path order), for the gap analysis. */
  const fullRankedByTask = new Map<string, string[]>();
  /** Files actually included in OCC's generated package, parsed from the payload. */
  const packageFilesByTask = new Map<string, string[]>();

  for (const repoId of repoIds) {
    for (const t of tasks.filter((x) => x.repoId === repoId)) {
      const clonePath = cloneDirFor(repoId);
      const snapshotStart = performance.now();
      // Task ids contain ':' (e.g. "axios:d17d9a66"); Windows paths reject it.
      const snapKey = `${repoId}-${t.sha.slice(0, 12)}`;
      materializeSnapshot(clonePath, t.parentSha, SCRATCH_ROOT, snapKey);
      timingMs.snapshotMs += performance.now() - snapshotStart;

      const indexStart = performance.now();
      const snapDir = path.join(SCRATCH_ROOT, snapKey);
      const app = new OccApplication(snapDir, path.join(SCRATCH_ROOT, "store"));
      app.initialize();
      const indexResult = await app.indexing.indexWorkspace(CancellationSource.never());
      timingMs.indexMs += performance.now() - indexStart;
      if (indexResult.cancelled || app.indexing.getEntries().size === 0) {
        console.error(`  ${repoId} ${t.id}: indexing produced no entries — skipping task`);
        fs.rmSync(snapDir, { recursive: true, force: true });
        continue;
      }

      // Invariant: the dataset's effective gold (parent-tree regular files)
      // must exist on disk. A violation means materialization and the mode
      // filter disagree — a harness bug, never silently absorbed.
      for (const g of t.gold) {
        if (!fs.statSync(path.join(snapDir, g), { throwIfNoEntry: false })?.isFile()) {
          console.error(`  ${repoId} ${t.id}: ABORT — gold file missing from snapshot: ${g}`);
          process.exit(1);
        }
      }

      const occStart = performance.now();
      let context: ReturnType<OccApplication["buildContext"]>;
      try {
        context = app.buildContext("task", { taskText: t.task });
      } catch (error) {
        // e.g. CONTEXT_BUDGET_UNREACHABLE when static sections alone exceed
        // the budget on very large snapshots — skip the task, never crash
        // the whole run.
        skippedTasks.push({ task: t.id, error: (error as Error).message });
        console.error(`  ${repoId} ${t.id}: SKIPPED (${(error as Error).message.slice(0, 90)})`);
        fs.rmSync(snapDir, { recursive: true, force: true });
        continue;
      }
      const rankedAll = context.retrieval?.ranked ?? [];
      const occRanking = rankedAll
        .slice(0, RETRIEVE_LIMIT)
        .map((r) => ({ path: r.path, score: r.score }));
      ranks.get("occ")!.set(t.id, occRanking);
      fullRankedByTask.set(
        t.id,
        rankedAll.map((r) => r.path),
      );
      // Package contents: the wire format emits `### FILE: <path>` at line
      // start; repository content is fenced and line-numbered, so it can
      // never forge these headings (content-aware fences, M1/F1).
      packageFilesByTask.set(t.id, [
        ...new Set([...context.payload.matchAll(/^### FILE: (.+)$/gm)].map((m) => m[1]!)),
      ]);
      occPackageStats.push({ tokens: context.estimatedTokens, files: context.filesIncluded });
      timingMs.occMs += performance.now() - occStart;

      const blStart = performance.now();
      const snapshot = readSnapshot(snapDir);
      ranks.get("filename")!.set(t.id, filenameBaseline(snapshot, t.task).slice(0, RETRIEVE_LIMIT));
      ranks.get("bm25")!.set(t.id, bm25Baseline(snapshot, t.task).slice(0, RETRIEVE_LIMIT));
      ranks
        .get("random")!
        .set(t.id, randomBaseline(snapshot, t.task, SEED).slice(0, RETRIEVE_LIMIT));
      timingMs.baselinesMs += performance.now() - blStart;

      fs.rmSync(snapDir, { recursive: true, force: true });
      console.log(
        `  ${repoId} ${t.id}: rerank ${occRanking.length} files (snapshot had ${snapshot.size})`,
      );
    }
  }

  // ---- aggregation ---------------------------------------------------------
  const goldOf =
    (slice: GoldSlice) =>
    (t: DatasetTask): string[] =>
      slice === "full" ? t.gold : t.gold.filter(isOccParsedPath);
  const tasksFor = (slice: GoldSlice): DatasetTask[] =>
    slice === "full" ? tasks : tasks.filter((t) => goldOf("sourceOnly")(t).length > 0);

  function summarize(name: SystemName, taskList: DatasetTask[], slice: GoldSlice): RunMetrics {
    const map = ranks.get(name)!;
    const gold = goldOf(slice);
    return aggregateRuns(
      taskList.map((t) => taskMetrics(map.get(t.id) ?? [], gold(t))),
      SEED + hashString(name),
    );
  }

  /** Package-level gold coverage: OCC = generated package, baselines = top-8. */
  function packageRecallValue(name: SystemName, t: DatasetTask, gold: string[]): number {
    if (gold.length === 0) return 0;
    if (name === "occ") {
      const pkg = new Set(packageFilesByTask.get(t.id) ?? []);
      let hits = 0;
      for (const g of gold) if (pkg.has(g)) hits++;
      return hits / gold.length;
    }
    return recallAtK(ranks.get(name)!.get(t.id) ?? [], gold, 8);
  }

  const sourceTasks = tasksFor("sourceOnly");
  const systems = {} as Record<SystemName, SystemSummary>;
  for (const name of SYSTEMS) {
    const perRepo: Record<string, RunMetrics> = {};
    for (const repoId of repoIds) {
      perRepo[repoId] = summarize(
        name,
        tasks.filter((t) => t.repoId === repoId),
        "full",
      );
    }
    const gold = goldOf("full");
    systems[name] = {
      overall: summarize(name, tasks, "full"),
      perRepo,
      overallSourceOnly: summarize(name, sourceTasks, "sourceOnly"),
      packageRecall: summarizeMetric(
        tasks.map((t) => packageRecallValue(name, t, gold(t))),
        SEED + hashString(`${name}:package`),
      ),
      ...(name === "occ"
        ? {
            packageStats: {
              meanTokens:
                occPackageStats.reduce((a, b) => a + b.tokens, 0) /
                Math.max(1, occPackageStats.length),
              meanFilesIncluded:
                occPackageStats.reduce((a, b) => a + b.files, 0) /
                Math.max(1, occPackageStats.length),
            },
          }
        : {}),
    };
  }

  // ---- gold slice stats ------------------------------------------------------
  const sourceGold = goldOf("sourceOnly");
  const goldSliceStats: GoldSliceStats = {
    full: {
      goldFiles: tasks.reduce((a, t) => a + t.gold.length, 0),
      tasks: tasks.length,
    },
    sourceOnly: {
      goldFiles: sourceTasks.reduce((a, t) => a + sourceGold(t).length, 0),
      tasks: sourceTasks.length,
      tasksExcludedEmpty: tasks.length - sourceTasks.length,
    },
    perRepo: Object.fromEntries(
      repoIds.map((repoId) => {
        const list = tasks.filter((t) => t.repoId === repoId);
        return [
          repoId,
          {
            fullFiles: list.reduce((a, t) => a + t.gold.length, 0),
            sourceFiles: list.reduce((a, t) => a + sourceGold(t).length, 0),
            sourceTasks: list.filter((t) => sourceGold(t).length > 0).length,
          },
        ];
      }),
    ),
  };

  // ---- paired bootstrap (OCC − BM25), per slice --------------------------------
  const pairedBootstrap = {} as Record<GoldSlice, Record<PairedMetricKey, PairedDiff>>;
  for (const slice of ["full", "sourceOnly"] as GoldSlice[]) {
    const list = tasksFor(slice);
    const gold = goldOf(slice);
    const occPerTask = list.map((t) => taskMetrics(ranks.get("occ")!.get(t.id) ?? [], gold(t)));
    const bm25PerTask = list.map((t) => taskMetrics(ranks.get("bm25")!.get(t.id) ?? [], gold(t)));
    const row = {} as Record<PairedMetricKey, PairedDiff>;
    for (const key of PAIRED_METRIC_KEYS) {
      if (key === "packageRecall") {
        row[key] = pairedDiffCi(
          list.map((t) => packageRecallValue("occ", t, gold(t))),
          list.map((t) => packageRecallValue("bm25", t, gold(t))),
          SEED + hashString(`packageRecall:${slice}`),
        );
      } else {
        row[key] = pairedDiffCi(
          occPerTask.map((m) => m[key]),
          bm25PerTask.map((m) => m[key]),
          SEED + hashString(`${key}:${slice}`),
        );
      }
    }
    pairedBootstrap[slice] = row;
  }

  // ---- all-gold gap analysis (full slice): BM25 all-gold in top 10, OCC not ----
  function classifyGoldType(p: string): string {
    if (isTestPath(p)) return "test";
    if (isSourcePath(p)) return "source";
    if (isLockFilePath(p)) return "lockfile";
    if (isDocsPath(p)) return "docs";
    if (isCiConfigPath(p)) return "ci-config";
    return "other";
  }
  const gapTasks: Array<{ id: string; repoId: string; missing: GapMissingFile[] }> = [];
  for (const t of [...tasks].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const occM = taskMetrics(ranks.get("occ")!.get(t.id) ?? [], t.gold);
    const bmM = taskMetrics(ranks.get("bm25")!.get(t.id) ?? [], t.gold);
    if (bmM.allGoldAcc10 !== 1 || occM.allGoldAcc10 === 1) continue;
    const occTop10 = new Set((ranks.get("occ")!.get(t.id) ?? []).slice(0, 10).map((r) => r.path));
    const bm25RankOf = new Map(
      (ranks.get("bm25")!.get(t.id) ?? []).map((r, i) => [r.path, i + 1] as const),
    );
    const fullRanked = fullRankedByTask.get(t.id) ?? [];
    const missing = t.gold
      .filter((g) => !occTop10.has(g))
      .sort()
      .map<GapMissingFile>((g) => {
        const idx = fullRanked.indexOf(g);
        return {
          path: g,
          type: classifyGoldType(g),
          occRank: idx >= 0 ? idx + 1 : null,
          bm25Rank: bm25RankOf.get(g) ?? null,
          inOccCandidates: idx >= 0,
        };
      });
    gapTasks.push({ id: t.id, repoId: t.repoId, missing });
  }
  const allMissing = gapTasks.flatMap((g) => g.missing);
  const occRanks = allMissing.map((m) => m.occRank).filter((r): r is number => r !== null);
  const bm25Ranks = allMissing.map((m) => m.bm25Rank).filter((r): r is number => r !== null);
  const median = (xs: number[]): number | null =>
    xs.length === 0
      ? null
      : (xs.slice().sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] ?? null);
  const byType: Record<string, number> = {};
  for (const m of allMissing) byType[m.type] = (byType[m.type] ?? 0) + 1;
  const allGoldGap = {
    tasks: gapTasks,
    summary: {
      tasks: gapTasks.length,
      missingFiles: allMissing.length,
      byType: Object.fromEntries(Object.entries(byType).sort(([a], [b]) => a.localeCompare(b))),
      notInOccCandidates: allMissing.filter((m) => !m.inOccCandidates).length,
      occRankMedian: median(occRanks),
      bm25RankMedian: median(bm25Ranks),
    },
  };

  // ---- case studies: 5 worst / 5 best by (MRR, recall10) on OCC ----------------
  const occMap = ranks.get("occ")!;
  const sortedCases = tasks
    .map((t) => ({ t, m: taskMetrics(occMap.get(t.id) ?? [], t.gold) }))
    .sort((a, b) => a.m.mrr - b.m.mrr || a.m.recall10 - b.m.recall10);
  const toCase = ({ t, m }: (typeof sortedCases)[number]): CaseStudy => ({
    id: t.id,
    repoId: t.repoId,
    subject: t.subject,
    task: t.task,
    gold: t.gold,
    topRanked: (occMap.get(t.id) ?? []).slice(0, 10).map((r) => r.path),
    mrr: m.mrr,
    recall10: m.recall10,
  });
  const caseStudies = {
    worst: sortedCases.slice(0, 5).map(toCase),
    best: sortedCases.slice(-5).map(toCase).reverse(),
  };

  const results: ResultsFile = {
    split,
    evalSplitRunsIncludingThis: evalRunIndex,
    seed: SEED,
    occCommit: occHeadCommit(),
    workingTreeClean: occWorkingTreeClean(),
    datasetHash: dataset.datasetHash,
    tasks: tasks.length,
    skippedTasks,
    systems,
    goldSliceStats,
    pairedBootstrap,
    allGoldGap,
    caseStudies,
    timingMs,
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      cpu: os.cpus()?.[0]?.model ?? "unknown",
      totalMemGB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    },
  };

  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, `${JSON.stringify(results, null, 2)}\n`);
  writeResultsMd(results, dataset, outMd);
  console.log(`results written: ${path.relative(ROOT, outJson)} + ${path.relative(ROOT, outMd)}`);
}

// ---- results.md ---------------------------------------------------------------

const METRIC_KEYS: Array<{ key: keyof RunMetrics; label: string }> = [
  { key: "top1", label: "Top-1" },
  { key: "recall5", label: "Recall@5" },
  { key: "recall10", label: "Recall@10" },
  { key: "allGoldAcc10", label: "AllGold Acc@10" },
  { key: "mrr", label: "MRR" },
];

function fmt(s: { mean: number; ciLow: number; ciHigh: number }): string {
  return `${s.mean.toFixed(3)} [${s.ciLow.toFixed(3)}, ${s.ciHigh.toFixed(3)}]`;
}

function writeResultsMd(results: ResultsFile, dataset: DatasetFile, outPath: string): void {
  const lines: string[] = [];
  lines.push(
    `# Retrieval Evaluation Results${results.split === "tuning" ? " — TUNING SPLIT" : ""}`,
  );
  lines.push("");
  lines.push(
    `Dataset hash \`${results.datasetHash}\` · ${results.tasks} tasks · seed ${results.seed} · split **${results.split}**${results.evalSplitRunsIncludingThis ? ` · eval-split run #${results.evalSplitRunsIncludingThis} this milestone` : ""} · OCC commit \`${results.occCommit.slice(0, 12)}\` · working tree clean at run start: ${results.workingTreeClean ? "yes" : "NO"}`,
  );
  lines.push("");
  lines.push("## Overall (mean [95% bootstrap CI], per task)");
  lines.push("");
  lines.push("| System | " + METRIC_KEYS.map((m) => m.label).join(" | ") + " |");
  lines.push("|---|" + METRIC_KEYS.map(() => "---").join("|") + "|");
  for (const system of SYSTEMS) {
    const summary = results.systems[system].overall;
    lines.push(`| ${system} | ` + METRIC_KEYS.map((m) => fmt(summary[m.key])).join(" | ") + " |");
  }
  lines.push("");
  const occ = results.systems.occ.packageStats;
  if (occ) {
    lines.push(
      `OCC generated package: mean ${occ.meanTokens.toFixed(0)} tokens, mean ${occ.meanFilesIncluded.toFixed(1)} files included per task.`,
    );
    lines.push("");
  }
  lines.push("## Source-only gold slice (OCC-fully-parsed gold)");
  lines.push("");
  const gs = results.goldSliceStats;
  lines.push(
    `Full gold: ${gs.full.goldFiles} gold files across ${gs.full.tasks} tasks. Source-only slice: ${gs.sourceOnly.goldFiles} gold files across ${gs.sourceOnly.tasks} tasks (${gs.sourceOnly.tasksExcludedEmpty} tasks excluded for an empty slice).`,
  );
  lines.push("");
  lines.push("| System | " + METRIC_KEYS.map((m) => m.label).join(" | ") + " |");
  lines.push("|---|" + METRIC_KEYS.map(() => "---").join("|") + "|");
  for (const system of SYSTEMS) {
    const summary = results.systems[system].overallSourceOnly;
    lines.push(`| ${system} | ` + METRIC_KEYS.map((m) => fmt(summary[m.key])).join(" | ") + " |");
  }
  lines.push("");
  lines.push("## Package recall (gold coverage of the delivered answer)");
  lines.push("");
  lines.push(
    "OCC = fraction of gold files inside the generated package (parsed from its `### FILE:` headings); baselines = Recall@8, matching OCC's mean package size.",
  );
  lines.push("");
  lines.push("| System | Package recall (mean [95% CI]) |");
  lines.push("|---|---|");
  for (const system of SYSTEMS) {
    lines.push(`| ${system} | ${fmt(results.systems[system].packageRecall)} |`);
  }
  lines.push("");
  lines.push("## Paired bootstrap: OCC − BM25 per-task differences");
  lines.push("");
  for (const slice of ["full", "sourceOnly"] as GoldSlice[]) {
    lines.push(`### ${slice === "full" ? "Full gold" : "Source-only slice"}`);
    lines.push("");
    lines.push("| Metric | Mean diff (OCC − BM25) [95% CI] | Excludes 0 |");
    lines.push("|---|---|---|");
    for (const key of PAIRED_METRIC_KEYS) {
      const d = results.pairedBootstrap[slice][key];
      lines.push(
        `| ${key} | ${d.meanDiff.toFixed(3)} [${d.ciLow.toFixed(3)}, ${d.ciHigh.toFixed(3)}] | ${d.excludesZero ? "**yes**" : "no"} |`,
      );
    }
    lines.push("");
  }
  lines.push("## All-gold gap analysis (BM25 all-gold in top 10, OCC not)");
  lines.push("");
  const gap = results.allGoldGap.summary;
  lines.push(
    `${gap.tasks} tasks, ${gap.missingFiles} missing gold files. Missing by type: ${
      Object.entries(gap.byType)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "none"
    }. Not in OCC's candidate set at all: ${gap.notInOccCandidates}. Median OCC rank of missing files: ${gap.occRankMedian ?? "n/a (none ranked)"}; median BM25 rank: ${gap.bm25RankMedian ?? "n/a"}.`,
  );
  for (const t of results.allGoldGap.tasks) {
    lines.push("");
    lines.push(`- **${t.id}**`);
    for (const m of t.missing) {
      lines.push(
        `  - ${m.path} (${m.type}): OCC rank ${m.occRank ?? "not in candidates"}, BM25 rank ${m.bm25Rank ?? "n/a"}`,
      );
    }
  }
  lines.push("");
  lines.push("## Per repository");
  for (const [repoId, entry] of (Object.entries(dataset.repos) as Array<[string, RepoEntry]>).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const s = entry.stats;
    lines.push("");
    lines.push(`### ${repoId} (pinned ${entry.pinnedCommit.slice(0, 12)}, ${entry.license})`);
    lines.push(
      `Mined ${s.mined}, accepted ${s.accepted}, sampled ${s.sampled}, evaluated ${s.evaluatedTasks}` +
        ` (dropped for empty effective gold: ${s.tasksDroppedEmptyGold}; tasks with partially dropped gold: ${s.tasksWithPartialGoldDrop}; gold files dropped by mode: symlink ${s.droppedGoldSymlink}, gitlink ${s.droppedGoldGitlink}, missing ${s.droppedGoldMissing}), duplicates ${s.duplicateTaskTextDropped}, non-localizable gold files excluded from accepted tasks: ${s.excludedNewFiles}. Top rejections: ${Object.entries(
          s.rejectedByReason,
        )
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, 5)
          .map(([r, n]) => `${r}=${n}`)
          .join(", ")}.`,
    );
    const ranHere = SYSTEMS.filter((system) => results.systems[system].perRepo[repoId]);
    if (ranHere.length === 0) {
      lines.push("(not included in this run)");
      continue;
    }
    lines.push("| System | " + METRIC_KEYS.map((m) => m.label).join(" | ") + " |");
    lines.push("|---|" + METRIC_KEYS.map(() => "---").join("|") + "|");
    for (const system of ranHere) {
      const summary = results.systems[system].perRepo[repoId];
      lines.push(`| ${system} | ` + METRIC_KEYS.map((m) => fmt(summary[m.key])).join(" | ") + " |");
    }
  }
  lines.push("");
  lines.push("## Case studies (OCC)");
  lines.push("");
  lines.push("### Worst 5 failures (lowest MRR)");
  for (const c of results.caseStudies.worst) {
    lines.push(...caseLines(c));
  }
  lines.push("");
  lines.push("### Best 5 successes (highest MRR)");
  for (const c of results.caseStudies.best) {
    lines.push(...caseLines(c));
  }
  lines.push("");
  lines.push("## Environment / timing (non-deterministic section)");
  lines.push("");
  lines.push(JSON.stringify(results.environment));
  lines.push("");
  lines.push(`timings (ms): ${JSON.stringify(results.timingMs)}`);
  fs.writeFileSync(outPath, `${lines.join("\n")}\n`);
}

function caseLines(c: CaseStudy): string[] {
  return [
    "",
    `- **${c.id}** — MRR ${c.mrr.toFixed(3)}, Recall@10 ${c.recall10.toFixed(3)}`,
    `  subject: ${c.subject}`,
    `  task: ${c.task.length > 300 ? `${c.task.slice(0, 300)}…` : c.task}`,
    `  gold: ${c.gold.join(", ")}`,
    `  top-ranked: ${c.topRanked.join(", ") || "(empty)"}`,
  ];
}

run();
