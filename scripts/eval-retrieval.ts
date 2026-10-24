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
 * Usage: npm run eval:retrieval [-- [--repos id1,id2]]
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

import { OccApplication } from "../src/application/contextService";
import { CancellationSource } from "../src/shared/cancellation";

import { bm25Baseline, filenameBaseline, randomBaseline, type Snapshot } from "./eval/baselines";
import { datasetHash, type DatasetStats, type DatasetTask } from "./eval/dataset";
import { cloneDirFor, materializeSnapshot, verifyPinnedCommit } from "./eval/gitminer";
import { aggregateRuns, taskMetrics, type RankedFile, type RunMetrics } from "./eval/metrics";
import { hashString } from "./eval/lib";

const ROOT = path.resolve(import.meta.dirname ?? path.join(process.cwd(), "scripts"), "..");
const REPOS_JSON = path.join(ROOT, "scripts", "eval", "repos.json");
const DATASET_JSON = path.join(ROOT, "docs", "eval", "dataset.json");
const RESULTS_JSON = path.join(ROOT, "docs", "eval", "results.json");
const RESULTS_MD = path.join(ROOT, "docs", "eval", "results.md");
const SCRATCH_ROOT = path.join(ROOT, ".eval-cache", "scratch");

const SEED = 20260918;
const RETRIEVE_LIMIT = 50;
// Baselines read file contents up to OCC's own scanner limit (1 MiB,
// src/workspace/workspaceScanner.ts) so every system ranks the same file
// universe; larger files exist in gold but are invisible to all systems
// equally rather than to the baselines only.
const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;

type SystemName = "occ" | "filename" | "bm25" | "random";
const SYSTEMS: SystemName[] = ["occ", "filename", "bm25", "random"];

interface ReposFile {
  seed: number;
  tasksPerRepo: number;
  repos: {
    id: string;
    url: string;
    defaultBranch: string;
    pinnedCommit: string;
    license: string;
    note: string;
  }[];
}

interface RepoEntry {
  pinnedCommit: string;
  license: string;
  note: string;
  sourceFilesAtPin: number;
  stats: DatasetStats;
  datasetHash: string;
}

interface DatasetFile {
  seed: number;
  tasksPerRepo: number;
  datasetHash: string;
  repos: Record<string, RepoEntry>;
  tasks: DatasetTask[];
}

interface SystemSummary {
  overall: RunMetrics;
  perRepo: Record<string, RunMetrics>;
  /** OCC only, from the generated context package. */
  packageStats?: { meanTokens: number; meanFilesIncluded: number };
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
  seed: number;
  /** OCC commit the run was executed from (captured at run start). */
  occCommit: string;
  /** True when `git status --porcelain` was empty when the run started. */
  workingTreeClean: boolean;
  datasetHash: string;
  tasks: number;
  systems: Record<SystemName, SystemSummary>;
  caseStudies: { worst: CaseStudy[]; best: CaseStudy[] };
  timingMs: { snapshotMs: number; indexMs: number; occMs: number; baselinesMs: number };
  environment: { node: string; platform: string; cpu: string; totalMemGB: number };
}

function argReposFilter(): string[] | undefined {
  const i = process.argv.indexOf("--repos");
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value ? value.split(",").filter((s) => s.length > 0) : undefined;
}

/** Reads every text file of the snapshot dir into an in-memory map. */
function readSnapshot(dir: string): Snapshot {
  const out: Snapshot = new Map();
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const name of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, name.name);
      if (name.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!name.isFile()) continue;
      const rel = path.relative(dir, full).replace(/\\/g, "/");
      try {
        if (fs.statSync(full).size > MAX_SNAPSHOT_FILE_BYTES) continue;
        out.set(rel, fs.readFileSync(full, "utf8"));
      } catch {
        /* unreadable file is simply not a snapshot candidate */
      }
    }
  }
  return out;
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

async function run(): Promise<void> {
  if (!fs.existsSync(DATASET_JSON)) {
    console.error(
      `Missing ${path.relative(ROOT, DATASET_JSON)} — build it first: npm run eval:build-dataset (needs network once).`,
    );
    process.exit(1);
  }
  const repos = JSON.parse(fs.readFileSync(REPOS_JSON, "utf8")) as ReposFile;
  const dataset = JSON.parse(fs.readFileSync(DATASET_JSON, "utf8")) as DatasetFile;
  if (dataset.datasetHash !== datasetHash(dataset.tasks)) {
    console.error(
      `Dataset hash mismatch in ${path.relative(ROOT, DATASET_JSON)} — it was edited or built with different code. Re-run eval:build-dataset.`,
    );
    process.exit(1);
  }

  const filter = argReposFilter();
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
      const context = app.buildContext("task", { taskText: t.task });
      const occRanking = (context.retrieval?.ranked ?? [])
        .slice(0, RETRIEVE_LIMIT)
        .map((r) => ({ path: r.path, score: r.score }));
      ranks.get("occ")!.set(t.id, occRanking);
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
  function summarize(name: SystemName, taskList: DatasetTask[]): RunMetrics {
    const map = ranks.get(name)!;
    return aggregateRuns(
      taskList.map((t) => taskMetrics(map.get(t.id) ?? [], t.gold)),
      SEED + hashString(name),
    );
  }

  const systems = {} as Record<SystemName, SystemSummary>;
  for (const name of SYSTEMS) {
    const perRepo: Record<string, RunMetrics> = {};
    for (const repoId of repoIds) {
      perRepo[repoId] = summarize(
        name,
        tasks.filter((t) => t.repoId === repoId),
      );
    }
    systems[name] = {
      overall: summarize(name, tasks),
      perRepo,
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
    seed: SEED,
    occCommit: occHeadCommit(),
    workingTreeClean: occWorkingTreeClean(),
    datasetHash: dataset.datasetHash,
    tasks: tasks.length,
    systems,
    caseStudies,
    timingMs,
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      cpu: os.cpus()?.[0]?.model ?? "unknown",
      totalMemGB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    },
  };

  fs.mkdirSync(path.dirname(RESULTS_JSON), { recursive: true });
  fs.writeFileSync(RESULTS_JSON, `${JSON.stringify(results, null, 2)}\n`);
  writeResultsMd(results, dataset);
  console.log(
    `results written: ${path.relative(ROOT, RESULTS_JSON)} + ${path.relative(ROOT, RESULTS_MD)}`,
  );
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

function writeResultsMd(results: ResultsFile, dataset: DatasetFile): void {
  const lines: string[] = [];
  lines.push("# Retrieval Evaluation Results");
  lines.push("");
  lines.push(
    `Dataset hash \`${results.datasetHash}\` · ${results.tasks} tasks · seed ${results.seed} · OCC commit \`${results.occCommit.slice(0, 12)}\` · working tree clean at run start: ${results.workingTreeClean ? "yes" : "NO"}`,
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
  fs.writeFileSync(RESULTS_MD, `${lines.join("\n")}\n`);
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
