import type { SymbolDef } from "../domain/model";
import { symbolId } from "../shared/ids";
import type { SourceParser } from "./parser";
import { extName } from "../shared/ids";

const MAX_HEADINGS = 150;

export interface MarkdownStats {
  wordCount: number;
  codeFenceLanguages: string[];
  linkCount: number;
}

/**
 * Markdown parser: ATX headings become `heading` symbols (with level encoded
 * via parentId of the enclosing heading), plus document stats used by
 * retrieval (code fence languages, links, word count).
 */
export class MarkdownParser implements SourceParser {
  readonly language = "markdown" as const;

  supports(path: string): boolean {
    const ext = extName(path);
    return ext === ".md" || ext === ".markdown";
  }

  parse(path: string, content: string): ParsedResult {
    const lines = content.split(/\r?\n/);
    const symbols: SymbolDef[] = [];
    const fenceLanguages = new Set<string>();
    let linkCount = 0;
    let wordCount = 0;
    let inFence = false;
    let fenceLang = "";
    const headingStack: { level: number; id: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^\s*```\s*([A-Za-z0-9_+-]*)\s*$/);
      if (fence) {
        if (!inFence) {
          inFence = true;
          fenceLang = fence[1];
          if (fenceLang) fenceLanguages.add(fenceLang);
        } else {
          inFence = false;
        }
        continue;
      }
      if (inFence) continue;

      wordCount += line.split(/\s+/).filter(Boolean).length;
      linkCount += (line.match(/\[[^\]]*\]\([^)]*\)/g) ?? []).length;

      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
      if (heading && symbols.length < MAX_HEADINGS) {
        const level = heading[1].length;
        const title = heading[2].trim();
        const id = symbolId(path, title, "heading", i + 1);
        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop();
        }
        symbols.push({
          id,
          name: title,
          kind: "heading",
          filePath: path,
          startLine: i + 1,
          endLine: i + 1,
          signature: `${"#".repeat(level)} ${title}`,
          parentId: headingStack.length > 0 ? headingStack[headingStack.length - 1].id : undefined,
        });
        headingStack.push({ level, id });
      }
    }

    const firstHeading = symbols.find((s) => s.signature?.startsWith("# "));
    return {
      path,
      language: "markdown",
      symbols,
      imports: [],
      exports: [],
      calls: [],
      heritages: [],
      fileSummary: firstHeading ? firstHeading.name : undefined,
      markdownStats: {
        wordCount,
        codeFenceLanguages: [...fenceLanguages].sort(),
        linkCount,
      },
    };
  }
}

type ParsedResult = import("./parser").ParsedFile & { markdownStats?: MarkdownStats };
