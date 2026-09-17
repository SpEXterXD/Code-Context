import type { FileEntry } from "../domain/model";
import type { RelationshipGraph } from "../domain/graph";
import { traverseBidirectional } from "../domain/graph";
import { canonicalTerm, compareStrings } from "../shared/text";
import { InvertedIndex } from "./invertedIndex";
import { analyzeQuery, type QueryAnalysis } from "./queryAnalyzer";
import {
  RANKING_WEIGHTS,
  STRUCTURAL_BONUS,
  STRUCTURAL_CAP,
  SymbolNameIndex,
  exactWeightForKind,
  explainSignals,
  fileNameMatches,
  type RankingSignal,
  type ScoredFile,
} from "./relevanceScorer";
import type { GitMetadata } from "../git/gitMetadata";

export interface RetrievalOptions {
  limit?: number;
  /** Hard depth limit for graph expansion around seed files. */
  maxGraphDepth: number;
  enableGitRecency?: boolean;
  /** Files that must appear in results even when nothing matches (user pins). */
  pinnedPaths?: string[];
}

export interface RetrievalResult {
  query: string;
  analysis: QueryAnalysis;
  ranked: ScoredFile[];
  symbolHits: Array<{ symbolId: string; name: string; path: string; line: number }>;
}

export interface SymbolHit {
  symbolId: string;
  name: string;
  path: string;
  line: number;
}

/**
 * Hybrid deterministic retrieval:
 *   exact symbol match + file-name match + lexical tf-idf
 *   + depth-limited graph expansion (deps/dependents/calls/tests/inheritance)
 *   + optional git recency.
 *
 * Every score component is recorded as a signal; explanation strings are
 * derived strictly from fired signals (verified by tests). Scores are a pure
 * function of (repo state, config, query).
 */
export class HybridRetriever {
  private readonly inverted = new InvertedIndex();
  private readonly symbols = new SymbolNameIndex();
  private recencyCache: string[] | null = null;

  constructor(
    private readonly rootPath: string,
    private readonly graph: RelationshipGraph,
    private readonly git: GitMetadata,
    private readonly entriesRef: Map<string, FileEntry>,
  ) {}

  /** Full rebuild from the entries view (startup, store load, rebuilds). */
  rebuild(): void {
    this.inverted.rebuildAll(this.entriesRef);
    this.symbols.rebuild(this.entriesRef);
    this.recencyCache = null;
  }

  applyEntry(entry: FileEntry): void {
    this.inverted.applyEntry(entry);
    this.symbols.applyEntry(entry);
    this.recencyCache = null;
  }

  removeFile(path: string): void {
    this.inverted.removeFile(path);
    this.symbols.removePath(path);
    this.recencyCache = null;
  }

