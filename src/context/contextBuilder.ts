import type { FileEntry } from "../domain/model";
import type { RelationshipGraph } from "../domain/graph";
import { traverseBidirectional } from "../domain/graph";
import { HybridRetriever, type RetrievalResult } from "../retrieval/hybridRetriever";
import type { ScoredFile, RankingSignal } from "../retrieval/relevanceScorer";
import {
  assignTiers,
  findEntryPoints,
  findHubFiles,
  TIER_LABELS,
  type RankedCandidate,
} from "./contextSelector";
import { buildProjectTree, renderProjectTree } from "../analysis/projectStructure";
import { BudgetLedger, type ContextBudgetConfig } from "./contextBudget";
import { estimateTokensApprox } from "./tokenEstimator";
import {
  applySecurityPolicy,
  verifyNoSecretLeaks,
  sortSafeFindings,
  type SecurityConfig,
  type SecurityVerdict,
} from "../security/securityService";
import {
  formatContext,
  renderCodeBlock,
  renderSourceFileSection,
  countPayloadLines,
  type ContextModel,
  type SourceBlock,
  type SourceFileSection,
  type WhySelection,
} from "./contextFormatter";
import { sha256Hex } from "../shared/ids";
import { OccError } from "../shared/errors";
import { compareStrings } from "../shared/text";

export type ContextMode = "project" | "file" | "task" | "selection";

/**
 * Entry-point scope for context generation (UI right-click commands):
 * - "folder": restrict the ROOT selection to files under `relPath`
 *   (relationship expansion still explains cross-boundary edges);
 * - "file": seed from exactly one file (existing file-mode tier expansion).
 * A scope never changes the wire format, tiers, scoring, or budgeting:
 * it only constrains the candidate set at the retrieval boundary.
 */
export type ContextScope = { kind: "folder"; relPath: string } | { kind: "file"; relPath: string };

/** True when `path` is `relPath` itself or lies underneath it (POSIX paths). */
export function isUnderPath(path: string, relPath: string): boolean {
  if (relPath === "" || relPath === ".") return true;
  return path === relPath || path.startsWith(`${relPath}/`);
}

export interface ContextRequest {
  mode: ContextMode;
  taskText?: string;
  activeFile?: string;
  selectedPaths?: string[];
  /** Selection mode: expand with dependency/context rules. */
  expandSelection?: boolean;
  /** Limit candidates considered before budgeting. */
  candidateLimit?: number;
  /** Optional folder/file entry-point scope (right-click commands). */
  scope?: ContextScope;
}

export type TruncationLevel = "FULL" | "SYMBOLS" | "SIGNATURES" | "METADATA";

export interface ContextBuildResult {
  payload: string;
  filesIncluded: number;
  chars: number;
  lines: number;
  estimatedTokens: number;
  security: SecurityVerdict;
  truncation: Array<{ path: string; level: TruncationLevel }>;
  rankedForDisplay: Array<{
    path: string;
    tierLabel: string;
    score: number;
    reasons: string[];
    included: boolean;
  }>;
  retrieval?: RetrievalResult;
}

export interface ContextBuilderDeps {
  entries: Map<string, FileEntry>;
  graph: RelationshipGraph;
  retriever: HybridRetriever;
  projectName: string;
  indexVersion: string;
  budget: ContextBudgetConfig;
  security: SecurityConfig;
  enableGitRecency: boolean;
  readFile: (repoRelativePath: string) => string;
}

const TIER_ORDER_SIGNAL_WEIGHT: Record<string, number> = {
  USER_SELECTED: 100,
  EXACT_SYMBOL: 90,
  DIRECT_DEPENDENCY: 80,
  DIRECT_DEPENDENT: 70,
  RELEVANT_TESTS: 60,
  STRONG_LEXICAL: 50,
  ARCHITECTURAL: 40,
  LOWER_CONFIDENCE: 30,
};

