import type { FileEntry, FileMeta, Relationship, SymbolDef } from "../domain/model";
import type { ParsedFile } from "../parser/parser";
import { fileNodeId, externalNodeId } from "../shared/ids";
import { compareStrings } from "../shared/text";
import { ImportResolver, type AliasMapping, type ResolutionOutcome } from "./importResolver";
import { sourceFileOfTestFile } from "../workspace/languageDetection";

/**
 * Resolves a file's structural data against the workspace's staged entries.
 *
 * Every relationship carries an explicit provenance:
 * - STATIC_EXACT: resolved against the real file/exports/symbol tables
 * - STATIC_HEURISTIC: unique global-name or naming-convention match
 * - UNRESOLVED: destination could not be determined; the target node is
 *                    `unresolved:<specifier>` and is never fabricated.
 *
 * Re-analyzing one file recomputes only that file's outgoing edges; incoming
 * edges are derived by the graph on upsert, so incremental updates are local.
 */
export class AnalysisEngine {
  private readonly resolver: ImportResolver;
  private readonly knownFiles: Set<string>;
  private readonly exportIndex: Map<string, string[]>;

  constructor(
    private readonly entries: ReadonlyMap<string, FileEntry>,
    aliases: AliasMapping,
  ) {
    this.knownFiles = new Set(entries.keys());
    this.resolver = new ImportResolver(this.knownFiles, aliases);
    this.exportIndex = buildExportIndex(entries);
  }

  /** Checks prior targets and newly resolvable candidates against the staged files. */
  isAffected(entry: FileEntry, paths: ReadonlySet<string>, names: ReadonlySet<string>): boolean {
    return (
      entry.internalRelations.some(
        (r) => r.target.startsWith("file:") && paths.has(r.target.slice("file:".length)),
      ) ||
      entry.imports.some((imp) => {
        const outcome = this.resolver.resolve(imp.sourceText, entry.meta.path);
        return outcome.status === "RESOLVED" && paths.has(outcome.path);
      }) ||
      entry.calls.some((call) => names.has(call.calleeName)) ||
      (entry.heritages?.some((clause) => clause.parents.some((name) => names.has(name))) ??
        false) ||
      (entry.meta.isTest && paths.has(sourceFileOfTestFile(entry.meta.path) ?? ""))
    );
  }

  /** Resolves a stored entry against the staged workspace without reading its source. */
  recomputeRelations(entry: FileEntry): FileEntry {
    const internalRelations = this.computeRelationships(entry);
    return { ...entry, internalRelations };
  }

