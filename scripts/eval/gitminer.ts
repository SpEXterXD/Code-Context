/**
 * Git I/O for the dataset builder: reads commit history from a local clone.
 * NEVER mutates the user's repository — all operations run in the
 * git-ignored clone under .eval-cache/repos/<id>, and are read-only there
 * (log / cat-file / archive). The stream parsers are pure and exported so
 * gitminer.test.ts can pin their behavior without a real git binary.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { TouchedFile } from "./lib";

export interface MinedCommit {
  sha: string;
  /** Space-separated parent SHAs; single-parent commits have exactly one. */
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Committer timestamp (unix seconds). */
  committerTime: number;
  subject: string;
  body: string;
  files: TouchedFile[];
}

export const META_UNIT = "\u001f"; // field separator between fixed header fields
export const STACK_UNIT = "\u001d"; // boundary between hash header and subject/body
export const RECORD_UNIT = "\u001e"; // end of one commit's log record

const META_FORMAT = `%H${META_UNIT}%P${META_UNIT}%an${META_UNIT}%ae${META_UNIT}%ct${META_UNIT}${STACK_UNIT}%s${STACK_UNIT}%b${RECORD_UNIT}`;
// Record separator must PRECEDE the sha here: the per-commit name-status
// lines follow the format string, so each entry begins with its own record.
const FILES_FORMAT = `${RECORD_UNIT}%H`;

function runGit(clonePath: string, args: string[]): string {
  return execFileSync("git", ["-C", clonePath, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    timeout: 300000,
  });
}

/** Parses the `--format` metadata stream into commits keyed by sha. */
export function parseMetaStream(stream: string): Map<string, Omit<MinedCommit, "files">> {
  const out = new Map<string, Omit<MinedCommit, "files">>();
  for (const record of stream.split(RECORD_UNIT)) {
    if (record.trim().length === 0) continue;
    const fields = record.split(META_UNIT);
    if (fields.length < 6) continue;
    const [sha, parents, authorName, authorEmail, committerTime, rest] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const shaKey = sha.trim();
    const stackParts = rest.split(STACK_UNIT); // "", subject, body
    const subject = (stackParts[1] ?? "").trim();
    const body = (stackParts[2] ?? "").trim();
    out.set(shaKey, {
      sha: shaKey,
      parents: parents.trim().split(/\s+/).filter((p) => p.length > 0),
      authorName: authorName.trim(),
      authorEmail: authorEmail.trim(),
      committerTime: parseInt(committerTime.trim(), 10) || 0,
      subject,
      body,
    });
  }
  return out;
}

/** Parses the `--name-status` stream into TouchedFile lists keyed by sha. */
export function parseNameStatusStream(stream: string): Map<string, TouchedFile[]> {
  const out = new Map<string, TouchedFile[]>();
  for (const record of stream.split(RECORD_UNIT)) {
    const lines = record.split(/\r?\n/);
    const sha = (lines[0] ?? "").trim();
    if (sha.length === 0) continue;
    const files: TouchedFile[] = [];
    for (const line of lines.slice(1)) {
      if (line.trim().length === 0) continue;
      const parts = line.split("\t").filter((p) => p.length > 0);
      if (parts.length < 2) continue;
      const status = parts[0]!;
      const score = /^(?:R|C)(\d+)$/.exec(status);
      const base = score ? status.slice(0, 1) : status;
      if (base === "R" || base === "C") {
        if (parts.length < 3) continue;
        files.push({
          status: base,
          prePath: parts[1]!,
          postPath: parts[2]!,
          renameScore: score ? parseInt(score[1]!, 10) : undefined,
        });
      } else {
        files.push({ status: base, prePath: parts[1]!, postPath: parts[1]! });
      }
    }
    out.set(sha, files);
  }
  return out;
}

/** Mines the full merge-free history of one clone (read-only). */
export function mineCommits(clonePath: string): MinedCommit[] {
  const metaStream = runGit(clonePath, [
    "log",
    "--no-merges",
    `--format=${META_FORMAT}`,
  ]);
  const filesStream = runGit(clonePath, [
    "log",
    "--no-merges",
    "-M",
    "--name-status",
    `--format=${FILES_FORMAT}`,
  ]);
  const meta = parseMetaStream(metaStream);
  const files = parseNameStatusStream(filesStream);
  const merged: MinedCommit[] = [];
  for (const m of meta.values()) {
    merged.push({ ...m, files: files.get(m.sha) ?? [] });
  }
  merged.sort((a, b) => a.committerTime - b.committerTime || (a.sha < b.sha ? -1 : 1));
  return merged;
}

const REPO_CACHE_ROOT = path.resolve(process.cwd(), ".eval-cache", "repos");

/** Cache dir for one repo clone (git-ignored; cloned blobs end up here). */
export function cloneDirFor(repoId: string): string {
  return path.join(REPO_CACHE_ROOT, repoId);
}

export interface CloneSpec {
  id: string;
  url: string;
  defaultBranch: string;
}

export interface CloneResult {
  clonePath: string;
  fresh: boolean;
}

/**
 * Ensures a bare-worktree clone of the pinned branch exists under the
 * git-ignored cache. Dev-time only: never called from extension code. A
 * full (unfiltered) clone keeps every historical blob available offline,
 * which the eval harness needs to materialize parent snapshots.
 */
export function ensureClone(repo: CloneSpec): CloneResult {
  const dir = cloneDirFor(repo.id);
  try {
    if (fs.existsSync(path.join(dir, ".git"))) return { clonePath: dir, fresh: false };
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync(
      "git",
      ["clone", "--no-checkout", "--single-branch", `--branch=${repo.defaultBranch}`, repo.url, dir],
      { encoding: "utf8", timeout: 600000, stdio: "pipe" },
    );
    return { clonePath: dir, fresh: true };
  } catch (cause) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `Clone of ${repo.url} failed (missing network?) — skip by running with an existing cache under ${REPO_CACHE_ROOT}. Cause: ${String(cause)}`,
      { cause },
    );
  }
}

/**
 * Materializes a commit snapshot into a fresh directory via `git archive` +
 * `tar -xf` (both available on Windows and POSIX). Strictly read-only on the
 * clone; the scratch directory is wiped first.
 */
export function materializeSnapshot(
  clonePath: string,
  commit: string,
  scratchRoot: string,
  key: string,
): string {
  const outDir = path.join(scratchRoot, key);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const tarball = path.join(scratchRoot, `${key}.tar`);
  fs.rmSync(tarball, { force: true });
  try {
    execFileSync("git", ["-C", clonePath, "archive", "--format=tar", "--output", tarball, commit], {
      encoding: "utf8",
      timeout: 120000,
      stdio: "pipe",
    });
    execFileSync("tar", ["-xf", tarball, "-C", outDir], {
      encoding: "utf8",
      timeout: 120000,
      stdio: "pipe",
    });
  } catch (cause) {
    throw new Error(`Snapshot materialization failed for ${commit} in ${clonePath}: ${String(cause)}`, { cause });
  } finally {
    fs.rmSync(tarball, { force: true });
  }
  return outDir;
}

/** Confirms a clone exists and contains the pinned commit (read-only). */
export function verifyPinnedCommit(clonePath: string, pinnedCommit: string): void {
  if (!fs.existsSync(path.join(clonePath, ".git"))) {
    throw new Error(`No clone at ${clonePath}. Run eval:build-dataset once with network access.`);
  }
  try {
    runGit(clonePath, ["cat-file", "-e", `${pinnedCommit}^{commit}`]);
  } catch {
    throw new Error(`Clone at ${clonePath} does not contain pinned commit ${pinnedCommit}.`);
  }
}