/**
 * Builds a complete context package for a mode:
 * retrieve → tier → security screen → budgeted truncation ladder → format.
 *
 * The returned payload is byte-exact what Preview shows and Copy exports.
 * Determinism: same repo state + config + request ⇒ byte-identical payload.
 */
export class ContextBuilder {
  constructor(private readonly deps: ContextBuilderDeps) {}

  build(request: ContextRequest): ContextBuildResult {
    const { entries, graph, budget } = this.deps;
    const ledger = new BudgetLedger(budget);
    const pinnedPaths = this.resolvePinned(request);
    const retrieval = this.retrieveForMode(request, pinnedPaths);
    const candidates = assignTiers(retrieval.ranked, pinnedPaths);

    // Security screen BEFORE budgeting: blocked files never consume budget.
    const security = this.screenCandidates(candidates);
    const eligible = candidates.filter((c) => !security.blockedFiles.has(c.path));

    // Reserve budget for static sections (tree/architecture/why overhead);
    // the exact guarantee comes from the degrade loop below.
    const tree = renderProjectTree(buildProjectTree(entries), {
      maxDepth: budget.structureDepth,
      maxEntries: 400,
    });
    const architecture = this.buildArchitecture(entries, graph);
    const skeleton = formatContext({
      projectName: this.deps.projectName,
      indexVersion: this.deps.indexVersion,
      task: request.taskText,
      tree: tree.text,
      treeNote: tree.truncated ? `tree truncated at depth ${budget.structureDepth}` : undefined,
      architecture,
      symbols: [],
      why: [],
      sourceFiles: [],
      metadata: {
        filesIncluded: 0,
        estimatedTokens: 10,
        securityFindings: security.safeFindings.length,
        budget,
      },
    });
    ledger.add(
      skeleton.length + 64 * eligible.length,
      countPayloadLines(skeleton) + 8 * eligible.length,
    );

    // Per-file source assembly with truncation ladder (greedy by tier order).
    const sourceFiles: SourceFileSection[] = [];
    const truncation: Array<{ path: string; level: TruncationLevel }> = [];
    const why: WhySelection[] = [];
    const includedPaths: string[] = [];

    for (const candidate of eligible) {
      const entry = entries.get(candidate.path);
      if (!entry) continue;
      const reasons = this.deps.retriever.explain(scoredFromCandidate(candidate));

      if (ledger.fileBudgetAvailable) {
        const attempt = this.assembleSource(
          candidate.path,
          entry,
          ledger,
          security.redactedContent,
        );
        if (attempt) {
          ledger.addFile(); // file is committed to the package: count it against maxFiles
          sourceFiles.push(attempt.section);
          includedPaths.push(candidate.path);
          truncation.push({ path: candidate.path, level: attempt.level });
          why.push({
            path: candidate.path,
            tierLabel: TIER_LABELS[candidate.tier],
            score: candidate.score,
            reasons,
            included: true,
          });
          continue;
        }
      }
      // Does not fit at any content level (or budget spent): metadata only.
      // The note names the binding budget so omissions are never silent.
      why.push({
        path: candidate.path,
        tierLabel: TIER_LABELS[candidate.tier],
        score: candidate.score,
        reasons,
        included: false,
        note: !ledger.fileBudgetAvailable
          ? `file budget reached (maxFiles=${budget.maxFiles})`
          : "within candidate set but excluded by budget at this rank",
      });
    }

    // Blocked files always get a WHY entry (explainable omissions).
    for (const blockedPath of [...security.blockedFiles.keys()].sort(compareStrings)) {
      if (why.some((w) => w.path === blockedPath)) continue;
      why.push({
        path: blockedPath,
        tierLabel: "excluded by security policy",
        score: 0,
        reasons: security.blockedFiles.get(blockedPath) ?? [],
        included: false,
        note: "source withheld by security policy",
      });
    }

    // Assemble + verify with a deterministic degrade loop: if the exact
    // payload exceeds the budget, demote the lowest-priority included file to
    // metadata-only and re-render. Never silently exceeds.
    const truncationNote = (
      levels: Array<{ path: string; level: TruncationLevel }>,
    ): string | undefined => {
      const degraded = levels.filter((t) => t.level !== "FULL");
      return degraded.length > 0
        ? degraded.map((t) => `${t.path} (${t.level})`).join(", ")
        : undefined;
    };
    const noteFor = (levels: Array<{ path: string; level: TruncationLevel }>): string | undefined =>
      truncationNote(levels);
    let model = this.assembleModel(
      request,
      tree,
      architecture,
      sourceFiles,
      includedPaths,
      why,
      security,
      budget,
      truncation,
      noteFor,
    );
    let rendered = renderWithTokenConvergence(model);
    while (
      (rendered.chars > budget.maxChars ||
        rendered.lines > budget.maxLines ||
        rendered.estimatedTokens > budget.maxTokens) &&
      includedPaths.length > 0
    ) {
      const demoted = includedPaths.pop();
      if (!demoted) break;
      const idx = sourceFiles.findIndex((s) => s.path === demoted);
      if (idx >= 0) sourceFiles.splice(idx, 1);
      const whyIdx = why.findIndex((w) => w.path === demoted);
      if (whyIdx >= 0) why[whyIdx].included = false;
      const tIdx = truncation.findIndex((t) => t.path === demoted);
      if (tIdx >= 0) truncation.splice(tIdx, 1);
      model = this.assembleModel(
        request,
        tree,
        architecture,
        sourceFiles,
        includedPaths,
        why,
        security,
        budget,
        truncation,
        noteFor,
      );
      rendered = renderWithTokenConvergence(model);
    }
    if (
      rendered.chars > budget.maxChars ||
      rendered.lines > budget.maxLines ||
      rendered.estimatedTokens > budget.maxTokens
    ) {
      throw new OccError(
        "BUDGET_INVALID",
        `CONTEXT_BUDGET_UNREACHABLE: static sections alone exceed the configured budget ` +
          `(chars ${rendered.chars}/${budget.maxChars}, lines ${rendered.lines}/${budget.maxLines}). ` +
          `Increase maxChars/maxLines/maxTokens.`,
      );
    }

    verifyNoSecretLeaks(security.rawFindings, rendered.payload);

    return {
      payload: rendered.payload,
      filesIncluded: includedPaths.length,
      chars: rendered.chars,
      lines: rendered.lines,
      estimatedTokens: rendered.estimatedTokens,
      security: { ...security, safeFindings: sortSafeFindings([...security.safeFindings]) },
      truncation,
      rankedForDisplay: why.map((w) => ({
        path: w.path,
        tierLabel: w.tierLabel,
        score: w.score,
        reasons: w.reasons,
        included: w.included,
      })),
      retrieval,
    };
  }

