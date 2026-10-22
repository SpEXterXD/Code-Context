/**
 * Pure dataset assembly on top of lib.ts filters and gitminer output:
 * filter → dedupe identical task texts → time-split → seeded sample.
 * No git or network I/O here, so the whole builder is unit-testable.
 */
import { filterCommit, sampleEvalCommits, type CommitCandidateInput } from "./lib";
import type { MinedCommit } from "./gitminer";
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
  /** Pre-commit gold paths that exist in the parent snapshot, sorted. */
  gold: string[];
  /** Files touched by the commit that did not exist before it. */
  excludedNewFiles: number;
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
 * (tasksPerRepo, seed) ⇒ same tasks, always.
 */
export function buildDataset(
  repoId: string,
  mined: MinedCommit[],
  tasksPerRepo: number,
  seed: number,
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

  const { tuningHalf, evalPool, sampled } = sampleEvalCommits(deduped, tasksPerRepo, seed);

  const tasks: DatasetTask[] = sampled.map((c) => {
    return {
      id: `${repoId}:${c.sha.slice(0, 12)}`,
      repoId,
      sha: c.sha,
      parentSha: c.parentSha,
      task: c._task,
      gold: c._gold,
      excludedNewFiles: c._newFiles,
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
    },
  };
}

/** Deterministic dataset fingerprint (FNV-1a over the canonical task JSON). */
export function datasetHash(tasks: DatasetTask[]): string {
  return hashString(JSON.stringify(tasks.map((t) => [
    t.id, t.repoId, t.sha, t.parentSha, t.task, t.gold, t.excludedNewFiles,
  ])))
    .toString(16)
    .padStart(8, "0");
}