  /**
   * All outgoing edges for one file:
   * imports / references / calls / extends / implements / tests / depends_on.
   */
  private computeRelationships(entry: FileEntry): Relationship[] {
    const { meta, imports, symbols, calls, heritages } = entry;
    const relations: Relationship[] = [];
    const fileNode = fileNodeId(meta.path);
    for (const imp of imports) {
      const outcome: ResolutionOutcome = this.resolver.resolve(imp.sourceText, meta.path);
      if (outcome.status === "RESOLVED") {
        relations.push({
          source: fileNode,
          target: fileNodeId(outcome.path),
          kind: "imports",
          provenance: "STATIC_EXACT",
          detail: `import "${imp.sourceText}" (${imp.importedNames.join(", ")})`,
        });
        // Symbol-level references for names the target actually exports.
        const targetEntry = this.entries.get(outcome.path);
        if (targetEntry) {
          for (const name of imp.importedNames) {
            if (name === "*") continue;
            const target = findExportedSymbol(targetEntry, name);
            if (target) {
              relations.push({
                source: fileNode,
                target: `symbol:${target.id}`,
                kind: "references",
                provenance: "STATIC_EXACT",
                detail: `${meta.path} imports ${name}`,
              });
            } else if (!targetEntry.exports.some((e) => e.name === name || e.name === "*")) {
              relations.push({
                source: fileNode,
                target: `unresolved:${outcome.path}#${name}`,
                kind: "references",
                provenance: "UNRESOLVED",
                detail: `"${name}" is not exported by ${outcome.path}`,
              });
            }
          }
        }
      } else if (outcome.status === "EXTERNAL") {
        relations.push({
          source: fileNode,
          target: externalNodeId(outcome.pkg),
          kind: "imports",
          provenance: "STATIC_EXACT",
          detail: `external "${imp.sourceText}"`,
        });
      } else {
        relations.push({
          source: fileNode,
          target: `unresolved:${imp.sourceText}`,
          kind: "imports",
          provenance: "UNRESOLVED",
          detail: outcome.reason,
        });
      }
    }

    // Call graph: caller symbol -> callee definition.
    const localSymbolsByName = groupByName(symbols);
    for (const call of calls) {
      if (call.callerId.startsWith("file:")) continue; // top-level calls have no meaningful caller
      const local = localSymbolsByName.get(call.calleeName);
      if (local) {
        relations.push({
          source: `symbol:${call.callerId}`,
          target: `symbol:${local.id}`,
          kind: "calls",
          provenance: "STATIC_EXACT",
          detail: `call at ${meta.path}:${call.startLine}`,
        });
        continue;
      }
      const imported = this.findImportedDefinition(entry, call.calleeName);
      if (imported) {
        relations.push({
          source: `symbol:${call.callerId}`,
          target: `symbol:${imported.id}`,
          kind: "calls",
          provenance: "STATIC_EXACT",
          detail: `call at ${meta.path}:${call.startLine} (imported from ${imported.filePath})`,
        });
        continue;
      }
      const heuristic = this.uniqueGlobalSymbol(call.calleeName, meta.path);
      if (heuristic) {
        relations.push({
          source: `symbol:${call.callerId}`,
          target: `symbol:${heuristic.id}`,
          kind: "calls",
          provenance: "STATIC_HEURISTIC",
          detail: `unique exported name "${call.calleeName}" in ${heuristic.filePath}`,
        });
      }
      // else: no fabrication. Dynamic dispatch and unknown callees are unmodeled.
    }

    // Inheritance: extends / implements.
    for (const heritage of heritages ?? []) {
      const owner = localSymbolsByName.get(heritage.symbolName);
      if (!owner) continue;
      for (const parentName of heritage.parents) {
        const parentLocal = localSymbolsByName.get(parentName);
        if (parentLocal) {
          relations.push({
            source: `symbol:${owner.id}`,
            target: `symbol:${parentLocal.id}`,
            kind: heritage.kind,
            provenance: "STATIC_EXACT",
          });
          continue;
        }
        const importedParent = this.findImportedDefinition(entry, parentName);
        if (importedParent) {
          relations.push({
            source: `symbol:${owner.id}`,
            target: `symbol:${importedParent.id}`,
            kind: heritage.kind,
            provenance: "STATIC_EXACT",
            detail: `imported from ${importedParent.filePath}`,
          });
          continue;
        }
        const heuristicParent = this.uniqueGlobalSymbol(parentName, meta.path);
        if (heuristicParent) {
          relations.push({
            source: `symbol:${owner.id}`,
            target: `symbol:${heuristicParent.id}`,
            kind: heritage.kind,
            provenance: "STATIC_HEURISTIC",
            detail: `unique exported name "${parentName}" in ${heuristicParent.filePath}`,
          });
        } else {
          relations.push({
            source: `symbol:${owner.id}`,
            target: `unresolved:${parentName}`,
            kind: heritage.kind,
            provenance: "UNRESOLVED",
            detail: `"${parentName}" not found locally or via imports`,
          });
        }
      }
    }

    // Test relationship heuristic (confidence-labeled, documented as heuristic).
    if (meta.isTest) {
      const sourcePath = sourceFileOfTestFile(meta.path);
      if (sourcePath && this.knownFiles.has(sourcePath)) {
        relations.push({
          source: fileNode,
          target: fileNodeId(sourcePath),
          kind: "tests",
          provenance: "STATIC_HEURISTIC",
          detail: "naming convention (<name>.test.<ext>)",
        });
      }
    }

    // depends_on: coarse aggregation emitted at graph level, not per entry.
    return relations.sort(compareRelations);
  }

