/**
 * Eval dataset builder (dev-time only; clones live in the git-ignored
 * .eval-cache/). For every repo in scripts/eval/repos.json it:
 *   1. ensures a full clone of the pinned branch in the cache (skips with a
 *      clear message when the network is unavailable),
 *   2. verifies the pinned commit exists,
 *   3. mines all non-merge commits with rename detection,
 *   4. runs the pure filter/dedup/sample pipeline (scripts/eval/dataset.ts),
 *   5. restricts gold to parent-tree regular files by git mode
 *      (symlinks/gitlinks excluded; identical dataset on every OS),
 *   6. writes one deterministic JSON dataset to docs/eval/dataset.json.
 *
 * The output is byte-stable for the same repos.json + code: no timestamps
 * or machine data are included (those live in results.json instead).
 *
 * Usage: npm run eval:build-dataset [-- [--tasks 40]]
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { applyModeGoldFilter, buildDataset, datasetHash, type DatasetStats } from "./eval/dataset";
import {
  ensureClone,
  lsTree,
  mineCommits,
  verifyPinnedCommit,
  type LsTreeEntry,
} from "./eval/gitminer";
import { isSourcePath as isSourcePathLike } from "./eval/lib";

interface RepoSpec {
  id: string;
  url: string;
  defaultBranch: string;
  pinnedCommit: string;
  license: string;
  note: string;
}

interface ReposConfig {
  seed: number;
  tasksPerRepo: number;
  repos: RepoSpec[];
}

// This CLI lives in <root>/scripts; the project root is its parent.
const ROOT = path.resolve(import.meta.dirname ?? path.join(process.cwd(), "scripts"), "..");
const REPOS_JSON = path.join(ROOT, "scripts", "eval", "repos.json");
const OUT_JSON = path.join(ROOT, "docs", "eval", "dataset.json");

function readArgs(): { tasksPerRepo: number } {
  const argv = process.argv.slice(2);
  let tasksPerRepo = 40;
  const i = argv.indexOf("--tasks");
  if (i >= 0 && argv[i + 1]) tasksPerRepo = parseInt(argv[i + 1]!, 10) || 40;
  return { tasksPerRepo };
}

/** Count of production TS/JS source files at the pinned snapshot (reporting only). */
function countSourceFiles(clonePath: string, pinnedCommit: string): number {
  const out = execFileSync("git", ["-C", clonePath, "ls-tree", "-r", "--name-only", pinnedCommit], {
    encoding: "utf8",
    timeout: 60000,
    stdio: "pipe",
  });
  return out.split(/\r?\n/).filter((line) => line.length > 0 && isSourcePathLike(line)).length;
}

async function main(): Promise<void> {
  const { tasksPerRepo } = readArgs();
  const config = JSON.parse(fs.readFileSync(REPOS_JSON, "utf8")) as ReposConfig;
  const perRepo: Record<
    string,
    {
      pinnedCommit: string;
      license: string;
      note: string;
      sourceFilesAtPin: number;
      stats: DatasetStats;
      datasetHash: string;
    }
  > = {};
  const allTasks = [];

  for (const repo of config.repos) {
    console.log(`[${repo.id}] ensuring clone of ${repo.url}…`);
    const { clonePath, fresh } = ensureClone(repo);
    if (fresh) console.log(`[${repo.id}] cloned into ${clonePath}`);
    try {
      verifyPinnedCommit(clonePath, repo.pinnedCommit);
    } catch (error) {
      console.warn(`[${repo.id}] SKIPPED: ${(error as Error).message}`);
      continue;
    }
    const sourceFilesAtPin = countSourceFiles(clonePath, repo.pinnedCommit);
    console.log(`[${repo.id}] mining history (source files at pin: ${sourceFilesAtPin})…`);
    const mined = mineCommits(clonePath);
    const built = buildDataset(repo.id, mined, tasksPerRepo, config.seed);
    // Effective gold: parent-tree regular files only. Symlinks and gitlinks
    // are excluded from gold (and from every indexed snapshot) by git tree
    // MODE, so the dataset is identical on Windows, macOS and Linux.
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
      sourceFilesAtPin,
      stats,
      datasetHash: datasetHash(filtered.tasks),
    };
    allTasks.push(...filtered.tasks);
    console.log(
      `[${repo.id}] mined=${stats.mined} accepted=${stats.accepted} sampled=${stats.sampled}` +
        ` evaluated=${stats.evaluatedTasks}` +
        ` (empty-gold dropped=${stats.tasksDroppedEmptyGold}` +
        `, partial-gold tasks=${stats.tasksWithPartialGoldDrop}` +
        `, gold files dropped: symlink=${stats.droppedGoldSymlink}` +
        ` gitlink=${stats.droppedGoldGitlink} missing=${stats.droppedGoldMissing})`,
    );
  }

  const dataset = {
    seed: config.seed,
    tasksPerRepo,
    datasetHash: datasetHash(allTasks),
    repos: perRepo,
    tasks: allTasks,
  };
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(dataset, null, 2)}\n`);
  console.log(
    `dataset written: ${OUT_JSON} (${allTasks.length} tasks, hash ${dataset.datasetHash})`,
  );
}

main().catch((error) => {
  console.error(`eval-build-dataset failed: ${(error as Error).message}`);
  process.exit(1);
});
