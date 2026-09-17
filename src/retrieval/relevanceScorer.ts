import type { FileEntry } from "../domain/model";
import { canonicalTerm, compareStrings, tokenizeIdentifier } from "../shared/text";

/**
 * Documented, deterministic ranking weights (ADR-4). These are the single
 * source of truth for scoring; ARCHITECTURE.md mirrors them. The score is a
 * pure function of (repo state, config, query), never of iteration order
 * or wall-clock time.
 */
export const RANKING_WEIGHTS = {
  /** Exact (canonical) symbol-name match. */
  exactSymbol: 1.0,
  /** Query tokens match the file's base name (e.g. "auth routes" ~ authRoutes.ts). */
  fileName: 0.8,
  /** Normalized lexical (tf-idf) score. */
  lexical: 0.9,
  /** Structural relevance: dependencies/dependents/callers/tests/same-dir. */
  structural: 0.7,
  /** Optional git recency bonus (only when enableGitRecency is on). */
  recency: 0.15,
} as const;

export const STRUCTURAL_BONUS = {
  /** Candidate is imported by a seed file. */
  directDependency: 0.6,
  /** Candidate imports a seed file. */
  directDependent: 0.5,
  /** Candidate's symbols call / are called by seed symbols. */
  callEdge: 0.5,
  /** Candidate is the naming-convention test of a seed. */
  testOf: 0.7,
  /** Candidate extends/implements a seed symbol. */
  inheritance: 0.6,
  /** Candidate sits in the same directory as a seed. */
  sameDirectory: 0.2,
} as const;

/**
 * Total structural contribution per file is capped: hubs that touch every
 * seed must not outrank files with strong content matches. (Documented in
 * ADR-4 and ARCHITECTURE.md.)
 */
export const STRUCTURAL_CAP = 1.0;

export interface RankingSignal {
  kind:
    | "EXACT_SYMBOL"
    | "FILE_NAME"
    | "LEXICAL"
    | "DIRECT_DEPENDENCY"
    | "DIRECT_DEPENDENT"
    | "CALL_EDGE"
    | "TEST_OF"
    | "INHERITANCE"
    | "SAME_DIRECTORY"
    | "RECENCY"
    | "ENTRY_POINT"
    | "HUB";
  weight: number;
  detail: string;
}

export interface ScoredFile {
  path: string;
  score: number;
  signals: RankingSignal[];
}

/** Human-readable reason strings derived strictly from fired signals. */
export function explainSignals(scored: ScoredFile): string[] {
  return scored.signals
    .slice()
    .sort((a, b) => b.weight - a.weight || compareStrings(a.kind, b.kind))
    .map((s) => {
      switch (s.kind) {
        case "EXACT_SYMBOL":
          return `Exact symbol match: ${s.detail}`;
        case "FILE_NAME":
          return `File name matches query: ${s.detail}`;
        case "LEXICAL":
          return `Lexical match (score ${s.weight.toFixed(2)}): ${s.detail}`;
        case "DIRECT_DEPENDENCY":
          return `Direct dependency: imported by ${s.detail}`;
        case "DIRECT_DEPENDENT":
          return `Direct dependent: imports ${s.detail}`;
        case "CALL_EDGE":
          return `Call relationship with ${s.detail}`;
        case "TEST_OF":
          return `Test file for ${s.detail} (naming convention)`;
        case "INHERITANCE":
          return `Inherits from / implements symbol in ${s.detail}`;
        case "SAME_DIRECTORY":
          return `Same directory as top match: ${s.detail}`;
        case "RECENCY":
          return `Recently modified (git recency, ${s.detail})`;
        case "ENTRY_POINT":
          return `Project entry point`;
        case "HUB":
          return `Hub file (most connected): ${s.detail}`;
      }
    });
}

/** Canonical symbol-name index for exact matching (incrementally maintained). */
export class SymbolNameIndex {
  private readonly byCanonical = new Map<
    string,
    Array<{ symbolId: string; name: string; kind: string; path: string; line: number }>
  >();
  /** path -> canonical names contributed by that path (for removal). */
  private readonly contributions = new Map<string, string[]>();

