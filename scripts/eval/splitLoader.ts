/**
 * Shared dataset loading for the eval harness CLIs: the eval split from
 * docs/eval/dataset.json (hash-verified) and the tuning split built in
 * memory from the pinned clones (earlier half of the time split). Extracted
 * from eval-retrieval.ts so diagnostics tools can consume the exact same
 * task sets without importing the runner (which executes on import).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import {
  applyModeGoldFilter,
  buildDataset,
  datasetHash,
  type DatasetStats,
  type DatasetTask,
} from "./dataset";
import { cloneDirFor, lsTree, mineCommits, verifyPinnedCommit, type LsTreeEntry } from "./gitminer";
import type { Snapshot } from "./baselines";

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), "..", "..");

export const REPOS_JSON = path.join(ROOT, "scripts", "eval", "repos.json");
export const DATASET_JSON = path.join(ROOT, "docs", "eval", "dataset.json");

export interface ReposFile {
  seed: number;
  tasksPerRepo: number;
  /** M3: separate sample size for the tuning split (defaults to tasksPerRepo). */
  tuningTasksPerRepo?: number;
  /** M3b: holdout draw size per repo (unsampled eval-half tasks). */
  holdoutTasksPerRepo?: number;
  repos: {
    id: string;
    url: string;
    defaultBranch: string;
    pinnedCommit: string;
    license: string;
    note: string;
  }[];
}

export interface RepoEntry {
  pinnedCommit: string;
  license: string;
  note: string;
  sourceFilesAtPin: number;
  stats: DatasetStats;
  datasetHash: string;
}

export interface DatasetFile {
  seed: number;
  tasksPerRepo: number;
  datasetHash: string;
  repos: Record<string, RepoEntry>;
  tasks: DatasetTask[];
}

/**
 * Baselines read file contents up to OCC's own scanner limit (1 MiB,
 * src/workspace/workspaceScanner.ts) so every system ranks the same file
 * universe.
 */
export const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;

