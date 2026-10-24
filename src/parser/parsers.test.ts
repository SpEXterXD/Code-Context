import { describe, expect, it } from "vitest";

import { TypeScriptParser } from "./typescriptParser";
import { JsonParser } from "./jsonParser";
import { MarkdownParser } from "./markdownParser";
import { createDefaultParserRegistry } from "./parserRegistry";
import { extractBodyTokens } from "./bodyTokens";

describe("extractBodyTokens (M3/E1 body field)", () => {
  it("counts body terms, drops stopwords and single chars, splits identifiers", () => {
    const body = extractBodyTokens(
      "// Cache invalidation for the retry queue\ncacheInvalidation(); /* the the the */",
      10,
    );
    const tf = new Map(body.terms.map((t) => [t.term, t.tf] as const));
    expect(tf.get("cache")).toBe(2); // comment + identifier
    expect(tf.get("invalidation")).toBe(2);
    expect(tf.get("retry")).toBe(1);
    expect(tf.get("queue")).toBe(1);
    expect(tf.has("the")).toBe(false); // stopword
    expect(body.total).toBe(6); // pre-cap count, stopwords excluded
  });

  it("caps tf, caps term count, and is deterministic", () => {
    const content = "cache ".repeat(30) + "zzz";
    const a = extractBodyTokens(content, 3);
    const b = extractBodyTokens(content, 3);
    expect(a.terms[0]).toEqual({ term: "cache", tf: 8 }); // tf capped
    expect(a.terms).toHaveLength(2); // cache + zzz, within topN=3
    expect(a.total).toBe(31); // total is PRE-cap
    expect(a).toEqual(b);
    const tiny = extractBodyTokens("a b cache", 3);
    expect(tiny.terms).toEqual([{ term: "cache", tf: 1 }]);
    expect(tiny.total).toBe(1);
  });
});

describe("TypeScriptParser", () => {
  const parser = new TypeScriptParser();

  it("extracts functions, classes, interfaces, type aliases, enums", () => {
    const parsed = parser.parse(
      "mod.ts",
      `
/** Adds two numbers. */
export function add(a: number, b: number): number { return a + b; }

export interface Shape { area(): number; }

export class Circle implements Shape {
  radius: number;
  constructor(radius: number) { this.radius = radius; }
  area(): number { return 0; }
}

export type Pair = [number, number];
export enum Color { Red, Green }
export const multiply = (a: number, b: number): number => a * b;
`,
    );
    const names = parsed.symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain("function:add");
    expect(names).toContain("interface:Shape");
    expect(names).toContain("class:Circle");
    expect(names).toContain("type:Pair");
    expect(names).toContain("enum:Color");
    expect(names).toContain("function:multiply");
    const add = parsed.symbols.find((s) => s.name === "add")!;
    expect(add.docComment).toContain("Adds two numbers");
    expect(add.exportKind).toBe("named");
    const circleArea = parsed.symbols.find((s) => s.name === "Circle.area");
    expect(circleArea?.parentId).toContain("Circle");
  });

  it("extracts named/default imports and re-exports", () => {
    const parsed = parser.parse(
      "mod.ts",
      `
import defaultThing, { namedA, namedB as alias } from "./other";
import * as ns from "./ns";
export { namedA } from "./other";
import type { Shape } from "./shapes";
`,
    );
    const specifiers = parsed.imports.map((i) => i.sourceText).sort();
    expect(specifiers).toEqual(["./ns", "./other", "./other", "./shapes"]);
    const other = parsed.imports.filter((i) => i.sourceText === "./other");
    expect(other[0]?.importedNames.sort()).toEqual(["default", "namedA", "namedB"]);
    expect(parsed.exports.map((e) => e.name)).toContain("*");
  });

  it("records dynamic imports and require calls", () => {
    const parsed = parser.parse(
      "mod.ts",
      `
const a = import("./dynamic");
const fs = require("fs");
const bad = import(variable);
`,
    );
    const dynamic = parsed.imports.find((i) => i.sourceText === "./dynamic");
    expect(dynamic?.isExternal).toBe(false);
    const fsImport = parsed.imports.find((i) => i.sourceText === "fs");
    expect(fsImport?.isExternal).toBe(true);
    expect(parsed.imports.find((i) => i.sourceText === "<dynamic>")).toBeDefined();
  });

  it("extracts call sites with enclosing symbol", () => {
    const parsed = parser.parse(
      "mod.ts",
      `
export function helper() { return 1; }
export function caller() {
  helper();
  Math.max(1, 2);
}
`,
    );
    const callerId = parsed.symbols.find((s) => s.name === "caller")!.id;
    const calls = parsed.calls.filter((c) => c.callerId === callerId);
    expect(calls.map((c) => c.calleeName).sort()).toEqual(["helper", "max"]);
  });

  it("extracts extends/implements heritage", () => {
    const parsed = parser.parse(
      "mod.ts",
      `
class Base {}
interface IFace {}
class Child extends Base implements IFace {}
`,
    );
    expect(parsed.heritages.map((h) => `${h.symbolName}:${h.kind}`)).toEqual([
      "Child:extends",
      "Child:implements",
    ]);
    expect(parsed.heritages[0]?.parents).toEqual(["Base"]);
  });

  it("flags syntax errors without throwing", () => {
    const parsed = parser.parse("broken.ts", "function broken( { return 1; }}}");
    expect(parsed.parseError).toBeDefined();
    expect(parsed.parseError).toMatch(/syntax error at line/);
  });

  it("does not treat code-looking comments or strings as symbols", () => {
    const parsed = parser.parse(
      "mod.ts",
      `
// function fakeA() {}
/* class FakeB {} */
const s = "function fakeC() {}";
export function real() {}
`,
    );
    expect(parsed.symbols.map((s) => s.name)).toEqual(["s", "real"]);
  });

  it("handles duplicate short names deterministically", () => {
    const parsed = parser.parse(
      "mod.ts",
      `
function dup() { return 1; }
function dupName() { dup(); return 2; }
`,
    );
    const dups = parsed.symbols.filter((s) => s.name === "dup");
    expect(dups.length).toBe(1);
    expect(parsed.calls[0]?.calleeName).toBe("dup");
  });

  it("counts line numbers 1-based", () => {
    const parsed = parser.parse("mod.ts", "\n\nexport function third() {}\n");
    expect(parsed.symbols[0]?.startLine).toBe(3);
  });
});