  retrieve(rawQuery: string, options: RetrievalOptions): RetrievalResult {
    const analysis = analyzeQuery(rawQuery);
    const limit = options.limit ?? 20;
    const contributions = new Map<string, Array<RankingSignal>>();

    const bump = (path: string, signal: RankingSignal): void => {
      const list = contributions.get(path) ?? [];
      list.push(signal);
      contributions.set(path, list);
    };

    // 1) Lexical (tf-idf over weighted fields), normalized to [0, 1].
    //    Includes prefix matching (>=4 chars) so "authentication" hits "auth".
    if (analysis.terms.length > 0) {
      const maxWeight = this.inverted.maxTermWeight;
      const idfSum = analysis.terms.reduce((acc, t) => acc + this.inverted.idf(t), 0);
      if (idfSum > 0) {
        const docScores = new Map<string, { raw: number; terms: Set<string> }>();
        const PREFIX_DISCOUNT = 0.7;
        for (const term of analysis.terms) {
          const idf = this.inverted.idf(term);
          if (idf === 0) continue;
          for (const path of this.inverted.docsFor(term)) {
            const contribution = (this.inverted.tf(term, path) * idf) / (idfSum * maxWeight);
            const cur = docScores.get(path) ?? { raw: 0, terms: new Set<string>() };
            cur.raw += contribution;
            cur.terms.add(term);
            docScores.set(path, cur);
          }
          for (const { key, docs } of this.inverted.docsForPrefix(term)) {
            const keyIdf = this.inverted.idf(key);
            for (const path of docs) {
              const contribution =
                ((this.inverted.tf(key, path) * keyIdf) / (idfSum * maxWeight)) * PREFIX_DISCOUNT;
              const cur = docScores.get(path) ?? { raw: 0, terms: new Set<string>() };
              cur.raw += contribution;
              cur.terms.add(term);
              docScores.set(path, cur);
            }
          }
        }
        // Coordination factor (classic IR): files matching MORE distinct
        // query terms outrank files repeating a single term.
        const totalTerms = analysis.terms.length;
        for (const [path, { raw, terms }] of docScores) {
          const coverage = 0.6 + 0.4 * (terms.size / totalTerms);
          bump(path, {
            kind: "LEXICAL",
            weight: RANKING_WEIGHTS.lexical * raw * coverage,
            detail: [...terms].sort(compareStrings).join(", "),
          });
        }
      }
    }

    // 2) Exact symbol matches, weighted by symbol kind and by the specificity
    // (idf) of the matched term: an exact hit on a rare term is strong
    // evidence; an exact hit on a ubiquitous word like "user" is weak.
    const totalDocs = Math.max(1, this.inverted.size);
    const maxIdf = Math.log(1 + totalDocs);
    const specificity = (term: string): number => {
      return Math.min(1, this.inverted.idf(term) / maxIdf);
    };
    const symbolHits = this.symbols.exact(analysis.exactCandidates);
    for (const hit of symbolHits) {
      const term = canonicalTerm(
        hit.name.includes(".") ? hit.name.slice(hit.name.lastIndexOf(".") + 1) : hit.name,
      );
      bump(hit.path, {
        kind: "EXACT_SYMBOL",
        weight: RANKING_WEIGHTS.exactSymbol * exactWeightForKind(hit.kind) * specificity(term),
        detail: `${hit.name} (${hit.path}:${hit.line})`,
      });
    }

    // 3) File-name matches (exact base name, or prefix at half weight),
    // scaled by term specificity like exact matches.
    for (const path of this.graph.allFiles()) {
      const matched = fileNameMatches(path, analysis.exactCandidates);
      if (matched) {
        const candidate = analysis.exactCandidates.find((c) => {
          const canonicalBase = canonicalTerm(
            path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""),
          );
          return c === canonicalBase || (c.length >= 4 && canonicalBase.startsWith(c));
        });
        const spec = candidate ? specificity(candidate) : 0.5;
        bump(path, {
          kind: "FILE_NAME",
          weight: RANKING_WEIGHTS.fileName * matched.weight * spec,
          detail: matched.base,
        });
      }
    }

