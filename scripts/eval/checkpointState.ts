/**
 * F11/review: extracted checkpoint lifecycle for the eval harness, so the
 * pending/completed transitions, torn-tail repair, and record validation are
 * unit-testable with disposable directories (the real holdout is never
 * consumed by tests).
 *
 * State model (explicit, fail-closed):
 * - "none":      no checkpoint exists — a fresh run.
 * - "pending":   manifest exists with status "pending" — an interrupted run
 *                may resume after identity verification.
 * - "completed": manifest exists with status "completed" — the experiment is
 *                finished; a second invocation is REJECTED even though an old
 *                manifest is still on disk (the original defect: manifest
 *                existence alone treated as "interrupted", letting a
 *                completed holdout rerun from zero records).
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type CheckpointStatus = "none" | "pending" | "completed";

export interface CheckpointManifest {
  identity: string;
  split: string;
  occCommit: string;
  /** Dirty-tree source fingerprint (diff + untracked content hash), if dirty. */
  sourceFingerprint?: string;
  status: "pending" | "completed";
  updatedAt: string;
}

export interface CheckpointState {
  status: CheckpointStatus;
  manifest?: CheckpointManifest;
  /** Identity mismatch between an existing manifest and the current run. */
  identityMismatch?: boolean;
}

export function checkpointPaths(
  stateDir: string,
  baseName: string,
): {
  recordsFile: string;
  manifestFile: string;
} {
  return {
    recordsFile: path.join(stateDir, `${baseName}.records.jsonl`),
    manifestFile: path.join(stateDir, `${baseName}.manifest.json`),
  };
}

export function readCheckpointState(
  manifestFile: string,
  expectedIdentity: string,
): CheckpointState {
  if (!fs.existsSync(manifestFile)) return { status: "none" };
  let manifest: CheckpointManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as CheckpointManifest;
  } catch (e) {
    throw new Error(`checkpoint manifest unreadable (${(e as Error).message}); delete it`);
  }
  return {
    status: manifest.status === "completed" ? "completed" : "pending",
    manifest,
    identityMismatch: manifest.identity !== expectedIdentity,
  };
}

export function writeCheckpointManifest(
  manifestFile: string,
  manifest: Omit<CheckpointManifest, "updatedAt" | "status"> & {
    status: "pending" | "completed";
  },
): void {
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  const full: CheckpointManifest = { ...manifest, updatedAt: new Date().toISOString() };
  fs.writeFileSync(manifestFile, `${JSON.stringify(full)}\n`);
}

/**
 * Repairs ONLY a recoverable trailing torn line before any append: the file
 * is rewritten without the incomplete record. Interior corruption is
 * rejected — the file is untrustworthy. Returns the number of valid records.
 * Without the rewrite, an append would JOIN the new record onto the torn
 * tail, and a subsequent resume could lose that task's record.
 */
export function truncateTornTail(recordsFile: string): number {
  if (!fs.existsSync(recordsFile)) return 0;
  const raw = fs.readFileSync(recordsFile, "utf8");
  const lines = raw.split(/\r?\n/);
  const lastContentIdx = lines.reduce((acc, l, i) => (l.trim() ? i : acc), -1);
  if (lastContentIdx === -1) return 0;
  let valid = 0;
  let tornAt = -1;
  for (let i = 0; i <= lastContentIdx; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    try {
      JSON.parse(line);
      valid++;
    } catch {
      if (i !== lastContentIdx) {
        throw new Error(`corrupt checkpoint line ${i + 1} in ${recordsFile}`);
      }
      tornAt = i;
    }
  }
  if (tornAt >= 0) {
    fs.writeFileSync(recordsFile, lines.slice(0, tornAt).join("\n") + "\n");
  }
  return valid;
}

/**
 * Validates checkpoint records: JSON per line, object shape with a string
 * `task`, duplicates rejected, and (when provided) membership in the
 * expected task list. Invalid data must never silently resume.
 */
export function validateCheckpointRecords(
  recordsFile: string,
  expectedTaskIds?: Set<string>,
): Array<{ task: string }> {
  if (!fs.existsSync(recordsFile)) return [];
  const raw = fs.readFileSync(recordsFile, "utf8");
  const lines = raw.split(/\r?\n/);
  const lastContentIdx = lines.reduce((acc, l, i) => (l.trim() ? i : acc), -1);
  const seen = new Set<string>();
  const records: Array<{ task: string }> = [];
  for (let i = 0; i <= lastContentIdx; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let c: unknown;
    try {
      c = JSON.parse(line);
    } catch {
      if (i !== lastContentIdx) {
        throw new Error(`corrupt checkpoint line ${i + 1} in ${recordsFile}`);
      }
      break; // trailing torn line: caller truncates before appending
    }
    if (typeof c !== "object" || c === null || typeof (c as { task?: unknown }).task !== "string") {
      throw new Error(`checkpoint line ${i + 1} has no task id`);
    }
    const task = (c as { task: string }).task;
    if (expectedTaskIds && !expectedTaskIds.has(task)) {
      throw new Error(`checkpoint line ${i + 1} references foreign task "${task}"`);
    }
    if (seen.has(task)) {
      throw new Error(`duplicate checkpoint record for task "${task}"`);
    }
    seen.add(task);
    records.push(c as { task: string });
  }
  return records;
}

/**
 * Review fix (F11 identity): the run identity previously bound only HEAD —
 * different experiments at the same commit could share checkpoints. The
 * source fingerprint binds dirty IMPLEMENTATION/CONFIGURATION/weight changes:
 * clean tree → "clean"; dirty tree → hash of `git status --porcelain` plus
 * the full `git diff HEAD` text. Parameterized cwd for testability.
 */
export function sourceFingerprint(
  runGit: (args: string[], cwd: string) => string,
  cwd: string,
): string {
  let status = "";
  try {
    status = runGit(["status", "--porcelain"], cwd);
  } catch {
    return "unknown";
  }
  if (status.trim().length === 0) return "clean";
  let diff = "";
  try {
    diff = runGit(["diff", "HEAD"], cwd);
  } catch {
    diff = "";
  }
  return `${status.trim().length}+${diff.length}:${hashText(status + "\u0000" + diff)}`;
}

function hashText(text: string): string {
  // Deterministic FNV-1a (no crypto import needed for a stability fingerprint).
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