  rebuild(entries: Map<string, FileEntry>): void {
    this.byCanonical.clear();
    this.contributions.clear();
    const paths = [...entries.keys()].sort(compareStrings);
    for (const path of paths) {
      const entry = entries.get(path);
      if (entry) this.applyEntry(entry);
    }
  }

  applyEntry(entry: FileEntry): void {
    this.removePath(entry.meta.path);
    const added: string[] = [];
    for (const sym of entry.symbols) {
      if (!isIndexableSymbol(sym)) continue;
      const canonical = canonicalTerm(sym.name);
      // Methods/properties are stored qualified ("Class.method"); also index
      // the short name so a query for "login" hits Class.login.
      const short = canonicalTerm(
        sym.name.includes(".") ? sym.name.slice(sym.name.lastIndexOf(".") + 1) : sym.name,
      );
      const keys = [...new Set([canonical, short])].filter((k) => k.length > 0);
      for (const canonicalKey of keys) {
        const list = this.byCanonical.get(canonicalKey) ?? [];
        list.push({
          symbolId: sym.id,
          name: sym.name,
          kind: sym.kind,
          path: entry.meta.path,
          line: sym.startLine,
        });
        this.byCanonical.set(canonicalKey, list);
        added.push(canonicalKey);
      }
    }
    this.contributions.set(entry.meta.path, added);
  }

  removePath(path: string): void {
    const previous = this.contributions.get(path);
    if (!previous) return;
    for (const canonical of previous) {
      const list = this.byCanonical.get(canonical);
      if (!list) continue;
      const filtered = list.filter((h) => h.path !== path);
      if (filtered.length === 0) this.byCanonical.delete(canonical);
      else this.byCanonical.set(canonical, filtered);
    }
    this.contributions.delete(path);
  }

  /** Exact canonical matches for a candidate (e.g. "RateLimiter" → ratelimiter). */
  exact(
    candidates: string[],
  ): Array<{ symbolId: string; name: string; kind: string; path: string; line: number }> {
    const hits: Array<{
      symbolId: string;
      name: string;
      kind: string;
      path: string;
      line: number;
    }> = [];
    for (const candidate of [...new Set(candidates)].sort(compareStrings)) {
      for (const hit of this.byCanonical.get(candidate) ?? []) hits.push(hit);
    }
    return hits;
  }

  allNames(): string[] {
    return [...this.byCanonical.keys()].sort(compareStrings);
  }
}

/**
 * Exact symbol matching targets API-level symbols: exported values, classes,
 * interfaces, types, enums, namespaces, functions and methods. Local
 * variables and fields (kind "variable"/"property" without an export
 * marker) are excluded; they are too noisy for "exact match" semantics.
 */
function isIndexableSymbol(sym: FileEntry["symbols"][number]): boolean {
  if (sym.kind === "variable" || sym.kind === "property") {
    return sym.exportKind !== undefined;
  }
  return sym.kind !== "json-key";
}

/** Weight of an exact symbol match by symbol kind (documented in ADR-4): behavior symbols outrank data shapes. */
export function exactWeightForKind(kind: string): number {
  switch (kind) {
    case "function":
    case "method":
      return 1.0;
    case "class":
    case "namespace":
      return 0.9;
    case "enum":
      return 0.7;
    case "interface":
    case "type":
      return 0.4;
    default:
      return 0.6;
  }
}

/** True when a file's base name (minus extension) canonicalizes to `candidate`. */
export function fileNameMatches(
  path: string,
  candidates: string[],
): { base: string; weight: number } | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const withoutExt = base.replace(/\.[^.]+$/, "");
  const canonicalBase = tokenizeIdentifier(withoutExt).join("");
  for (const candidate of candidates) {
    if (candidate === canonicalBase) return { base, weight: 1.0 };
    // Prefix name match (>=4 chars) still counts, but less: "payment" ~
    // "paymentService.ts".
    if (candidate.length >= 4 && canonicalBase.startsWith(candidate)) {
      return { base, weight: 0.5 };
    }
  }
  return null;
}
