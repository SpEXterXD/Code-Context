/**
 * Pure dataset assembly on top of lib.ts filters and gitminer output:
 * filter → dedupe identical task texts → time-split → seeded sample.
 * No git or network I/O here, so the whole builder is unit-testable.
 */
import { filterCommit, sampleEvalCommits, type CommitCandidateInput } from "./lib";
import type { LsTreeEntry, MinedCommit } from "./gitminer";
import { hashString } from "./lib";

export interface DatasetTask {
  /** Stable task id: "<repoId>:<short-sha>". */
  id: string;
  repoId: string;
  sha: string;
  /** Parent commit: the snapshot the task is evaluated against. */
  parentSha: string;
  /** Cleaned natural-language task text (commit subject + body). */
  task: string;
  /**
   * Effective gold: pre-commit gold paths that exist in the parent snapshot
   * AND are regular files (git mode 100644/100755) there, sorted. Symlink
   * (120000) and gitlink (160000) gold is excluded via excludedModeFiles.
   */
  gold: string[];
  /** Files touched by the commit that did not exist before it. */
  excludedNewFiles: number;
  /** Gold paths dropped because the parent tree lists a non-regular mode. */
  excludedModeFiles: string[];
  committerTime: number;
  /** Original commit subject, kept for reports. */
  subject: string;
}

export interface DatasetStats {
  /** Total non-merge commits mined (before filtering). */
  mined: number;
  /** Accepted candidate commits. */
  accepted: number;
  /** Dropped as duplicate task texts within this repo. */
  duplicateTaskTextDropped: number;
  /** Sampled for the eval set. */
  sampled: number;
  /** Count per machine-readable FilterReason from lib.filterCommit. */
  rejectedByReason: Record<string, number>;
  /** Sum of non-localizable gold files across ACCEPTED tasks. */
  excludedNewFiles: number;
  /** Pool from which sampling happens (later time half). */
  evalPoolSize: number;
  tuningHalfSize: number;
  // ---- mode-based gold filter (applyModeGoldFilter; set by the builder CLI) --
  /** Sampled tasks that survive the mode filter (effective gold non-empty). */
  evaluatedTasks: number;
  /** Sampled tasks dropped because their entire gold was non-regular-mode. */
  tasksDroppedEmptyGold: number;
  /** Tasks keeping SOME gold while some gold paths were dropped by mode. */
  tasksWithPartialGoldDrop: number;
  /** Gold files dropped because the parent tree lists them as symlinks. */
  droppedGoldSymlink: number;
  /** Gold files dropped because the parent tree lists them as gitlinks. */
  droppedGoldGitlink: number;
  /** Gold files absent from the parent tree listing (expected: 0). */
  droppedGoldMissing: number;
}

export interface BuiltDataset {
  tasks: DatasetTask[];
  stats: DatasetStats;
}

/** lib.filterCommit's verdict plus the mined metadata we need downstream. */
interface EvalCandidate extends CommitCandidateInput {
  committerTime: number;
  /** Parent sha (mined). */
  parentSha: string;
  _task: string;
  _gold: string[];
  _newFiles: number;
}

/**
 * Builds a deterministic per-repo dataset. Same mined commits + same
 * (tasksPerRepo, seed, split) ⇒ same tasks, always. With split="tuning" the
 * sample is drawn from the EARLIER half of the time split, so tuning runs
 * never touch the eval-half tasks.
 */
