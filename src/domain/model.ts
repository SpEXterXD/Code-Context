/** Supported analysis levels. `generic` = metadata only, no deep parsing. */
export type Language = "typescript" | "javascript" | "json" | "markdown" | "generic";

export type ParseStatus = "PARSED" | "GENERIC" | "SKIPPED_BINARY" | "SKIPPED_TOO_LARGE" | "FAILED";

/** Metadata + parse result for one file. Content hash gates all re-analysis. */
export interface FileMeta {
  path: string; // POSIX, workspace-relative
  language: Language;
  sizeBytes: number;
  lineCount: number;
  contentHash: string; // sha256 hex of raw content
  isTest: boolean;
  parseStatus: ParseStatus;
  parseError?: string;
}

export type SymbolKind =
  | "class"
  | "interface"
  | "function"
  | "method"
  | "property"
  | "variable"
  | "type"
  | "enum"
  | "namespace"
  | "heading"
  | "json-key";

export interface SymbolDef {
  id: string; // deterministic: path#name@kind:line
  name: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number; // 1-based inclusive
  endLine: number; // 1-based inclusive
  signature?: string;
  docComment?: string;
  /** Whether this symbol is exported from its file, and how. */
  exportKind?: "named" | "default";
  parentId?: string; // e.g. class for methods
}

export interface ImportDecl {
  /** Raw module specifier as written in source. */
  sourceText: string;
  /** Names imported: identifiers, or "default", or "*". */
  importedNames: string[];
  startLine: number;
  /** True for bare package specifiers (node_modules / builtins). */
  isExternal: boolean;
}

export interface ExportDecl {
  name: string; // identifier, "default", or "*"
  startLine: number;
}

export interface CallSite {
  /** Symbol id of the enclosing definition that performs the call. */
  callerId: string;
  /** Callee as written: identifier or final property segment. */
  calleeName: string;
  startLine: number;
}

export type EdgeKind =
  | "imports"
  | "exports"
  | "references"
  | "calls"
  | "extends"
  | "implements"
  | "tests"
  | "contains"
  | "depends_on";

export type Provenance = "STATIC_EXACT" | "STATIC_HEURISTIC" | "UNRESOLVED";

export interface Relationship {
  source: string; // node id (file:, dir:, symbol:, external:)
  target: string;
  kind: EdgeKind;
  provenance: Provenance;
  detail?: string;
}

/**
 * The full per-file analysis record persisted to the local index. One entry =
 * one atomic transaction unit: an entry file is either fully written or not
 * replaced at all.
 */
export interface FileEntry {
  meta: FileMeta;
  symbols: SymbolDef[];
  imports: ImportDecl[];
  exports: ExportDecl[];
  calls: CallSite[];
  /** File-level summary for retrieval (file docblock, MD title, JSON top-level keys). */
  fileSummary?: string;
  /** Unique source identifiers (capped) harvested by the parser, for lexical search. */
  identifiers?: string[];
  /** Relationships between symbols within this file (extends/implements/calls). */
  internalRelations: Relationship[];
}