  private assembleModel(
    request: ContextRequest,
    tree: ReturnType<typeof renderProjectTree>,
    architecture: ContextModel["architecture"],
    sourceFiles: SourceFileSection[],
    includedPaths: string[],
    why: WhySelection[],
    security: SecurityVerdict,
    budget: ContextBudgetConfig,
    truncation: Array<{ path: string; level: TruncationLevel }>,
    noteFor: (levels: Array<{ path: string; level: TruncationLevel }>) => string | undefined,
  ): ContextModel {
    return {
      projectName: this.deps.projectName,
      indexVersion: this.deps.indexVersion,
      task: request.taskText,
      tree: tree.text,
      treeNote: tree.truncated ? `tree truncated at depth ${budget.structureDepth}` : undefined,
      architecture,
      symbols: this.buildSymbolLines(includedPaths),
      why,
      sourceFiles,
      metadata: {
        filesIncluded: includedPaths.length,
        estimatedTokens: 10,
        securityFindings: security.safeFindings.length,
        truncationNote: noteFor(truncation),
        budget,
      },
    };
  }

  // ---- mode handling ----

  private resolvePinned(request: ContextRequest): string[] {
    if (request.mode === "file" && request.activeFile) return [request.activeFile];
    if (request.mode === "selection") return request.selectedPaths ?? [];
    return [];
  }

