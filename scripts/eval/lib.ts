/**
 * Pure helpers for the retrieval evaluation harness. No git I/O, no network:
 * everything here takes fixed inputs, so the filters and samplers are fully
 * unit-testable (see lib.test.ts). The git/network layers live in gitminer.ts
 * and eval-build-dataset.ts.
 */

/** Deterministic PRNG (mulberry32) — self-contained so tests need no src imports. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a so any string (repo id, task id) can seed the PRNG deterministically. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Lower-case tokens for paths, identifiers and task text: snake/kebab/dotted
 * separators plus camelCase/PascalCase boundaries collapse to lowercase words.
 * Used consistently by both the path-level baselines and task tokenization.
 */
export function tokenize(text: string): string[] {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  return spaced.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** Stopwords dropped when a "word count" is measured for the task filter. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "be",
  "not",
  "this",
  "that",
  "it",
  "as",
  "at",
  "by",
  "from",
  "into",
]);

export function contentWords(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t));
}

/**
 * Cleans a commit subject+body into a natural-language task text. Strips
 * trailers (token: value blocks at the end, Co-authored-by, Signed-off-by),
 * URLs, PR/issue references "(#123)" / "#123", and cherry-pick trailers.
 * Returns null when too little survives (caller then applies its own length
 * filter to the cleaned text).
 */
