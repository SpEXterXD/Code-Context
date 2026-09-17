import type { Language, SymbolDef, ImportDecl, ExportDecl, CallSite } from "../domain/model";

export interface HeritageInfo {
  /** Name of the class/interface declaring the heritage clause. */
  symbolName: string;
  kind: "extends" | "implements";
  /** Parent names as written in source. */
  parents: string[];
  startLine: number;
}

/** Normalized output of one parser run. */
export interface ParsedFile {
  path: string;
  language: Language;
  symbols: SymbolDef[];
  imports: ImportDecl[];
  exports: ExportDecl[];
  calls: CallSite[];
  heritages: HeritageInfo[];
  /** File-level summary used by lexical search (file docblock, MD title, JSON top-level keys). */
  fileSummary?: string;
  /** Unique identifiers harvested from source text (capped); powers lexical search. */
  identifiers?: string[];
  parseError?: string;
}

export interface SourceParser {
  readonly language: Language;
  supports(path: string): boolean;
  parse(path: string, content: string): ParsedFile;
}

/**
 * Parser registry. Downstream code resolves a parser via `supports()` and
 * never depends on a concrete parser class. Unknown languages fall back to
 * the generic parser (metadata only).
 */
export class ParserRegistry {
  private readonly parsers: SourceParser[];

  constructor(parsers: SourceParser[]) {
    this.parsers = [...parsers];
  }

  resolve(path: string): SourceParser {
    for (const p of this.parsers) {
      if (p.supports(path)) return p;
    }
    return this.parsers[this.parsers.length - 1]; // generic parser is last
  }

  parsersSnapshot(): string[] {
    return this.parsers.map((p) => p.language);
  }
}
