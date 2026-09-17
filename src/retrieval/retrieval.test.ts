import { describe, expect, it } from "vitest";

import { analyzeQuery } from "./queryAnalyzer";
import { InvertedIndex } from "./invertedIndex";
import { HybridRetriever } from "./hybridRetriever";
import { GitMetadata } from "../git/gitMetadata";
import { RelationshipGraph } from "../domain/graph";
import type { FileEntry } from "../domain/model";
import { sha256Hex } from "../shared/ids";

function entryWith(
  path: string,
  opts: { symbols?: string[]; identifiers?: string[]; importsFrom?: string[] } = {},
): FileEntry {
  return {
    meta: {
      path,
      language: "typescript",
      sizeBytes: 100,
      lineCount: 5,
      contentHash: sha256Hex(path),
      isTest: path.includes(".test."),
      parseStatus: "PARSED",
    },
    symbols: (opts.symbols ?? []).map((name, i) => ({
      id: `${path}#${name}@function:${i + 1}`,
      name,
      kind: "function" as const,
      filePath: path,
      startLine: i + 1,
      endLine: i + 2,
    })),
    imports: (opts.importsFrom ?? []).map((target) => ({
      sourceText: target,
      importedNames: ["*"],
      startLine: 1,
      isExternal: false,
    })),
    exports: [],
    calls: [],
    internalRelations: [],
    identifiers: opts.identifiers,
  };
}

describe("analyzeQuery", () => {
  it("extracts terms, identifiers, file hints and phrases", () => {
    const q = analyzeQuery('Add rate limiting to the "login endpoint" in authRoutes.ts?');
    expect(q.fileHints).toContain("authroutes.ts");
    expect(q.quotedPhrases).toEqual(["login endpoint"]);
    expect(q.terms).toContain("rate");
    expect(q.terms).toContain("limiting");
    expect(q.terms).toContain("login");
    expect(q.terms).not.toContain("add");
    expect(q.terms).not.toContain("the");
  });

  it("collects identifier candidates", () => {
    const q = analyzeQuery("fix RateLimiter validation");
    expect(q.identifierCandidates).toContain("RateLimiter");
    expect(q.exactCandidates).toContain("ratelimiter");
  });
});

describe("InvertedIndex", () => {
  it("applies, removes and rebuilds deterministically", () => {
    const index = new InvertedIndex();
    index.applyEntry(entryWith("src/a.ts", { symbols: ["rateLimiter"] }));
    index.applyEntry(entryWith("src/b.ts", { identifiers: ["rateLimiter"] }));
    expect(index.docsFor("ratelimiter")).toEqual(["src/a.ts", "src/b.ts"]);
    // symbol field outweighs identifier field
    expect(index.tf("ratelimiter", "src/a.ts")).toBeGreaterThan(
      index.tf("ratelimiter", "src/b.ts"),
    );
    index.removeFile("src/a.ts");
    expect(index.docsFor("ratelimiter")).toEqual(["src/b.ts"]);
    expect(index.idf("nonexistent")).toBe(0);
  });
});

describe("HybridRetriever ranking + explanations", () => {
  function makeRetriever(entries: FileEntry[]): HybridRetriever {
    const graph = new RelationshipGraph();
    const map = new Map<string, FileEntry>();
    for (const e of entries) {
      map.set(e.meta.path, e);
      graph.upsertEntry(e);
    }
    const retriever = new HybridRetriever("/tmp", graph, new GitMetadata(), map);
    retriever.rebuild();
    return retriever;
  }

  it("boosts exact symbol matches above lexical matches", () => {
    const retriever = makeRetriever([
      entryWith("src/auth/service.ts", {
        identifiers: ["login", "session", "user", "credentials"],
      }),
      entryWith("src/utils/logger.ts", { symbols: ["login"] }),
    ]);
    const result = retriever.retrieve("login", { maxGraphDepth: 2 });
    expect(result.ranked[0]?.path).toBe("src/utils/logger.ts");
    expect(result.symbolHits.some((h) => h.path === "src/utils/logger.ts")).toBe(true);
    const reasons = retriever.explain(result.ranked[0]!);
    expect(reasons.some((r) => r.startsWith("Exact symbol match: login"))).toBe(true);
  });

  it("surfaces graph relationships as signals and reasons", () => {
    const entries = [
      entryWith("src/routes.ts", { symbols: ["handler"] }),
      entryWith("src/middleware.ts", {}),
      entryWith("src/service.ts", {}),
    ];
    entries[0].internalRelations = [
      {
        source: "file:src/routes.ts",
        target: "file:src/middleware.ts",
        kind: "imports",
        provenance: "STATIC_EXACT",
      },
    ];
    const retriever = makeRetriever(entries);
    const result = retriever.retrieve("routes handler", { maxGraphDepth: 2 });
    const middleware = result.ranked.find((r) => r.path === "src/middleware.ts");
    expect(middleware).toBeDefined();
    const reasons = retriever.explain(middleware!);
    expect(reasons.some((r) => r.startsWith("Direct dependency: imported by src/routes.ts"))).toBe(
      true,
    );
  });

  it("adds a test-of signal for naming-convention tests", () => {
    const entries = [entryWith("src/authService.ts", {}), entryWith("src/authService.test.ts", {})];
    entries[1].internalRelations = [
      {
        source: "file:src/authService.test.ts",
        target: "file:src/authService.ts",
        kind: "tests",
        provenance: "STATIC_HEURISTIC",
        detail: "naming convention",
      },
    ];
    const retriever = makeRetriever(entries);
    const result = retriever.retrieve("authService", { maxGraphDepth: 2 });
    const testFile = result.ranked.find((r) => r.path === "src/authService.test.ts");
    expect(testFile).toBeDefined();
    expect(retriever.explain(testFile!).some((r) => r.startsWith("Test file for"))).toBe(true);
  });

  it("is deterministic: same query twice gives identical results", () => {
    const retriever = makeRetriever([
      entryWith("a.ts", { symbols: ["alpha", "beta"], identifiers: ["gamma", "delta"] }),
      entryWith("b.ts", { symbols: ["alpha"] }),
    ]);
    const r1 = retriever.retrieve("alpha beta gamma", { maxGraphDepth: 2 });
    const r2 = retriever.retrieve("alpha beta gamma", { maxGraphDepth: 2 });
    expect(r1.ranked).toEqual(r2.ranked);
    expect(r1.symbolHits).toEqual(r2.symbolHits);
  });

  it("honors pinned files even with zero signals", () => {
    const retriever = makeRetriever([entryWith("a.ts", {})]);
    const result = retriever.retrieve("zzz-no-match", { maxGraphDepth: 1, pinnedPaths: ["a.ts"] });
    expect(result.ranked.some((r) => r.path === "a.ts")).toBe(true);
  });

  it("keeps traversal bounded by maxGraphDepth", () => {
    const chain: FileEntry[] = [];
    for (let i = 0; i < 8; i++) {
      const e = entryWith(`d${i}/f${i}.ts`, {});
      if (i > 0) {
        e.internalRelations = [
          {
            source: `file:d${i}/f${i}.ts`,
            target: `file:d${i - 1}/f${i - 1}.ts`,
            kind: "imports",
            provenance: "STATIC_EXACT",
          },
        ];
      }
      chain.push(e);
    }
    const retriever = makeRetriever(chain);
    const result = retriever.retrieve("f0", { maxGraphDepth: 2 });
    expect(result.ranked.some((r) => r.path === "d2/f2.ts")).toBe(true);
    expect(result.ranked.some((r) => r.path === "d3/f3.ts")).toBe(false);
  });
});