/** Reads every text file of the snapshot dir into an in-memory map. */
export function readSnapshot(dir: string): Snapshot {
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

export function loadReposFile(): ReposFile {
  return JSON.parse(fs.readFileSync(REPOS_JSON, "utf8")) as ReposFile;
}

/** Loads and hash-verifies the eval-split dataset (docs/eval/dataset.json). */
export function loadEvalDataset(): DatasetFile {
  if (!fs.existsSync(DATASET_JSON)) {
    throw new Error(
      `Missing ${path.relative(ROOT, DATASET_JSON)} — build it first: npm run eval:build-dataset (needs network once).`,
    );
  }
  const dataset = JSON.parse(fs.readFileSync(DATASET_JSON, "utf8")) as DatasetFile;
  if (dataset.datasetHash !== datasetHash(dataset.tasks)) {
    throw new Error(
      `Dataset hash mismatch in ${path.relative(ROOT, DATASET_JSON)} — it was edited or built with different code. Re-run eval:build-dataset.`,
    );
  }
  return dataset;
}

/**
 * Builds the TUNING dataset in memory: mines each pinned clone, samples the
 * earlier half of the time split (buildDataset split="tuning"), applies the
 * same mode gold filter. Never reads or writes docs/eval/dataset.json.
 */
export function buildTuningDataset(repos: ReposFile, wanted: string[] | undefined): DatasetFile {
  const perRepo: Record<string, RepoEntry> = {};
  const allTasks: DatasetTask[] = [];
  for (const repo of repos.repos) {
    if (wanted && !wanted.includes(repo.id)) continue;
    const clonePath = cloneDirFor(repo.id);
    try {
      verifyPinnedCommit(clonePath, repo.pinnedCommit);
    } catch (error) {
      throw new Error(`[${repo.id}] ${(error as Error).message}`);
    }
    const built = buildDataset(
      repo.id,
      mineCommits(clonePath, repo.pinnedCommit),
      repos.tuningTasksPerRepo ?? repos.tasksPerRepo,
      repos.seed,
      "tuning",
    );
    const treeCache = new Map<string, LsTreeEntry[]>();
    const filtered = applyModeGoldFilter(built.tasks, (parentSha) => {
      let entries = treeCache.get(parentSha);
      if (!entries) {
        entries = lsTree(clonePath, parentSha);
        treeCache.set(parentSha, entries);
      }
      return entries;
    });
    const stats: DatasetStats = { ...built.stats, ...filtered.stats };
    perRepo[repo.id] = {
      pinnedCommit: repo.pinnedCommit,
      license: repo.license,
      note: repo.note,
      sourceFilesAtPin: 0,
      stats,
      datasetHash: datasetHash(filtered.tasks),
    };
    allTasks.push(...filtered.tasks);
    console.log(
      `[${repo.id}] TUNING half: sampled=${stats.sampled} evaluated=${stats.evaluatedTasks}` +
        ` (empty-gold dropped=${stats.tasksDroppedEmptyGold}, partial-gold tasks=${stats.tasksWithPartialGoldDrop})`,
    );
  }
  return {
    seed: repos.seed,
    tasksPerRepo: repos.tasksPerRepo,
    datasetHash: datasetHash(allTasks),
    repos: perRepo,
    tasks: allTasks,
  };
}

/**
 * M3b HOLDOUT. The intended fresh post-pin holdout was impossible: as of
 * 2026-10-25 the five upstreams had advanced only 0/0/1/1/6 non-merge
 * commits past the pins (fetched and verified). The implemented alternative:
 * UNSAMPLED eval-half tasks. The seeded sampler draws sequentially, so with
 * the same seed and pool its first `tasksPerRepo` distinct picks reproduce
 * the committed eval dataset exactly; picks tasksPerRepo+1..
 * tasksPerRepo+holdoutPerRepo are never-measured tasks from the same
 * filtered pool — disjoint from BOTH the eval sample (asserted against
 * docs/eval/dataset.json) and the tuning half (different half by
 * construction).
 */
export function buildHoldoutDataset(repos: ReposFile, wanted: string[] | undefined): DatasetFile {
  const evalDataset = loadEvalDataset();
  const evalIds = new Set(evalDataset.tasks.map((t) => t.id));
  const holdoutPerRepo = repos.holdoutTasksPerRepo ?? 60;
  const perRepo: Record<string, RepoEntry> = {};
  const allTasks: DatasetTask[] = [];
  for (const repo of repos.repos) {
    if (wanted && !wanted.includes(repo.id)) continue;
    const clonePath = cloneDirFor(repo.id);
    try {
      verifyPinnedCommit(clonePath, repo.pinnedCommit);
    } catch (error) {
      throw new Error(`[${repo.id}] ${(error as Error).message}`);
    }
    // Draw the eval sample PLUS the holdout in one deterministic stream.
    // The sampler draws sequentially, so the tasksPerRepo-task draw is a
    // SUBSET of the (tasksPerRepo + holdoutPerRepo) draw (verified below);
    // the holdout is the remainder — unsampled by construction.
    const drawCount = repos.tasksPerRepo + holdoutPerRepo;
    const built = buildDataset(
      repo.id,
      mineCommits(clonePath, repo.pinnedCommit),
      drawCount,
      repos.seed,
      "eval",
    );
    const drawnIds = new Set(built.tasks.map((t) => t.id));
    const repoEvalIds = [...evalIds].filter((id) => id.startsWith(`${repo.id}:`));
    const missing = repoEvalIds.filter((id) => !drawnIds.has(id));
    if (missing.length > 0) {
      throw new Error(
        `[${repo.id}] holdout draw does not contain the committed eval sample (${missing.length} missing, e.g. ${missing[0]}) — sampler drift; refusing to continue`,
      );
    }
    const holdoutSample = built.tasks.filter((t) => !evalIds.has(t.id));
    if (holdoutSample.length < Math.min(holdoutPerRepo, built.tasks.length - repoEvalIds.length)) {
      throw new Error(`[BUG] holdout draw for ${repo.id} unexpectedly short`);
    }
    const treeCache = new Map<string, LsTreeEntry[]>();
    const filtered = applyModeGoldFilter(holdoutSample, (parentSha) => {
      let entries = treeCache.get(parentSha);
      if (!entries) {
        entries = lsTree(clonePath, parentSha);
        treeCache.set(parentSha, entries);
      }
      return entries;
    });
    const stats: DatasetStats = {
      ...built.stats,
      sampled: holdoutSample.length,
      evaluatedTasks: filtered.tasks.length,
    };
    perRepo[repo.id] = {
      pinnedCommit: repo.pinnedCommit,
      license: repo.license,
      note: repo.note,
      sourceFilesAtPin: 0,
      stats,
      datasetHash: datasetHash(filtered.tasks),
    };
    allTasks.push(...filtered.tasks);
    console.log(
      `[${repo.id}] HOLDOUT (unsampled eval-half): drew=${drawCount}, holdout=${holdoutSample.length}, evaluated=${filtered.tasks.length}, disjoint-from-eval=verified`,
    );
  }
  return {
    seed: repos.seed,
    tasksPerRepo: holdoutPerRepo,
    datasetHash: datasetHash(allTasks),
    repos: perRepo,
    tasks: allTasks,
  };
}