  private retrieveForMode(request: ContextRequest, pinnedPaths: string[]): RetrievalResult {
    const opts = {
      maxGraphDepth: this.deps.budget.maxGraphDepth,
      enableGitRecency: this.deps.enableGitRecency,
      pinnedPaths,
      limit: request.candidateLimit ?? 60,
    };
    if (request.mode === "project") {
      return this.retrieveProject(opts, request.scope);
    }
    if (request.mode === "file" && request.activeFile) {
      const entry = this.deps.entries.get(request.activeFile);
      const queryParts = new Set<string>();
      // Strip the extension before splitting: the "ts" fragment would
      // lexically match every TypeScript file and dilute the seed query.
      const base = request.activeFile
        .slice(request.activeFile.lastIndexOf("/") + 1)
        .replace(/\.[^.]+$/, "");
      for (const part of base.split(/[._-]+/)) queryParts.add(part);
      for (const sym of (entry?.symbols ?? []).slice(0, 8)) queryParts.add(sym.name);
      return this.deps.retriever.retrieve([...queryParts].join(" "), opts);
    }
    if (request.mode === "selection") {
      if (!request.expandSelection) {
        return {
          query: "(user selection)",
          analysis: {
            words: [],
            terms: [],
            identifierCandidates: [],
            exactCandidates: [],
            fileHints: [],
            quotedPhrases: [],
          },
          ranked: pinnedPaths.map((p) => ({ path: p, score: 0, signals: [] })),
          symbolHits: [],
        };
      }
      const query = pinnedPaths
        .map((p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""))
        .join(" ");
      return this.deps.retriever.retrieve(query, opts);
    }
    // task mode
    return this.deps.retriever.retrieve(request.taskText ?? "", opts);
  }

