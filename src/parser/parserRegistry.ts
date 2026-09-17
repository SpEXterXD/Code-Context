import { TypeScriptParser } from "./typescriptParser";
import { JsonParser } from "./jsonParser";
import { MarkdownParser } from "./markdownParser";
import { GenericParser } from "./genericParser";
import { ParserRegistry } from "./parser";

/** Default registry: TS/JS → JSON → Markdown → generic fallback. */
export function createDefaultParserRegistry(): ParserRegistry {
  return new ParserRegistry([
    new TypeScriptParser(),
    new JsonParser(),
    new MarkdownParser(),
    new GenericParser(),
  ]);
}

export { TypeScriptParser, JsonParser, MarkdownParser, GenericParser, ParserRegistry };
export type { SourceParser, ParsedFile } from "./parser";
