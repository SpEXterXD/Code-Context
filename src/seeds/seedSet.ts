import { compareStrings } from "../shared/text";

/**
 * M4 change-aware seeds: plain-data seed set assembled by the extension
 * layer (or the eval harness). The domain never imports vscode — the
 * extension translates editor state into this shape.
 */

export type ChangedState = "staged" | "unstaged" | "untracked" | "deleted";

export interface ChangedPath {
  path: string;
  state: ChangedState;
}

export interface DiffSection {
  path: string;
  diff: string;
}

export interface SeedSet {
  changedPaths: ChangedPath[];
  diffSections: DiffSection[];
  openEditors: { path: string; active: boolean }[];
  selection?: { path: string; startLine: number; endLine: number };
  selectionSymbol?: string;
  diagnostics: { path: string; message: string }[];
  /** Visible-to-user notes (merge/rebase in progress, truncations, ...). */
  notes: string[];
}

export function emptySeedSet(): SeedSet {
  return { changedPaths: [], diffSections: [], openEditors: [], diagnostics: [], notes: [] };
}

export const MAX_OPEN_EDITORS = 10;
export const MAX_DIAGNOSTICS = 20;

/** State priority for flood control: lower sorts first. */
const STATE_PRIORITY: Record<ChangedState, number> = {
  staged: 0,
  unstaged: 1,
  untracked: 2,
  deleted: 3,
};

const GENERATED_RE =
  /(^|\/)(?:dist|build|out|coverage|node_modules|\.next|\.nuxt|\.turbo)(?:\/|$)|\.(?:min\.js|min\.css|js\.map|css\.map)$/i;

const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "deno.lock",
  "go.sum",
  "poetry.lock",
  "cargo.lock",
]);

/** Generated/lockfile artifacts are never seeds (noise, not intent). */
export function isGeneratedOrLockfilePath(p: string): boolean {
  const lower = p.replace(/\\/g, "/").toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  return GENERATED_RE.test(lower) || LOCKFILE_BASENAMES.has(base);
}

export interface FloodControlOptions {
  maxPaths: number;
  /** Extra exclusion predicate (e.g. git-ignored paths), applied before the cap. */
  isExcluded?: (path: string) => boolean;
}

export interface FloodControlResult {
  kept: ChangedPath[];
  droppedCount: number;
  droppedExcluded: number;
}

/**
 * Deterministic flood control: exclude lockfiles/generated/ignored paths,
 * order by state priority (staged, unstaged, untracked, deleted) then path,
 * cap at maxPaths. A 500-changed-files repo yields exactly the same capped
 * set as any other input with the same kept paths.
 */
export function applyFloodControl(
  paths: ChangedPath[],
  options: FloodControlOptions,
): FloodControlResult {
  const seen = new Set<string>();
  const unique = paths.filter((p) => {
    if (seen.has(p.path)) return false;
    seen.add(p.path);
    return true;
  });
  const eligible = unique.filter(
    (p) => !isGeneratedOrLockfilePath(p.path) && !(options.isExcluded?.(p.path) ?? false),
  );
  const sorted = [...eligible].sort(
    (a, b) => STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state] || compareStrings(a.path, b.path),
  );
  const kept = sorted.slice(0, Math.max(0, options.maxPaths));
  return {
    kept,
    droppedCount: unique.length - eligible.length + Math.max(0, sorted.length - kept.length),
    droppedExcluded: unique.length - eligible.length,
  };
}

/**
 * Normalizes editor-supplied parts into the SeedSet shape: caps and orders
 * open editors (active first, then given order) and diagnostics (errors
 * before warnings is the caller's job; here by path), truncates diagnostic
 * messages to one line.
 */
export function normalizeSeedSet(
  partial: Partial<SeedSet> & { changedPaths: ChangedPath[] },
): SeedSet {
  const openEditors = (partial.openEditors ?? [])
    .slice(0, MAX_OPEN_EDITORS)
    .map((e, i) => ({ path: e.path, active: e.active || i === 0 }));
  const diagnostics = (partial.diagnostics ?? [])
    .slice(0, MAX_DIAGNOSTICS)
    .map((d) => ({ path: d.path, message: d.message.split(/\r?\n/)[0] ?? "" }));
  return {
    changedPaths: partial.changedPaths,
    diffSections: partial.diffSections ?? [],
    openEditors,
    selection: partial.selection,
    selectionSymbol: partial.selectionSymbol,
    diagnostics,
    notes: partial.notes ?? [],
  };
}