  private retrieveProject(
    opts: {
      maxGraphDepth: number;
      enableGitRecency?: boolean;
      pinnedPaths: string[];
      limit: number;
    },
    scope?: ContextScope,
  ): RetrievalResult {
    const { entries, graph } = this.deps;
    // Folder scope restricts the ROOT selection to the subtree; relationship
    // expansion below still visits cross-boundary edges so "this file imports
    // something outside the folder" stays explainable. An empty relPath (the
    // workspace root itself) is equivalent to no scope.
    const folderRaw = scope?.kind === "folder" ? scope.relPath : null;
    const folder = folderRaw === "" || folderRaw === "." ? null : folderRaw;
    const underFolder = (p: string): boolean => folder === null || isUnderPath(p, folder);

    // Entry points / hubs are ranked among the scoped universe with degrees
    // still computed project-wide (cross-boundary connectivity counts).
    const scopedEntries = folder === null ? entries : filterEntriesUnder(entries, folder);
    const ranked: ScoredFile[] = [];
    const seen = new Set<string>();
    for (const path of findEntryPoints(scopedEntries)) {
      if (!underFolder(path)) continue;
      ranked.push({ path, score: 1, signals: [{ kind: "ENTRY_POINT", weight: 1, detail: "" }] });
      seen.add(path);
    }
    for (const hub of findHubFiles(graph, scopedEntries, 12)) {
      if (seen.has(hub.path) || !underFolder(hub.path)) continue;
      ranked.push({
        path: hub.path,
        score: hub.degree / 20,
        signals: [{ kind: "HUB", weight: hub.degree / 20, detail: `degree ${hub.degree}` }],
      });
      seen.add(hub.path);
    }
    for (const path of [...entries.keys()].sort(compareStrings)) {
      const entry = entries.get(path);
      if (entry && /^readme\.md$/i.test(path) && !seen.has(path) && underFolder(path)) {
        ranked.push({
          path,
          score: 0.5,
          signals: [{ kind: "HUB", weight: 0.5, detail: "project README" }],
        });
        seen.add(path);
      }
    }
    ranked.sort((a, b) => b.score - a.score || compareStrings(a.path, b.path));

    if (folder !== null) {
      // Structural signals around the folder's seeds (depth-limited, sorted):
      // files inside the folder gain explainable dependency/dependent reasons,
      // including edges that cross the folder boundary.
      const seeds = ranked.map((r) => r.path);
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
        if (path === other || !underFolder(path)) return;
        const key = `${path}\u0000${kind}\u0000${other}`;
        const cur = structural.get(key);
        if (!cur || cur.weight < weight) structural.set(key, { kind, other, weight });
      };
      const expanded = traverseBidirectional(
        graph,
        seeds.map((p) => `file:${p}`),
        opts.maxGraphDepth,
      );
      for (const edge of expanded.edges) {
        const sourceFile = fileOfNode(edge.source);
        const targetFile = fileOfNode(edge.target);
        if (sourceFile === null || targetFile === null || sourceFile === targetFile) continue;
        switch (edge.kind) {
          case "imports":
          case "references":
            addStructural(sourceFile, "DIRECT_DEPENDENT", targetFile, 0.5);
            addStructural(targetFile, "DIRECT_DEPENDENCY", sourceFile, 0.6);
            break;
          case "calls":
            addStructural(sourceFile, "CALL_EDGE", targetFile, 0.5);
            addStructural(targetFile, "CALL_EDGE", sourceFile, 0.5);
            break;
          case "tests":
            addStructural(sourceFile, "TEST_OF", targetFile, 0.7);
            break;
          case "extends":
          case "implements":
            addStructural(sourceFile, "INHERITANCE", targetFile, 0.6);
            break;
          default:
            break;
        }
      }
      // Same total-structural cap as the hybrid retriever (hub damping).
      const perPath = new Map<
        string,
        Array<{ kind: RankingSignal["kind"]; other: string; weight: number }>
      >();
      for (const [key, s] of structural) {
        const path = key.split("\u0000")[0];
        const list = perPath.get(path) ?? [];
        list.push(s);
        perPath.set(path, list);
      }
      for (const [path, list] of perPath) {
        const total = list.reduce((a, s) => a + s.weight, 0);
        const scale = total > 1.0 ? 1.0 / total : 1;
        const existing = ranked.find((r) => r.path === path);
        const signals = list.map((s) => ({
          kind: s.kind,
          weight: s.weight * scale,
          detail: s.other,
        }));
        if (existing) {
          existing.signals = [...existing.signals, ...signals];
          existing.score += signals.reduce((a, s) => a + s.weight, 0);
        } else {
          ranked.push({ path, score: signals.reduce((a, s) => a + s.weight, 0), signals });
          seen.add(path);
        }
      }

      // Tail: remaining files of the subtree (deterministic path order) so a
      // low-connectivity folder still offers its files; the budget degrades
      // them to metadata-only entries as needed.
      for (const path of [...scopedEntries.keys()].sort(compareStrings)) {
        if (!seen.has(path)) ranked.push({ path, score: 0, signals: [] });
      }
      ranked.sort((a, b) => b.score - a.score || compareStrings(a.path, b.path));
    }