  private findImportedDefinition(entry: FileEntry, name: string): SymbolDef | undefined {
    for (const imp of entry.imports) {
      // Resolve the local binding first. A name used only on the exported
      // side of an alias is unavailable locally under that name.
      const bindings = imp.aliasedNames ?? [];
      const alias = bindings.find((a) => a.local === name);
      if (!alias) {
        const importsWithName = imp.importedNames.filter((n) => n === name).length;
        const renamedImports = bindings.filter((a) => a.imported === name).length;
        if (importsWithName <= renamedImports) continue;
      }
      const outcome = this.resolver.resolve(imp.sourceText, entry.meta.path);
      if (outcome.status !== "RESOLVED") continue;
      const targetEntry = this.entries.get(outcome.path);
      if (!targetEntry) continue;
      const target = findExportedSymbol(targetEntry, alias?.imported ?? name);
      if (target) return target;
    }
    return undefined;
  }

  private uniqueGlobalSymbol(name: string, excludeFile: string): SymbolDef | undefined {
    const files = this.exportIndex.get(name);
    if (!files || files.length !== 1) return undefined;
    const filePath = files[0];
    if (filePath === excludeFile) return undefined;
    const entry = this.entries.get(filePath);
    if (!entry) return undefined;
    return entry.symbols.find((s) => s.name === name && s.exportKind !== undefined);
  }
}

export function buildExportIndex(entries: Iterable<[string, FileEntry]>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [filePath, entry] of entries) {
    const exportedNames = new Set(entry.exports.map((e) => e.name));
    for (const sym of entry.symbols) {
      if (sym.exportKind === undefined && !exportedNames.has(sym.name)) continue;
      if (sym.kind === "heading" || sym.kind === "json-key") continue;
      const list = index.get(sym.name) ?? [];
      if (!list.includes(filePath)) list.push(filePath);
      index.set(sym.name, list);
    }
  }
  for (const list of index.values()) list.sort(compareStrings);
  return index;
}

function groupByName(symbols: SymbolDef[]): Map<string, SymbolDef> {
  const map = new Map<string, SymbolDef>();
  for (const s of symbols) {
    const short = s.name.includes(".") ? s.name.slice(s.name.lastIndexOf(".") + 1) : s.name;
    if (!map.has(short)) map.set(short, s); // first by source order for duplicate short names
  }
  return map;
}

function findExportedSymbol(entry: FileEntry, name: string): SymbolDef | undefined {
  // Review fix (follow-up 4): cross-file EXACT resolution must target an
  // actually EXPORTED declaration. The previous fallback to any same-name
  // symbol gave STATIC_EXACT provenance to non-exported definitions, which
  // are invisible across module boundaries.
  if (name === "default") return entry.symbols.find((s) => s.exportKind === "default");
  return entry.symbols.find(
    (s) =>
      s.name === name &&
      (s.exportKind === "named" ||
        (s.exportKind === "default" && entry.exports.some((e) => e.name === name))),
  );
}

/** Creates an entry before cross-file analysis, so a whole batch can resolve together. */
export function buildFileEntry(meta: FileMeta, parsed: ParsedFile): FileEntry {
  const mdStats = (parsed as { markdownStats?: { codeFenceLanguages: string[] } }).markdownStats;
  const codeLanguages = mdStats?.codeFenceLanguages ?? [];
  const fileSummary = [
    parsed.fileSummary,
    codeLanguages.length > 0 ? `code: ${codeLanguages.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
  return {
    meta,
    symbols: parsed.symbols,
    imports: parsed.imports,
    exports: parsed.exports,
    calls: parsed.calls,
    heritages: parsed.heritages,
    fileSummary: fileSummary || undefined,
    identifiers: parsed.identifiers,
    internalRelations: [],
  };
}

function compareRelations(a: Relationship, b: Relationship): number {
  const byKind = compareStrings(a.kind, b.kind);
  if (byKind !== 0) return byKind;
  const bySource = compareStrings(a.source, b.source);
  if (bySource !== 0) return bySource;
  return compareStrings(a.target, b.target);
}