export function buildDataset(
  repoId: string,
  mined: MinedCommit[],
  tasksPerRepo: number,
  seed: number,
  /** Which half of the time split to sample from; default is the eval half. */
  split: "eval" | "tuning" = "eval",
): BuiltDataset {
  const rejectedByReason: Record<string, number> = {};
  const candidates: EvalCandidate[] = [];
  let excludedNewFiles = 0;
  for (const commit of mined) {
    const verdict = filterCommit({
      sha: commit.sha,
      parentCount: commit.parents.length,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      subject: commit.subject,
      body: commit.body,
      files: commit.files,
    });
    if (verdict.ok) {
      candidates.push({
        sha: commit.sha,
        parentCount: commit.parents.length,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        subject: commit.subject,
        body: commit.body,
        files: commit.files,
        committerTime: commit.committerTime,
        parentSha: commit.parents[0] ?? "",
        _task: verdict.task ?? "",
        _gold: verdict.gold ?? [],
        _newFiles: verdict.excludedNewFiles ?? 0,
      });
      excludedNewFiles += verdict.excludedNewFiles ?? 0;
    } else {
      const reason = verdict.reason ?? "unknown";
      rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + 1;
    }
  }

  // Drop identical task texts within a repo (typo-fix commits that repeat
  // "docs: fix typo" thousands of times): keep the earliest by commit order.
  const byText = new Map<string, EvalCandidate>();
  for (const c of candidates) {
    const prev = byText.get(c._task);
    if (prev && prev.committerTime <= c.committerTime) continue;
    byText.set(c._task, c);
  }
  const deduped = [...byText.values()].sort(
    (a, b) => a.committerTime - b.committerTime || (a.sha < b.sha ? -1 : 1),
  );
  const duplicateTaskTextDropped = candidates.length - deduped.length;

  const { tuningHalf, evalPool, sampled } = sampleEvalCommits(
    deduped,
    tasksPerRepo,
    seed,
    split === "tuning" ? "tuningHalf" : "evalPool",
  );

  const tasks: DatasetTask[] = sampled.map((c) => {
    return {
      id: `${repoId}:${c.sha.slice(0, 12)}`,
      repoId,
      sha: c.sha,
      parentSha: c.parentSha,
      task: c._task,
      gold: c._gold,
      excludedNewFiles: c._newFiles,
      excludedModeFiles: [],
      committerTime: c.committerTime,
      subject: c.subject,
    };
  });
  tasks.sort((a, b) => a.committerTime - b.committerTime || (a.sha < b.sha ? -1 : 1));

  return {
    tasks,
    stats: {
      mined: mined.length,
      accepted: candidates.length,
      duplicateTaskTextDropped,
      sampled: tasks.length,
      rejectedByReason,
      excludedNewFiles,
      evalPoolSize: evalPool.length,
      tuningHalfSize: tuningHalf.length,
      evaluatedTasks: tasks.length,
      tasksDroppedEmptyGold: 0,
      tasksWithPartialGoldDrop: 0,
      droppedGoldSymlink: 0,
      droppedGoldGitlink: 0,
      droppedGoldMissing: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Mode-based gold filtering (platform-independent file universe)
// ---------------------------------------------------------------------------

const SYMLINK_MODE = "120000";
const GITLINK_MODE = "160000";
const TS_JS_GOLD_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;

/** Resolves the recursive ls-tree listing of a parent commit. */
export type ParentTreeLookup = (parentSha: string) => LsTreeEntry[];

export interface ModeGoldStats {
  evaluatedTasks: number;
  tasksDroppedEmptyGold: number;
  tasksWithPartialGoldDrop: number;
  droppedGoldSymlink: number;
  droppedGoldGitlink: number;
  droppedGoldMissing: number;
}

/**
 * Restricts every task's gold to the parent tree's REGULAR files (git modes
 * 100644/100755). Symlink (120000) and gitlink (160000) gold is dropped and
 * counted — such files are excluded from the indexed snapshot on every
 * platform, so keeping them in gold would be unanswerable. A task whose
 * effective gold becomes empty is excluded from the dataset (counted).
 * Hard stop: a dropped gold file that is itself TS/JS is a harness bug or a
 * pinned-repo oddity we refuse to silently absorb, so it throws.
 *
 * Pure given the lookup, so the same mined data + trees always produce the
 * same dataset regardless of OS.
 */
export function applyModeGoldFilter(
  tasks: DatasetTask[],
  lookup: ParentTreeLookup,
): { tasks: DatasetTask[]; stats: ModeGoldStats } {
  const stats: ModeGoldStats = {
    evaluatedTasks: 0,
    tasksDroppedEmptyGold: 0,
    tasksWithPartialGoldDrop: 0,
    droppedGoldSymlink: 0,
    droppedGoldGitlink: 0,
    droppedGoldMissing: 0,
  };
  const treesByParent = new Map<string, Map<string, LsTreeEntry>>();
  const treeFor = (parentSha: string): Map<string, LsTreeEntry> => {
    let tree = treesByParent.get(parentSha);
    if (!tree) {
      tree = new Map(lookup(parentSha).map((e) => [e.path, e]));
      treesByParent.set(parentSha, tree);
    }
    return tree;
  };

  const kept: DatasetTask[] = [];
  for (const task of tasks) {
    const tree = treeFor(task.parentSha);
    const gold: string[] = [];
    const excludedModeFiles: string[] = [];
    let symlinkDrops = 0;
    let gitlinkDrops = 0;
    let missingDrops = 0;
    for (const p of task.gold) {
      const entry = tree.get(p);
      if (entry && (entry.mode === "100644" || entry.mode === "100755")) {
        gold.push(p);
        continue;
      }
      excludedModeFiles.push(p);
      if (!entry) missingDrops++;
      else if (entry.mode === SYMLINK_MODE) symlinkDrops++;
      else if (entry.mode === GITLINK_MODE) gitlinkDrops++;
      else missingDrops++; // unknown mode: treat as not materializable
    }
    if (excludedModeFiles.some((p) => TS_JS_GOLD_RE.test(p))) {
      throw new Error(
        `refusing to drop TS/JS gold by mode for ${task.id}: ${excludedModeFiles
          .filter((p) => TS_JS_GOLD_RE.test(p))
          .join(", ")}`,
      );
    }
    stats.droppedGoldSymlink += symlinkDrops;
    stats.droppedGoldGitlink += gitlinkDrops;
    stats.droppedGoldMissing += missingDrops;
    if (gold.length === 0) {
      stats.tasksDroppedEmptyGold++;
      continue;
    }
    if (excludedModeFiles.length > 0) stats.tasksWithPartialGoldDrop++;
    kept.push({
      ...task,
      gold: gold.sort(),
      excludedModeFiles: excludedModeFiles.sort(),
    });
    stats.evaluatedTasks++;
  }
  return { tasks: kept, stats };
}

/** Deterministic dataset fingerprint (FNV-1a over the canonical task JSON). */
export function datasetHash(tasks: DatasetTask[]): string {
  return hashString(
    JSON.stringify(
      tasks.map((t) => [
        t.id,
        t.repoId,
        t.sha,
        t.parentSha,
        t.task,
        t.gold,
        t.excludedNewFiles,
        t.excludedModeFiles,
      ]),
    ),
  )
    .toString(16)
    .padStart(8, "0");
}