    return {
      query: folder !== null ? `(project overview: ${folder}/)` : "(project overview)",
      analysis: {
        words: [],
        terms: [],
        identifierCandidates: [],
        exactCandidates: [],
        fileHints: [],
        quotedPhrases: [],
      },
      ranked: ranked.slice(0, opts.limit),
      symbolHits: [],
    };
  }

  // ---- helpers ----

  private screenCandidates(candidates: RankedCandidate[]): SecurityVerdict {
    const toScan = candidates
      .map((c) => ({ path: c.path, entry: this.deps.entries.get(c.path) }))
      .filter((c): c is { path: string; entry: FileEntry } => c.entry !== undefined)
      .filter(
        (c) => c.entry.meta.parseStatus === "PARSED" || c.entry.meta.parseStatus === "GENERIC",
      )
      .map((c) => ({
        path: c.path,
        entry: c.entry,
        content: safeRead(this.deps.readFile, c.path),
      }))
      .filter((c) => c.content !== null)
      .map((c) => ({ path: c.path, entry: c.entry, content: c.content as string }));
    return applySecurityPolicy(toScan, this.deps.security);
  }

  /**
   * Truncation ladder: FULL → SYMBOLS → SIGNATURES → METADATA.
   * Returns the largest representation that fits the remaining budget,
   * measured exactly (byte-identical to what will be rendered).
   */
  private assembleSource(
    path: string,
    entry: FileEntry,
    ledger: BudgetLedger,
    redactedContent: Map<string, string>,
  ): { section: SourceFileSection; level: TruncationLevel } | null {
    const content = redactedContent.get(path) ?? safeRead(this.deps.readFile, path);
    if (content === null) return null;
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const language = entry.meta.language;

    const sectionFor = (blocks: SourceBlock[]): SourceFileSection => ({
      path,
      language,
      blocks,
    });
    const renderedSize = (section: SourceFileSection): { chars: number; lines: number } => {
      const text = renderSourceFileSection(section);
      return { chars: text.length, lines: countPayloadLines(text) };
    };
    const fits = (
      section: SourceFileSection,
    ): { section: SourceFileSection; size: { chars: number; lines: number } } | null => {
      const size = renderedSize(section);
      if (ledger.canAdd(size.chars, size.lines)) return { section, size };
      return null;
    };

    // FULL (capped at maxCodeLinesPerFile; longer files degrade to SYMBOLS).
    if (lines.length <= this.deps.budget.maxCodeLinesPerFile) {
      const section = sectionFor([
        { startLine: 1, endLine: lines.length, text: renderCodeBlock(lines, 1) },
      ]);
      const ok = fits(section);
      if (ok) {
        ledger.add(ok.size.chars, ok.size.lines);
        return { section, level: "FULL" };
      }
    }

    // SYMBOLS: ranges of defined symbols (sorted by line), greedily included.
    // Exact accounting: re-measure the whole candidate section each iteration
    // and only commit the final measurement to the ledger.
    const symbolRanges = [...entry.symbols]
      .filter((s) => s.kind !== "json-key")
      .sort((a, b) => a.startLine - b.startLine || compareStrings(a.id, b.id))
      .slice(0, 20)
      .map((s) => ({
        start: Math.max(1, s.startLine),
        end: Math.min(lines.length, s.endLine),
      }))
      .filter((r) => r.end >= r.start);
    const symbolBlocks: SourceBlock[] = [];
    for (const range of symbolRanges) {
      const candidate = sectionFor([
        ...symbolBlocks,
        {
          startLine: range.start,
          endLine: range.end,
          text: renderCodeBlock(lines.slice(range.start - 1, range.end), range.start),
        },
      ]);
      const size = renderedSize(candidate);
      if (!ledger.canAdd(size.chars, size.lines)) break;
      symbolBlocks.push(candidate.blocks[candidate.blocks.length - 1]);
    }
    if (symbolBlocks.length > 0) {
      const section = sectionFor(symbolBlocks);
      const size = renderedSize(section);
      if (ledger.canAdd(size.chars, size.lines)) {
        ledger.add(size.chars, size.lines);
        return { section, level: "SYMBOLS" };
      }
    }

    // SIGNATURES: signatures + locations only.
    const signatureLines = entry.symbols
      .filter((s) => s.signature)
      .sort((a, b) => a.startLine - b.startLine)
      .slice(0, 40)
      .map((s) => `${s.startLine}: ${s.signature}`);
    if (signatureLines.length > 0) {
      const section = sectionFor([
        { startLine: 1, endLine: lines.length, text: signatureLines.join("\n") },
      ]);
      const ok = fits(section);
      if (ok) {
        ledger.add(ok.size.chars, ok.size.lines);
        return { section, level: "SIGNATURES" };
      }
    }
    return null;
  }

  private buildSymbolLines(includedPaths: string[]): ContextModel["symbols"] {
    const symbols: ContextModel["symbols"] = [];
    for (const path of includedPaths) {
      const entry = this.deps.entries.get(path);
      if (!entry) continue;
      for (const sym of entry.symbols) {
        if (sym.kind === "json-key") continue;
        symbols.push({
          path,
          line: sym.startLine,
          label: `${sym.kind} ${sym.name}${sym.signature ? `: ${sym.signature}` : ""}`.slice(
            0,
            160,
          ),
        });
      }
    }
    return symbols
      .sort(
        (a, b) =>
          compareStrings(a.path, b.path) || a.line - b.line || compareStrings(a.label, b.label),
      )
      .slice(0, 300);
  }

  private buildArchitecture(
    entries: Map<string, FileEntry>,
    graph: RelationshipGraph,
  ): ContextModel["architecture"] {
    const dirCounts = new Map<string, number>();
    for (const path of entries.keys()) {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "(root)";
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
    const directories = [...dirCounts.entries()]
      .map(([path, fileCount]) => ({ path, fileCount }))
      .sort((a, b) => b.fileCount - a.fileCount || compareStrings(a.path, b.path))
      .slice(0, 12);
    const hubs = findHubFiles(graph, entries, 8).map((h) => ({
      path: h.path,
      imports: graph.fileDependencies(h.path).length,
      importedBy: graph.fileDependents(h.path).length,
    }));
    const externals = graph.allExternalPackages().slice(0, 30);
    return { directories, hubs, externals };
  }
}

