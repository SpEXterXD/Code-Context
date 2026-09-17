import * as fs from "node:fs";
import * as path from "node:path";

import { toPosixPath } from "../shared/ids";

export interface AliasMapping {
  /** e.g. "@/" -> ["src/"] (POSIX, repo-relative). */
  prefixes: Map<string, string[]>;
}

export type ResolutionOutcome =
  | { status: "RESOLVED"; path: string; viaAlias: boolean }
  | { status: "EXTERNAL"; pkg: string }
  | { status: "UNRESOLVED"; reason: string };

const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/**
 * Resolves import specifiers to repo-relative file paths.
 *
 * Supports: relative paths (`./x`, `../x`), extension omission, `/index`
 * directory resolution, `.js`→`.ts` mapping, and tsconfig `paths` aliases
 * (loaded once per index run). Never guesses a destination: a specifier that
 * cannot be resolved yields `UNRESOLVED` with the reason, and bare package
 * specifiers yield `EXTERNAL` (out of repo scope by design).
 */
export class ImportResolver {
  private readonly knownFiles: Set<string>;
  private readonly aliases: AliasMapping;
  private readonly resolutionCache = new Map<string, ResolutionOutcome>();

  constructor(rootPath: string, knownFiles: Set<string>) {
    this.knownFiles = knownFiles;
    this.aliases = loadTsConfigAliases(rootPath);
  }

  resolve(specifier: string, importerPath: string): ResolutionOutcome {
    const cacheKey = `${importerPath}::${specifier}`;
    const cached = this.resolutionCache.get(cacheKey);
    if (cached) return cached;

    const outcome = this.resolveUncached(specifier, importerPath);
    this.resolutionCache.set(cacheKey, outcome);
    return outcome;
  }

  private resolveUncached(specifier: string, importerPath: string): ResolutionOutcome {
    if (!specifier || specifier === "<dynamic>") {
      return { status: "UNRESOLVED", reason: "dynamic or empty specifier" };
    }

    // Alias resolution first (@/foo, ~/foo, #lib/foo style prefixes from tsconfig paths).
    for (const [prefix, targets] of this.aliases.prefixes) {
      if (specifier.startsWith(prefix) || specifier === prefix.slice(0, -1)) {
        const rest = specifier === prefix.slice(0, -1) ? "" : specifier.slice(prefix.length);
        for (const target of targets) {
          const candidate = joinPosix(target, rest);
          const hit = resolveFromKnown(this.knownFiles, candidate);
          if (hit) return { status: "RESOLVED", path: hit, viaAlias: true };
        }
        return { status: "UNRESOLVED", reason: `alias ${prefix} did not match any indexed file` };
      }
    }

    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const baseDir = specifier.startsWith("/")
        ? ""
        : importerPath.includes("/")
          ? importerPath.slice(0, importerPath.lastIndexOf("/"))
          : "";
      const joined = specifier.startsWith("/") ? specifier.slice(1) : joinPosix(baseDir, specifier);
      const hit = resolveFromKnown(this.knownFiles, joined);
      if (hit) return { status: "RESOLVED", path: hit, viaAlias: false };
      return { status: "UNRESOLVED", reason: `no indexed file for "${specifier}"` };
    }

    // Bare specifier: external package (or node builtin).
    const parts = specifier.split("/");
    const pkg = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    return { status: "EXTERNAL", pkg };
  }
}

function joinPosix(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}/${b}`;
}

function resolveFromKnown(known: Set<string>, candidate: string): string | null {
  const normalized = toPosixPath(candidate);
  if (known.has(normalized)) return normalized;
  for (const ext of CODE_EXTENSIONS) {
    if (known.has(normalized + ext)) return normalized + ext;
  }
  // `.js`/`.mjs` specifiers pointing at `.ts` sources (TS ESM convention).
  const jsMatch = normalized.match(/\.(js|mjs|cjs)$/);
  if (jsMatch) {
    const tsCandidate = normalized.replace(/\.(js|mjs|cjs)$/, "");
    for (const ext of [".ts", ".tsx"]) {
      if (known.has(tsCandidate + ext)) return tsCandidate + ext;
    }
  }
  for (const indexFile of ["index.ts", "index.tsx", "index.js", "index.mjs", "index.json"]) {
    const candidateIndex = `${normalized}/${indexFile}`;
    if (known.has(candidateIndex)) return candidateIndex;
  }
  return null;
}

/** Reads root tsconfig.json (+ referenced configs minimally) for `paths` aliases. */
function loadTsConfigAliases(rootPath: string): AliasMapping {
  const prefixes = new Map<string, string[]>();
  const candidates = ["tsconfig.json", "jsconfig.json"];
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(path.join(rootPath, candidate), "utf8");
      const json = parseJsoncLoose(raw) as
        { compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } } | undefined;
      const opts = json?.compilerOptions;
      if (!opts?.paths) continue;
      const baseUrl = opts.baseUrl ? toPosixPath(opts.baseUrl) : "";
      for (const [pattern, targets] of Object.entries(opts.paths)) {
        const prefix = pattern.replace(/\*$/, "");
        const resolvedTargets = targets.map((t) => {
          const posix = toPosixPath(t).replace(/\*$/, "");
          return baseUrl && !posix.startsWith(baseUrl) ? joinPosix(baseUrl, posix) : posix;
        });
        prefixes.set(prefix, resolvedTargets);
      }
      break; // first config wins
    } catch {
      /* no tsconfig: fine */
    }
  }
  return { prefixes };
}

/** Minimal JSONC relaxer for tsconfig files (comments + trailing commas). */
export function parseJsoncLoose(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
