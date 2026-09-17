import type { SymbolDef } from "../domain/model";
import { symbolId } from "../shared/ids";
import type { SourceParser } from "./parser";
import { extName } from "../shared/ids";

const MAX_JSON_SYMBOLS = 200;
const MAX_JSON_DEPTH = 4;

/**
 * JSON parser. Produces one `json-key` symbol per key path (depth-limited,
 * count-capped). Accepts strict JSON plus a lenient JSONC fallback (comments
 * and trailing commas), recording a parseError when only the fallback works.
 */
export class JsonParser implements SourceParser {
  readonly language = "json" as const;

  supports(path: string): boolean {
    const ext = extName(path);
    return ext === ".json" || ext === ".jsonc";
  }

  parse(path: string, content: string): ParsedResult {
    let value: unknown;
    let parseError: string | undefined;
    try {
      value = JSON.parse(content);
    } catch {
      try {
        value = JSON.parse(stripJsonc(content));
        parseError = "non-strict JSON (comments or trailing commas) parsed leniently";
      } catch (e) {
        return {
          path,
          language: "json",
          symbols: [],
          imports: [],
          exports: [],
          calls: [],
          heritages: [],
          parseError: `invalid JSON: ${(e as Error).message.slice(0, 120)}`,
        };
      }
    }

    const symbols: SymbolDef[] = [];
    const walk = (v: unknown, keyPath: string, line: number, depth: number): void => {
      if (symbols.length >= MAX_JSON_SYMBOLS || depth > MAX_JSON_DEPTH) return;
      if (keyPath && symbols.length < MAX_JSON_SYMBOLS) {
        const kindOf = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
        symbols.push({
          id: symbolId(path, keyPath, "json-key", line),
          name: keyPath,
          kind: "json-key",
          filePath: path,
          startLine: line,
          endLine: line,
          signature: `${keyPath}: ${kindOf}`,
          parentId: keyPath.includes(".")
            ? symbolId(path, keyPath.slice(0, keyPath.lastIndexOf(".")), "json-key", 0)
            : undefined,
        });
      }
      if (v !== null && typeof v === "object") {
        const entries = Array.isArray(v)
          ? v.slice(0, 20).map((item, i) => [String(i), item] as const)
          : Object.entries(v as Record<string, unknown>);
        for (const [k, child] of entries) {
          walk(child, keyPath ? `${keyPath}.${k}` : k, findKeyLine(content, k), depth + 1);
        }
      }
    };
    walk(value, "", 1, 0);

    const topKeys = value !== null && typeof value === "object" ? Object.keys(value as object) : [];
    return {
      path,
      language: "json",
      symbols,
      imports: [],
      exports: [],
      calls: [],
      heritages: [],
      fileSummary: topKeys.length
        ? `JSON keys: ${topKeys.slice(0, 12).join(", ")}`
        : "JSON scalar document",
      parseError,
    };
  }
}

type ParsedResult = import("./parser").ParsedFile;

function findKeyLine(content: string, key: string): number {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`);
    if (re.test(lines[i])) return i + 1;
  }
  return 1;
}

function stripJsonc(text: string): string {
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
  return out.replace(/,(\s*[}\]])/g, "$1");
}