    // 4) Seed selection: CONTENT signals only (lexical/exact/file-name).
    // Using structural scores for seeds would make hubs their own seeds and
    // amplify them further.
    const contentScore = (path: string): number => {
      const list = contributions.get(path);
      if (!list) return 0;
      return list
        .filter((s) => s.kind === "LEXICAL" || s.kind === "EXACT_SYMBOL" || s.kind === "FILE_NAME")
        .reduce((a, s) => a + s.weight, 0);
    };
    const seedCount = Math.min(5, Math.max(1, analysis.terms.length > 0 ? 5 : 1));
    const seeds = [...contributions.keys()]
      .map((path) => ({ path, score: contentScore(path) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || compareStrings(a.path, b.path))
      .slice(0, seedCount)
      .map((s) => s.path);

    // Aggregate structural contributions per (kind, counterpart) to avoid
    // inflating scores with many parallel edges.
    const structural = new Map<
      string,
      { kind: RankingSignal["kind"]; other: string; weight: number }
    >();
    const addStructural = (
      path: string,
      kind: RankingSignal["kind"],
      other: string,
      weight: number,
    ): void => {
      if (path === other) return;
      const key = `${path}\u0000${kind}\u0000${other}`;
      const cur = structural.get(key);
      if (!cur || cur.weight < weight) structural.set(key, { kind, other, weight });
    };

    // Bidirectional depth-limited expansion: dependencies AND dependents.
    // Only edges that cross a file boundary consume depth, so depth counts
    // file hops (contains/self-edges never inflate traversal).
    const crossingFileBoundary = (source: string, target: string): boolean => {
      const from = fileOfNode(source);
      const to = fileOfNode(target);
      return from !== null && to !== null && from !== to;
    };
    const expanded = traverseBidirectional(
      this.graph,
      seeds.map((p) => `file:${p}`),
      options.maxGraphDepth,
      (edge) => crossingFileBoundary(edge.source, edge.target),
    );
    for (const edge of expanded.edges) {
      const sourceFile = fileOfNode(edge.source);
      const targetFile = fileOfNode(edge.target);
      if (!sourceFile || !targetFile) continue;
      switch (edge.kind) {
        case "imports":
          addStructural(
            sourceFile,
            "DIRECT_DEPENDENT",
            targetFile,
            STRUCTURAL_BONUS.directDependent,
          );
          addStructural(
            targetFile,
            "DIRECT_DEPENDENCY",
            sourceFile,
            STRUCTURAL_BONUS.directDependency,
          );
          break;
        case "references":
          addStructural(
            sourceFile,
            "DIRECT_DEPENDENT",
            targetFile,
            STRUCTURAL_BONUS.directDependent,
          );
          addStructural(
            targetFile,
            "DIRECT_DEPENDENCY",
            sourceFile,
            STRUCTURAL_BONUS.directDependency,
          );
          break;
        case "calls":
          addStructural(sourceFile, "CALL_EDGE", targetFile, STRUCTURAL_BONUS.callEdge);
          addStructural(targetFile, "CALL_EDGE", sourceFile, STRUCTURAL_BONUS.callEdge);
          break;
        case "tests":
          addStructural(sourceFile, "TEST_OF", targetFile, STRUCTURAL_BONUS.testOf);
          break;
        case "extends":
        case "implements":
          addStructural(sourceFile, "INHERITANCE", targetFile, STRUCTURAL_BONUS.inheritance);
          break;
        default:
          break;
      }
    }
    // Apply structural signals per path with a total cap (hub damping).
    const structuralPerPath = new Map<
      string,
      Array<{ kind: RankingSignal["kind"]; other: string; weight: number }>
    >();
    for (const [key, { kind, other, weight }] of structural) {
      const path = key.split("\u0000")[0];
      const list = structuralPerPath.get(path) ?? [];
      list.push({ kind, other, weight });
      structuralPerPath.set(path, list);
    }
    for (const [path, list] of structuralPerPath) {
      const total = list.reduce((a, s) => a + s.weight, 0);
      const scale = total > STRUCTURAL_CAP ? STRUCTURAL_CAP / total : 1;
      for (const s of list) {
        bump(path, { kind: s.kind, weight: s.weight * scale, detail: s.other });
      }
    }

    // 5) Same-directory bonus relative to the top seed (capped with the rest).
    if (seeds.length > 0) {
      const seedDir = dirOf(seeds[0]);
      if (seedDir) {
        for (const path of this.graph.allFiles()) {
          if (dirOf(path) === seedDir && path !== seeds[0]) {
            addStructural(path, "SAME_DIRECTORY", seedDir, STRUCTURAL_BONUS.sameDirectory);
          }
        }
      }
    }

    // 6) Optional git recency (deterministic for a given repo state).
    if (options.enableGitRecency) {
      const order = this.recencyOrder();
      const rank = new Map(order.map((p, i) => [p, i] as const));
      for (const path of contributions.keys()) {
        const r = rank.get(path);
        if (r !== undefined && r < 25) {
          bump(path, {
            kind: "RECENCY",
            weight: RANKING_WEIGHTS.recency * (1 - r / 25),
            detail: `rank ${r + 1} of recent commits`,
          });
        }
      }
    }

    const ranked: ScoredFile[] = [...contributions.entries()]
      .map(([path, signals]) => ({
        path,
        score: signals.reduce((a, s) => a + s.weight, 0),
        signals,
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || compareStrings(a.path, b.path))
      .slice(0, limit);

    for (const pinned of options.pinnedPaths ?? []) {
      if (!ranked.some((r) => r.path === pinned)) {
        ranked.push({ path: pinned, score: 0, signals: [] });
      }
    }

    return { query: rawQuery, analysis, ranked, symbolHits };
  }

  explain(scored: ScoredFile): string[] {
    return explainSignals(scored);
  }

  searchSymbols(prefix: string, limit = 50): SymbolHit[] {
    const canonical = prefix.toLowerCase();
    return this.symbols
      .allNames()
      .filter((n) => n.startsWith(canonical))
      .flatMap((n) => this.symbols.exact([n]))
      .sort(
        (a, b) =>
          compareStrings(a.name, b.name) || compareStrings(a.path, b.path) || a.line - b.line,
      )
      .slice(0, limit);
  }

  private recencyOrder(): string[] {
    if (this.recencyCache === null) {
      this.recencyCache = this.git.recencyOrder(this.rootPath);
    }
    return this.recencyCache;
  }
}

function fileOfNode(node: string): string | null {
  if (node.startsWith("file:")) return node.slice(5);
  if (node.startsWith("symbol:")) {
    const id = node.slice(7);
    const hash = id.indexOf("#");
    return hash === -1 ? null : id.slice(0, hash);
  }
  return null;
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}