function scoredFromCandidate(candidate: RankedCandidate): ScoredFile {
  return { path: candidate.path, score: candidate.score, signals: candidate.signals };
}

/**
 * Renders the final payload with a self-consistent token estimate: the
 * header's ESTIMATED_TOKENS depends on payload length, which depends on the
 * header. Converges in 2 iterations in practice; capped for safety.
 */
function renderWithTokenConvergence(model: ContextModel): {
  payload: string;
  chars: number;
  lines: number;
  estimatedTokens: number;
} {
  let tokens = 10;
  for (let i = 0; i < 5; i++) {
    model.metadata.estimatedTokens = tokens;
    const payload = formatContext(model);
    const next = estimateTokensApprox(payload.length);
    const chars = payload.length;
    const lines = countPayloadLines(payload);
    if (next === tokens) {
      return { payload, chars, lines, estimatedTokens: next };
    }
    tokens = next;
  }
  const payload = formatContext(model);
  return {
    payload,
    chars: payload.length,
    lines: countPayloadLines(payload),
    estimatedTokens: model.metadata.estimatedTokens,
  };
}

function safeRead(readFile: (p: string) => string, path: string): string | null {
  try {
    return readFile(path);
  } catch {
    return null;
  }
}

/** Subset of entries whose paths lie under `folder` (folder scope universe). */
function filterEntriesUnder(
  entries: Map<string, FileEntry>,
  folder: string,
): Map<string, FileEntry> {
  const filtered = new Map<string, FileEntry>();
  for (const [path, entry] of entries) {
    if (isUnderPath(path, folder)) filtered.set(path, entry);
  }
  return filtered;
}

/** Maps a graph node id to its file path (file: and symbol: nodes only). */
function fileOfNode(node: string): string | null {
  if (node.startsWith("file:")) return node.slice(5);
  if (node.startsWith("symbol:")) {
    const id = node.slice(7);
    const hash = id.indexOf("#");
    return hash === -1 ? null : id.slice(0, hash);
  }
  return null;
}

export function computeIndexVersion(entries: Map<string, FileEntry>): string {
  const lines: string[] = [];
  for (const path of [...entries.keys()].sort(compareStrings)) {
    lines.push(`${path}:${entries.get(path)?.meta.contentHash ?? ""}`);
  }
  return sha256Hex(lines.join("\n")).slice(0, 12);
}

export { TIER_ORDER_SIGNAL_WEIGHT };
