import * as fs from "node:fs";
import * as path from "node:path";

import { safeGit } from "../git/safeGit";

import {
  applyFloodControl,
  emptySeedSet,
  normalizeSeedSet,
  type ChangedPath,
  type SeedSet,
} from "./seedSet";

/**
 * M4: collects working-tree seeds through the hardened safeGit helper —
 * the ONLY git path for seeds, trust-gated by the extension layer (the
 * caller simply does not invoke this in untrusted workspaces).
 *
 * Diffs are collected with `--no-ext-diff --no-textconv` (repo-configured
 * external diff drivers and textconv filters are arbitrary-command
 * execution vectors — see docs/adr/006 and eval:seed-hazard-repro).
 * Sensitive-path BLOCK rules are applied via the `isBlockedPath` predicate
 * BEFORE any diff content is read: blocked paths stay path-only.
 */
export interface SeedCollectorOptions {
  maxPaths: number;
  /** Per-file diff cap (bytes, truncated at a line boundary). */
  maxDiffBytesPerFile: number;
  /** Untracked files up to this size render as add-diffs read from disk. */
  maxUntrackedContentBytes: number;
  /** Sensitive-path veto — applied before any diff content is read. */
  isBlockedPath: (relPath: string) => boolean;
  /** Extra path exclusion (git-ignored paths), before the cap. */
  isExcludedPath?: (relPath: string) => boolean;
}

export interface SeedCollectorResult {
  seedSet: SeedSet;
  /** Set when git itself was unavailable (no repo, timeout, ...) — the
   * caller shows a status note; the seed set is empty, not partial. */
  unavailableReason?: string;
}

interface StatusEntry {
  x: string;
  y: string;
  path: string;
  origPath?: string;
}

/** Pure `status --porcelain=v1 -z` parser (unit-tested). */
export function parseStatusZ(stdout: string): StatusEntry[] {
  const out: StatusEntry[] = [];
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!;
    if (entry.length < 4) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    const p = entry.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const orig = tokens[++i] ?? "";
      out.push({ x, y, path: p, origPath: orig });
    } else {
      out.push({ x, y, path: p });
    }
  }
  return out;
}

function stateOf(e: StatusEntry): ChangedPath["state"] {
  if (e.x === "?" && e.y === "?") return "untracked";
  if (e.x === "D" || e.y === "D") return "deleted";
  // Rename/copy or index modification: staged; worktree-only: unstaged.
  if (e.x !== " " && e.x !== "?") return "staged";
  return "unstaged";
}

function mergeOrRebaseInProgress(rootPath: string): string | null {
  const gitDir = path.join(rootPath, ".git");
  if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) return "merge in progress";
  if (
    fs.existsSync(path.join(gitDir, "rebase-merge")) ||
    fs.existsSync(path.join(gitDir, "rebase-apply"))
  ) {
    return "rebase in progress";
  }
  // Worktree checkouts keep .git as a file pointing at the real gitdir.
  try {
    if (fs.statSync(gitDir).isFile()) {
      const target = fs.readFileSync(gitDir, "utf8").trim();
      const m = /^gitdir:\s*(.+)$/.exec(target);
      if (m) {
        const real = m[1]!;
        if (fs.existsSync(path.join(real, "MERGE_HEAD"))) return "merge in progress";
        if (
          fs.existsSync(path.join(real, "rebase-merge")) ||
          fs.existsSync(path.join(real, "rebase-apply"))
        ) {
          return "rebase in progress";
        }
      }
    }
  } catch {
    /* unreadable .git: no note */
  }
  return null;
}

function truncateAtLineBoundary(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  const cut = buf.subarray(0, maxBytes).toString("utf8");
  const lastNl = cut.lastIndexOf("\n");
  return {
    text: lastNl > 0 ? cut.slice(0, lastNl + 1) : cut,
    truncated: true,
  };
}

export async function collectGitSeeds(
  rootPath: string,
  options: SeedCollectorOptions,
): Promise<SeedCollectorResult> {
  const seedSet = emptySeedSet();
  const note = mergeOrRebaseInProgress(rootPath);
  if (note) seedSet.notes.push(note);

  let statusOut: string;
  try {
    ({ stdout: statusOut } = await safeGit({
      cwd: rootPath,
      args: ["status", "--porcelain=v1", "-z"],
      timeoutMs: 15000,
    }));
  } catch (error) {
    return {
      seedSet: emptySeedSet(),
      unavailableReason: `git status failed: ${(error as Error).message.slice(0, 80)}`,
    };
  }

  const entries = parseStatusZ(statusOut);
  const changed: ChangedPath[] = [];
  for (const e of entries) {
    const state = stateOf(e);
    changed.push({ path: e.path.replace(/\\/g, "/"), state });
    if (e.origPath !== undefined) {
      changed.push({ path: e.origPath.replace(/\\/g, "/"), state });
    }
  }
  const { kept, droppedCount } = applyFloodControl(changed, {
    maxPaths: options.maxPaths,
    isExcluded: options.isExcludedPath,
  });
  seedSet.changedPaths = kept;
  if (droppedCount > 0) {
    seedSet.notes.push(`${droppedCount} changed path(s) excluded (cap/filters)`);
  }

  // Diff content — AFTER the sensitive-path veto; blocked paths never read.
  let truncatedAny = false;
  for (const cp of kept) {
    if (cp.state === "deleted" || options.isBlockedPath(cp.path)) continue;
    const cached = cp.state === "staged";
    try {
      const { stdout } = await safeGit({
        cwd: rootPath,
        args: [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          ...(cached ? ["--cached"] : []),
          "--",
          cp.path,
        ],
        timeoutMs: 15000,
        maxBufferBytes: 32 * 1024 * 1024,
      });
      if (stdout.trim().length > 0) {
        const t = truncateAtLineBoundary(stdout, options.maxDiffBytesPerFile);
        truncatedAny = truncatedAny || t.truncated;
        seedSet.diffSections.push({ path: cp.path, diff: t.text });
        continue;
      }
      // No diff output (e.g. untracked file): render small untracked files
      // as add-diffs read from disk.
      if (cp.state === "untracked") {
        const abs = path.join(rootPath, cp.path);
        const stat = fs.statSync(abs, { throwIfNoEntry: false });
        if (stat?.isFile() && stat.size <= options.maxUntrackedContentBytes) {
          const content = fs.readFileSync(abs, "utf8");
          if (!content.includes("\0")) {
            seedSet.diffSections.push({
              path: cp.path,
              diff: content
                .split("\n")
                .map((l) => `+${l}`)
                .join("\n"),
            });
          }
        }
      }
    } catch {
      // unreadable or oversized diff: path-only seed, never fatal
    }
  }
  if (truncatedAny) {
    seedSet.notes.push("diff content truncated (size cap)");
  }
  return { seedSet: normalizeSeedSet({ ...seedSet, changedPaths: kept }) };
}
