/**
 * Git I/O for the dataset builder: reads commit history from a local clone.
 * NEVER mutates the user's repository — all operations run in the
 * git-ignored clone under .eval-cache/repos/<id>, and are read-only there
 * (log / cat-file / ls-tree; snapshot materialization writes only to the
 * scratch dir via a temporary GIT_INDEX_FILE). The stream parsers are pure
 * and exported so gitminer.test.ts can pin their behavior without a real
 * git binary.
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

// ---------------------------------------------------------------------------
// ls-tree: the platform-independent file universe of a commit
// ---------------------------------------------------------------------------

/** One entry of `git ls-tree -r <commit>` (a path plus its git mode). */
export interface LsTreeEntry {
  /** Git object mode: 100644/100755 regular file, 120000 symlink, 160000 gitlink. */
  mode: string;
  /** Git object type: "blob" for files and symlinks, "commit" for gitlinks. */
  type: string;
  sha: string;
  path: string;
}

/** Modes that denote a regular, materializable file. Everything else is excluded. */
export function isRegularFileMode(mode: string): boolean {
  return mode === "100644" || mode === "100755";
}

/**
 * Parses `git ls-tree -r -z <commit>` output: NUL-separated records of
 * `<mode> SP <type> SP <sha> TAB <path>`. With -z, paths are raw (never
 * quoted), so filenames with spaces or non-ASCII survive intact.
 */
export function parseLsTreeStream(stream: string): LsTreeEntry[] {
  const out: LsTreeEntry[] = [];
  for (const record of stream.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const head = record.slice(0, tab).split(" ");
    if (head.length < 3) continue;
    out.push({ mode: head[0]!, type: head[1]!, sha: head[2]!, path: record.slice(tab + 1) });
  }
  return out;
}

/** Lists the full recursive tree of one commit (read-only on the clone). */
export function lsTree(clonePath: string, commit: string): LsTreeEntry[] {
  return parseLsTreeStream(runGit(clonePath, ["ls-tree", "-r", "-z", commit]));
}

export interface RunGitOptions {
  /** Extra environment (merged over process.env), e.g. GIT_INDEX_FILE. */
  env?: NodeJS.ProcessEnv;
  /** Stdin for commands that read paths via `--stdin`. */
  input?: string;
}

function runGit(clonePath: string, args: string[], options: RunGitOptions = {}): string {
  return execFileSync("git", ["-C", clonePath, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    timeout: 300000,
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
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
      parents: parents
        .trim()
        .split(/\s+/)
        .filter((p) => p.length > 0),
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

/**
 * Mines the merge-free history of one clone, bounded by `ref` (the pinned
 * commit) — read-only. Bounding at the pin makes the dataset a pure function
 * of repos.json: a clone taken later sees new upstream commits, but history
 * below the immutable pin is identical, so the mined set never drifts.
 */
export function mineCommits(clonePath: string, ref?: string): MinedCommit[] {
  const range = ref ? [ref] : [];
  const metaStream = runGit(clonePath, ["log", "--no-merges", ...range, `--format=${META_FORMAT}`]);
  const filesStream = runGit(clonePath, [
    "log",
    "--no-merges",
    "-M",
    "--name-status",
    ...range,
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
    if (fs.existsSync(path.join(dir, ".git"))) {
      // Partial clones (promisor/blob:none) lazily fetch blobs over the
      // network at snapshot time — one transient failure kills a whole run,
      // so refuse them loudly instead of failing 90 minutes in.
      // (git config --get exits 1 for unset keys = healthy full clone.)
      let promisor = "";
      try {
        promisor = execFileSync("git", ["-C", dir, "config", "--get", "remote.origin.promisor"], {
          encoding: "utf8",
          stdio: "pipe",
        }).trim();
      } catch {
        /* unset: full clone */
      }
      if (promisor === "true") {
        throw new Error(
          `Clone at ${dir} is a PARTIAL clone (promisor=true). Delete it and re-run to get a full clone: snapshots must never need the network.`,
        );
      }
      return { clonePath: dir, fresh: false };
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync(
      "git",
      [
        "clone",
        "--no-checkout",
        "--single-branch",
        `--branch=${repo.defaultBranch}`,
        repo.url,
        dir,
      ],
      { encoding: "utf8", timeout: 600000, stdio: "pipe" },
    );
    return { clonePath: dir, fresh: true };
  } catch (cause) {
    if (!fs.existsSync(path.join(dir, ".git"))) fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `Clone of ${repo.url} failed (missing network?) — skip by running with an existing cache under ${REPO_CACHE_ROOT}. Cause: ${String(cause)}`,
      { cause },
    );
  }
}

/** Deterministic-materialization git flags, forced on every plumbing call. */
const SNAPSHOT_GIT_FLAGS = [
  "-c",
  "core.symlinks=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
  // Never spend eval time auto-gc'ing the cache clone (objects are read-only
  // here; packing is dev-time cache maintenance).
  "-c",
  "gc.auto=0",
] as const;

/**
 * Materializes a commit snapshot into a fresh directory using git plumbing
 * only (no tar): a temporary index (GIT_INDEX_FILE, never the clone's own
 * index) is populated from the commit tree with `read-tree`, every
 * non-regular-file entry — symlinks (mode 120000) and gitlinks/submodules
 * (mode 160000) — is dropped from that index with `update-index
 * --force-remove`, and `checkout-index -a` writes exactly the remaining
 * regular files under the target prefix. Because the file universe is
 * decided by tree MODES (git metadata) rather than by what a filesystem can
 * create, and because core.autocrlf/core.eol/core.symlinks are forced, the
 * on-disk result is identical on Windows, macOS and Linux.
 */
export function materializeSnapshot(
  clonePath: string,
  commit: string,
  scratchRoot: string,
  key: string,
): string {
  const outDir = path.join(scratchRoot, key);
  const tmpIndex = path.join(scratchRoot, `${key}.index`);
  fs.mkdirSync(scratchRoot, { recursive: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(tmpIndex, { force: true });
  try {
    const git = (args: string[], options: RunGitOptions = {}) =>
      runGit(clonePath, [...SNAPSHOT_GIT_FLAGS, ...args], {
        ...options,
        env: { ...options.env, GIT_INDEX_FILE: tmpIndex },
      });
    git(["read-tree", commit]);
    const nonFiles = lsTree(clonePath, commit).filter((e) => !isRegularFileMode(e.mode));
    if (nonFiles.length > 0) {
      git(["update-index", "-z", "--force-remove", "--stdin"], {
        input: `${nonFiles.map((e) => e.path).join("\0")}\0`,
      });
    }
    // checkout-index concatenates the prefix with each index path; git on
    // Windows accepts forward-slash absolute prefixes natively.
    git(["checkout-index", "-a", `--prefix=${outDir.split(path.sep).join("/")}/`]);
  } catch (cause) {
    fs.rmSync(outDir, { recursive: true, force: true });
    const detail =
      cause && typeof cause === "object" && "stderr" in cause
        ? `stderr=${String((cause as { stderr?: unknown }).stderr).slice(0, 300)}`
        : "";
    throw new Error(
      `Snapshot materialization failed for ${commit} in ${clonePath}: ${String(cause)} ${detail}`,
      { cause },
    );
  } finally {
    fs.rmSync(tmpIndex, { force: true });
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
