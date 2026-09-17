import type { SourceParser } from "./parser";

/**
 * Fallback parser for all other file types: metadata only (the FileMeta is
 * produced by the scanner; no symbols/imports). This makes the registry total:
 * every supported path resolves to a parser.
 */
export class GenericParser implements SourceParser {
  readonly language = "generic" as const;

  supports(_path: string): boolean {
    return true;
  }

  parse(path: string, _content: string): import("./parser").ParsedFile {
    return {
      path,
      language: "generic",
      symbols: [],
      imports: [],
      exports: [],
      calls: [],
      heritages: [],
    };
  }
}
