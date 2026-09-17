import type { FileEntry, FileMeta, Relationship, SymbolDef } from "../domain/model";
import type { ParsedFile } from "../parser/parser";
import { fileNodeId, externalNodeId } from "../shared/ids";
import { compareStrings } from "../shared/text";
import { ImportResolver, type ResolutionOutcome } from "./importResolver";
import { sourceFileOfTestFile } from "../workspace/languageDetection";

/**
 * Turns a ParsedFile plus repo-wide context (known files, export index,
 * existing entries) into the file's complete outgoing relationship set.
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
  private /** name -> sorted file paths exporting that name */ exportIndex: Map<string, string[]>;
  private entries: Map<string, FileEntry>;

  constructor(rootPath: string, knownFiles: Set<string>, entries: Map<string, FileEntry>) {
    this.resolver = new ImportResolver(rootPath, knownFiles);
    this.knownFiles = knownFiles;
    this.entries = entries;
    this.exportIndex = buildExportIndex(entries);
  }

  /**
   * Replaces the entry view used for cross-file resolution. Callers staging a
   * batch pass this map so edges between simultaneously-changed files resolve
   * against the fresh state instead of the stale index.
   */
  setEntriesView(entries: Map<string, FileEntry>): void {
    this.entries = entries;
    this.exportIndex = buildExportIndex(entries);
  }

  /** Rebuilds the export index (used after batch upserts). */
  refreshExportIndex(entries: Map<string, FileEntry>): void {
    this.setEntriesView(entries);
  }

  /** Computes the full FileEntry for one parsed file. */
  buildFileEntry(meta: FileMeta, parsed: ParsedFile): FileEntry {
    const internalRelations = this.computeRelationships(meta, parsed);
    const mdStats = (parsed as { markdownStats?: { codeFenceLanguages: string[] } }).markdownStats;
    const fileSummary = mdStats
      ? [
          parsed.fileSummary,
          mdStats.codeFenceLanguages.length > 0
            ? `code: ${mdStats.codeFenceLanguages.join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join(" | ")
      : parsed.fileSummary;
    return {
      meta,
      symbols: parsed.symbols,
      imports: parsed.imports,
      exports: parsed.exports,
      calls: parsed.calls,
      fileSummary: fileSummary || undefined,
      identifiers: parsed.identifiers,
      internalRelations,
    };
  }

  /**
   * All outgoing edges for one file:
   * imports / references / calls / extends / implements / tests / depends_on.
   */
  computeRelationships(meta: FileMeta, parsed: ParsedFile): Relationship[] {
    const relations: Relationship[] = [];
    const fileNode = fileNodeId(meta.path);
    const importedNames = new Map<string, string[]>(); // repo path -> names imported

    for (const imp of parsed.imports) {
      const outcome: ResolutionOutcome = this.resolver.resolve(imp.sourceText, meta.path);
      if (outcome.status === "RESOLVED") {
        relations.push({
          source: fileNode,
          target: fileNodeId(outcome.path),
          kind: "imports",
          provenance: "STATIC_EXACT",
          detail: `import "${imp.sourceText}" (${imp.importedNames.join(", ")})`,
        });
        const prev = importedNames.get(outcome.path) ?? [];
        importedNames.set(outcome.path, [...prev, ...imp.importedNames]);
        // Symbol-level references for names the target actually exports.
        const targetEntry = this.entries.get(outcome.path);
        if (targetEntry) {
          for (const name of imp.importedNames) {
            if (name === "*") continue;
            const target = findExportedSymbol(targetEntry.symbols, name, outcome.path);
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
    const localSymbolsByName = groupByName(parsed.symbols);
    for (const call of parsed.calls) {
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
      const imported = this.findImportedDefinition(meta.path, parsed, call.calleeName);
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
    for (const heritage of parsed.heritages) {
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
        const importedParent = this.findImportedDefinition(meta.path, parsed, parentName);
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

  private findImportedDefinition(
    importerPath: string,
    parsed: ParsedFile,
    name: string,
  ): SymbolDef | undefined {
    for (const imp of parsed.imports) {
      if (!imp.importedNames.includes(name)) continue;
      const outcome = this.resolver.resolve(imp.sourceText, importerPath);
      if (outcome.status !== "RESOLVED") continue;
      const targetEntry = this.entries.get(outcome.path);
      if (!targetEntry) continue;
      const target = findExportedSymbol(targetEntry.symbols, name, outcome.path);
      if (target) return target;
      // Default import name → target's default export.
      const def = targetEntry.symbols.find((s) => s.exportKind === "default");
      if (imp.importedNames.includes("default") && def) return def;
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
    return findExportedSymbol(entry.symbols, name, filePath);
  }
}

export function buildExportIndex(entries: Map<string, FileEntry>): Map<string, string[]> {
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

function findExportedSymbol(
  symbols: SymbolDef[],
  name: string,
  _filePath: string,
): SymbolDef | undefined {
  return (
    symbols.find((s) => s.name === name && s.exportKind !== undefined) ??
    symbols.find((s) => s.name === name && !s.name.includes(".")) ??
    symbols.find((s) => s.name === name)
  );
}

function compareRelations(a: Relationship, b: Relationship): number {
  const byKind = compareStrings(a.kind, b.kind);
  if (byKind !== 0) return byKind;
  const bySource = compareStrings(a.source, b.source);
  if (bySource !== 0) return bySource;
  return compareStrings(a.target, b.target);
}