describe("JsonParser", () => {
  const parser = new JsonParser();

  it("extracts nested keys as json-key symbols with line numbers", () => {
    const parsed = parser.parse(
      "cfg.json",
      `{
  "name": "app",
  "scripts": {
    "build": "tsc"
  }
}
`,
    );
    const names = parsed.symbols.map((s) => s.name);
    expect(names).toContain("name");
    expect(names).toContain("scripts");
    expect(names).toContain("scripts.build");
    expect(parsed.symbols.find((s) => s.name === "scripts.build")?.startLine).toBe(4);
  });

  it("resolves key lines with a single-pass index (duplicate names keep first occurrence)", () => {
    const parsed = parser.parse(
      "cfg.json",
      `{
  "outer": {
    "dup": 1,
    "inner": { "dup": 2 }
  },
  "dup": 3
}
`,
    );
    const byName = (name: string) => parsed.symbols.find((s) => s.name === name)!;
    expect(byName("outer").startLine).toBe(2);
    expect(byName("outer.dup").startLine).toBe(3);
    expect(byName("outer.inner").startLine).toBe(4);
    expect(byName("outer.inner.dup").startLine).toBe(3); // first "dup" line wins
    expect(byName("dup").startLine).toBe(3); // same first-occurrence index
  });

  it("falls back leniently for JSONC and records it", () => {
    const parsed = parser.parse("cfg.jsonc", '{\n  // comment\n  "a": 1,\n}\n');
    expect(parsed.parseError).toContain("non-strict");
    expect(parsed.symbols.map((s) => s.name)).toContain("a");
  });

  it("reports invalid JSON as parse error", () => {
    const parsed = parser.parse("bad.json", "{ not json ]");
    expect(parsed.parseError).toContain("invalid JSON");
    expect(parsed.symbols).toHaveLength(0);
  });
});

describe("MarkdownParser", () => {
  const parser = new MarkdownParser();

  it("extracts headings with hierarchy and skips code fences", () => {
    const parsed = parser.parse(
      "doc.md",
      `# Title

Intro text.

## Setup

\`\`\`typescript
## this is not a heading
const x = 1;
\`\`\`

## Usage
`,
    );
    expect(parsed.symbols.map((s) => s.name)).toEqual(["Title", "Setup", "Usage"]);
    const setup = parsed.symbols.find((s) => s.name === "Setup")!;
    expect(setup.parentId).toContain("Title");
    const usage = parsed.symbols.find((s) => s.name === "Usage")!;
    expect(usage.parentId).toContain("Title");
  });

  it("collects fence languages and link counts", () => {
    const parsed = parser.parse(
      "doc.md",
      "# T\n\nSee [link](http://example.com).\n\n```typescript\nx\n```\n",
    );
    const stats = (
      parsed as { markdownStats?: { codeFenceLanguages: string[]; linkCount: number } }
    ).markdownStats!;
    expect(stats.codeFenceLanguages).toEqual(["typescript"]);
    expect(stats.linkCount).toBe(1);
    expect(parsed.fileSummary).toBe("T");
  });
});

describe("ParserRegistry", () => {
  it("routes by extension and falls back to generic", () => {
    const registry = createDefaultParserRegistry();
    expect(registry.resolve("a.ts").language).toBe("typescript");
    expect(registry.resolve("a.js").language).toBe("typescript");
    expect(registry.resolve("a.json").language).toBe("json");
    expect(registry.resolve("a.md").language).toBe("markdown");
    expect(registry.resolve("a.py").language).toBe("generic");
    const parsed = registry.resolve("a.py").parse("a.py", "def x(): pass\n");
    expect(parsed.symbols).toHaveLength(0);
    expect(parsed.language).toBe("generic");
  });
});
