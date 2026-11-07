import { compareStrings } from "../shared/text";

/**
 * Best-effort `.gitignore` subset plus configurable exclude globs.
 *
 * Supported gitignore syntax (documented subset):
 * - blank lines and `#` comments
 * - negation with leading `!`
 * - trailing `/` marks a directory-only pattern
 * - leading `/` anchors the pattern at the ignore-file's directory
 * - `*`, `?` single-level wildcards; `**` cross-level wildcards
 * - patterns containing a `/` (other than a trailing one) are anchored
 *
 * Git semantics: within one ignore file, the LAST matching pattern wins;
 * negations only re-include files that were not excluded by a parent
 * directory (we approximate: parent-dir exclusion wins over later negation
 * of a file inside it, documented in LIMITATIONS.md).
 *
 * F07: nested `.gitignore` files contribute patterns SCOPED to their
 * directory (`sourceDir`) — `a/.gitignore` containing `hidden.ts` excludes
 * `a/hidden.ts` but never `b/hidden.ts`. Built-in security/store excludes
 * carry a `builtin` flag and win over repository negations: a repo
 * `.gitignore` cannot re-include `.env`, `.occ-store`, etc.
 */
export interface IgnorePattern {
  raw: string;
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
  /** Directory (POSIX, root-relative, "" = root) this pattern is scoped to. */
  sourceDir: string;
  /** Built-in security/store excludes win over repository negations. */
  builtin: boolean;
}

export class IgnoreRules {
  private readonly patterns: IgnorePattern[] = [];

  constructor(excludeGlobs: string[] = []) {
    // User-configured exclude globs (settings) honor negation; only
    // DEFAULT_EXCLUDES added by buildIgnoreRules carry the builtin flag.
    for (const glob of excludeGlobs) this.addPattern(glob);
  }

  /** Adds one gitignore-style pattern scoped to `sourceDir` ("" = root). */
  addPattern(raw: string, sourceDir?: string, builtin = false): void {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }
    let dirOnly = false;
    if (pattern.endsWith("/")) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    const anchored = pattern.startsWith("/") || pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    const regex = globToRegex(pattern, anchored);
    this.patterns.push({
      raw: line,
      negated,
      dirOnly,
      anchored,
      regex,
      sourceDir: (sourceDir ?? "").replace(/\\/g, "/").replace(/\/$/, ""),
      builtin,
    });
  }

  /** Parses the content of a `.gitignore` file into these rules, scoped to its directory. */
  addGitignoreContent(content: string, sourceDir = ""): void {
    for (const line of content.split(/\r?\n/)) this.addPattern(line, sourceDir);
  }

  /**
   * True if the given POSIX-style relative path should be excluded.
   * Patterns with a sourceDir only apply to paths under that directory and
   * match against the path relative to it; built-in patterns win over
   * repository negations.
   */
  isIgnored(path: string, isDirectory: boolean): boolean {
    let ignored = false;
    let builtinMatched = false;
    for (const p of this.patterns) {
      let effectivePath = path;
      if (p.sourceDir) {
        const prefix = `${p.sourceDir}/`;
        if (!path.startsWith(prefix)) continue;
        effectivePath = path.slice(prefix.length);
        if (effectivePath.length === 0) continue;
      }
      if (p.dirOnly && !isDirectory && !this.matchesDirPrefix(effectivePath, p)) continue;
      if (p.regex.test(effectivePath)) {
        if (p.builtin) {
          builtinMatched = true;
          continue;
        }
        ignored = !p.negated;
      }
    }
    return ignored || builtinMatched;
  }

  private matchesDirPrefix(path: string, p: IgnorePattern): boolean {
    // "build/" should ignore "build/x.ts" as well as "build" itself.
    const idx = path.lastIndexOf("/");
    let parent = idx === -1 ? "" : path.slice(0, idx);
    while (parent) {
      if (p.regex.test(parent)) return true;
      const nextIdx = parent.lastIndexOf("/");
      parent = nextIdx === -1 ? "" : parent.slice(0, nextIdx);
    }
    return false;
  }

  patternsSnapshot(): string[] {
    return this.patterns.map((p) => p.raw).sort(compareStrings);
  }
}

/** Converts a gitignore glob to an anchored RegExp over POSIX paths. */
export function globToRegex(glob: string, anchored: boolean): RegExp {
  let re = "";
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more path segments; trailing "**" matches everything
        if (glob[i + 2] === "/") {
          re += "(?:[^/]+/)*";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close > i + 1) {
        re += glob.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  const prefix = anchored ? "^" : "(?:^|/)";
  return new RegExp(`${prefix}${re}(?:$|/)`);
}

/** Default always-on sensitive-path excludes; documented, configurable, never silent. */
export const DEFAULT_EXCLUDES: string[] = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".cache",
  ".tmp",
  "tmp",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.log",
  "*.min.js",
  "*.map",
  "__pycache__",
  ".occ-store",
  ".occ-store.*",
  ".occ-test-store",
  ".occ-demo-store",
];