export function cleanTaskText(subject: string, body: string): string {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) {
      kept.push("");
      continue;
    }
    if (/^(co-authored-by|signed-off-by|reviewed-by|acked-by|reported-by|tested-by)\s*:/i.test(t)) {
      continue;
    }
    // Trailer blocks: "Token: value" only near the end must be preserved,
    // so only drop known-non-prose trailers anywhere (git treats trailers
    // anywhere in the trailer block, but prose usually wraps them).
    kept.push(t);
  }
  let text = [subject, ...kept].join(" ").trim() || subject.trim();
  text = text
    .replace(/\(cherry picked from commit [0-9a-f]+\)/gi, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[a-z0-9.\-+/]+@[a-z0-9.\-]+/gi, " ")
    .replace(/\(#\d+\)/g, " ")
    .replace(/(?:^|(?<=\s))#\d+(?=\s|$)/g, " ")
    .replace(/^merge pull request #\d+ from \s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : subject.trim();
}

export function wordCount(text: string): number {
  // "(v2)" / "v2" style decorations are not real task words.
  const cleaned = text.replace(/\bv\d+\b/gi, " ").replace(/\(\s*v\d+\s*\)/gi, " ");
  return contentWords(cleaned).length;
}

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

const TEST_FILE_RE =
  /(^|\/)(__tests__|tests?|spec|specs|e2e)(\/|$)|\.((test|spec|e2e)\.[cm]?[jt]sx?|test|spec)$/i;
const SRC_EXT_RE = /\.[cm]?[jt]sx?$/i;

/** Meaningful lower-case tokens of a path (identifiers split). */
export function pathTokens(p: string): string[] {
  const normalized = p.replace(/\\/g, "/");
  const withoutExt = normalized.replace(/\.[a-z0-9]+$/i, "");
  return tokenize(
    withoutExt.replace(/(^|\/)(packages?|libs?|modules?|ts|js|src|lib)($|\/|$)/g, " "),
  );
}

export function isTestPath(p: string): boolean {
  return TEST_FILE_RE.test(p.replace(/\\/g, "/"));
}

export function isLockFilePath(p: string): boolean {
  const lower = p.replace(/\\/g, "/").toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  return (
    base === "package-lock.json" ||
    base === "npm-shrinkwrap.json" ||
    base === "pnpm-lock.yaml" ||
    base === "yarn.lock" ||
    base === "bun.lockb" ||
    base === "deno.lock" ||
    base === "go.sum" ||
    base === "poetry.lock"
  );
}

export function isDocsPath(p: string): boolean {
  const lower = p.replace(/\\/g, "/").toLowerCase();
  return (
    /\.mdx?$/i.test(lower) ||
    /(^|\/)docs?(\/|$)/.test(lower) ||
    /(^|\/)(changelog|code_of_conduct|contributing|license|readme)/i.test(lower)
  );
}

export function isCiConfigPath(p: string): boolean {
  const lower = p.replace(/\\/g, "/").toLowerCase();
  return (
    lower.startsWith(".github/") ||
    /(^|\/)(\.gitlab-ci|\.circleci|\.travis|jenkinsfile|\.prettierrc|\.eslintrc)/.test(lower) ||
    /\.(yml|yaml|toml|cfg|ini|editorconfig|npmrc|nvmrc|node-version)$/.test(lower) ||
    lower.endsWith(".json")
  );
}

/** TypeScript/JavaScript production source (tests and .d.ts excluded). */
export function isSourcePath(p: string): boolean {
  const p2 = p.replace(/\\/g, "/");
  return SRC_EXT_RE.test(p2) && !TEST_FILE_RE.test(p2) && !/\.d\.[cm]?tsx?$/i.test(p2);
}

/**
 * True for files OCC parses with a full structured parser (TS/JS via the
 * TypeScript API, JSON/JSONC, Markdown) — the "source-only" gold slice. All
 * other extensions fall back to the generic metadata parser.
 */
export function isOccParsedPath(p: string): boolean {
  return /\.(?:(?:m|c)?(?:t|j)sx?|json|jsonc|md|markdown)$/i.test(p.replace(/\\/g, "/"));
}

// ---------------------------------------------------------------------------
// Commit candidate filtering
// ---------------------------------------------------------------------------

/** One touched file from `git diff-tree --name-status`. */
export interface TouchedFile {
  /** one of: A (added), M, D (deleted), R (renamed), C (copied), T (type change) */
  status: string;
  /** pre-commit path (for renames/copies the old path). */
  prePath: string;
  /** post-commit path (equals prePath unless renamed/copied). */
  postPath: string;
  /** rename similarity score 0-100 when git reported one. */
  renameScore?: number;
}

const BOT_AUTHORS = [
  "dependabot",
  "renovate",
  "github-actions",
  "actions-user",
  "semantic-release-bot",
  "semantic-release",
  "codecov",
  "greenkeeper",
  "changeset-bot",
  "snaily",
  "automated",
  "bot@",
  "devcontainer",
  "github bot",
  "chore",
  "noreply",
];

export function isBotAuthor(name: string, email: string): boolean {
  const hay = `${name} ${email}`.toLowerCase();
  return BOT_AUTHORS.some((b) => hay.includes(b));
}

const VERSION_BUMP_SUBJECT =
  /^(?:chore|build|release|dev)?\s*[(:]?\s*(?:release|v\d|bump(?:\s+(?:version|deps))?|prepare\s+(?:release|for\s+release)|\d+\.\d+\.\d+)/i;
const FORMAT_SUBJECT =
  /\b(?:format(?:ting)?|prettier|lint(?:ing)?|eslint|style:? reformat|clang-format|code style)\b/i;
const REVERT_SUBJECT = /^(?:revert\b|this reverts commit )/i;

export interface CommitCandidateInput {
  sha: string;
  /** number of parents; merge commits (2+) are excluded. */
  parentCount: number;
  authorName: string;
  authorEmail: string;
  subject: string;
  body: string;
  files: TouchedFile[];
}

export interface FilterReason {
  ok: boolean;
  /** machine-readable reason when rejected. */
  reason?: string;
}

/**
 * Applies the dataset inclusion rule to one commit. Pure: same input ⇒ same
 * verdict, so identical repo+rules always mine the same dataset.
 */
export function filterCommit(
  c: CommitCandidateInput,
): FilterReason & { task: string | null; gold?: string[]; excludedNewFiles?: number } {
  if (c.parentCount !== 1) return { ok: false, reason: "merge-commit", task: null };
  if (isBotAuthor(c.authorName, c.authorEmail))
    return { ok: false, reason: "bot-author", task: null };

  // Gold localizability is decided first so it takes priority over the task
  // text checks when a commit creates only new files.
  if (c.files.length === 0) return { ok: false, reason: "file-count", task: null };
  const gold: string[] = [];
  let excludedNewFiles = 0;
  for (const f of c.files) {
    if (f.status === "A" || f.status === "C") {
      excludedNewFiles++;
      continue;
    }
    const p = f.prePath.replace(/\\/g, "/");
    if (!gold.includes(p)) gold.push(p);
  }
  if (c.files.every((f) => f.status.startsWith("R")))
    return { ok: false, reason: "pure-rename", task: null };
  if (gold.length === 0)
    return {
      ok: false,
      task: null,
      reason: "no-localizable-gold",
      excludedNewFiles: excludedNewFiles,
    };
  if (c.files.length > 8) return { ok: false, reason: "file-count", task: null };

  const task = cleanTaskText(c.subject, c.body);
  const words = wordCount(task);
  if (words > 200) return { ok: false, reason: "task-too-long", task: null };

  if (REVERT_SUBJECT.test(c.subject)) return { ok: false, reason: "revert", task: null };

  if (VERSION_BUMP_SUBJECT.test(c.subject) || /^(?:release|bump)\b/i.test(c.subject)) {
    const onlyVersionArtifacts = c.files.every((f) => {
      const lower = f.postPath.toLowerCase();
      return (
        lower.endsWith("package.json") || lower.endsWith("tsconfig.json") || isLockFilePath(lower)
      );
    });
    if (onlyVersionArtifacts) return { ok: false, reason: "version-bump", task: null };
  }
  if (FORMAT_SUBJECT.test(c.subject)) {
    const noSourceGold = c.files.every((f) => !isSourcePath(f.prePath));
    if (noSourceGold) return { ok: false, reason: "format-only", task: null };
  }

  const contentOnly = classifyContentOnly(c.files);
  if (contentOnly) return { ok: false, reason: contentOnly, task: null };
  if (!c.files.some((f) => isSourcePath(f.prePath) || isSourcePath(f.postPath))) {
    return { ok: false, reason: "no-source-file", task: null };
  }

  if (words < 5) return { ok: false, reason: "task-too-short", task: null };

  return { ok: true, task, gold: gold.sort(), excludedNewFiles };
}

/** True when every touched file is a non-source artifact (docs/ci/locks). */
function classifyContentOnly(files: TouchedFile[]): string | undefined {
  const kinds = new Set<string>();
  for (const f of files) {
    for (const p of [f.prePath, f.postPath]) {
      if (!p) continue;
      if (isSourcePath(p) || isTestPath(p)) return undefined;
      if (isLockFilePath(p)) kinds.add("lock-only");
      else if (isDocsPath(p)) kinds.add("docs-only");
      else if (isCiConfigPath(p)) kinds.add("ci-only");
      else kinds.add("other-asset-only");
    }
  }
  if (kinds.has("lock-only")) return "lockfile-only";
  if (kinds.has("docs-only") && kinds.size === 1) return "docs-only";
  if (kinds.has("ci-only") && kinds.size === 1) return "ci-only";
  if (kinds.size <= 1 && !kinds.has("other-asset-only")) return [...kinds][0];
  return undefined;
}

// ---------------------------------------------------------------------------
// Deterministic sampling
// ---------------------------------------------------------------------------

export interface CommitMeta {
  sha: string;
  parentSha: string;
  committerTime: number;
}

/**
 * Splits candidates into the tuning period (earlier half by committer time)
 * and the eval pool (later half), then samples `count` commits from the
 * chosen half with a seeded PRNG (`sampleFrom` defaults to the eval pool, so
 * tuning experiments can run on the earlier half without ever touching the
 * eval half). Same candidate list + seed + half ⇒ same sample, always.
 * Returned commits are sorted by committerTime then sha for determinism.
 */
export function sampleEvalCommits<T extends CommitMeta>(
  candidates: T[],
  count: number,
  seed: number,
  sampleFrom: "evalPool" | "tuningHalf" = "evalPool",
): { evalPool: T[]; tuningHalf: T[]; sampled: T[] } {
  const sorted = [...candidates].sort(
    (a, b) => a.committerTime - b.committerTime || (a.sha < b.sha ? -1 : 1),
  );
  const splitIndex = Math.floor(sorted.length / 2);
  const tuningHalf = sorted.slice(0, splitIndex);
  const evalPool = sorted.slice(splitIndex);
  const pool = sampleFrom === "tuningHalf" ? tuningHalf : evalPool;
  const rng = mulberry32(seed);
  const picked = new Set<string>();
  const sampled: T[] = [];
  // Reservoir-free approach: repeatedly choose a uniformly random index from
  // the chosen pool until we have `count` distinct commits.
  let guard = 0;
  while (sampled.length < Math.min(count, pool.length) && guard < count * 100) {
    const idx = Math.floor(rng() * pool.length) % pool.length;
    const candidate = pool[idx]!;
    if (!picked.has(candidate.sha)) {
      picked.add(candidate.sha);
      sampled.push(candidate);
    }
    guard++;
  }
  sampled.sort((a, b) => a.committerTime - b.committerTime || (a.sha < b.sha ? -1 : 1));
  return { evalPool, tuningHalf, sampled };
}
