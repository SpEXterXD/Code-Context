import { describe, expect, it } from "vitest";

import { analyzeQuery } from "./queryAnalyzer";
import { InvertedIndex, M3_BODY_FIELD } from "./invertedIndex";
import { HybridRetriever, M3_CONTENT_FUSION, M4_SEED_WEIGHTS } from "./hybridRetriever";
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

  it("M3/E1: indexes body tokens with BM25F length normalization", () => {
    const short = entryWith("src/short.ts", {});
    short.bodyTokens = [{ term: "backtracking", tf: 3 }];
    short.bodyLength = 200;
    const long = entryWith("src/long.ts", {});
    long.bodyTokens = [{ term: "backtracking", tf: 3 }];
    long.bodyLength = 4000;
    const index = new InvertedIndex();
    index.applyEntry(short);
    index.applyEntry(long);
    expect(index.tf("backtracking", "src/short.ts")).toBeGreaterThan(0);
    // Same tf, four times the reference length ⇒ smaller normalized tf.
    expect(index.tf("backtracking", "src/short.ts")).toBeGreaterThan(
      index.tf("backtracking", "src/long.ts"),
    );
    // Body weight (0.5) is below every structured field: a symbol match for
    // the same term still dominates.
    const sym = entryWith("src/sym.ts", { symbols: ["backtracking"] });
    index.applyEntry(sym);
    expect(index.tf("backtracking", "src/sym.ts")).toBeGreaterThan(
      index.tf("backtracking", "src/short.ts"),
    );
  });

  it("M3/E1 ablates: disabled body field indexes nothing from bodyTokens", () => {
    const wasEnabled = M3_BODY_FIELD.enabled;
    try {
      const e = entryWith("src/x.ts", {});
      e.bodyTokens = [{ term: "quantum", tf: 5 }];
      e.bodyLength = 100;
      M3_BODY_FIELD.enabled = false;
      const index = new InvertedIndex();
      index.applyEntry(e);
      expect(index.tf("quantum", "src/x.ts")).toBe(0);
    } finally {
      M3_BODY_FIELD.enabled = wasEnabled;
    }
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

  describe("M3 content-score fusion (E2, ablatable)", () => {
    function fusionFixture(): { retriever: HybridRetriever; paths: [string, string, string] } {
      const seed = entryWith("src/seed.ts", { symbols: ["gizmo"] });
      // Graph-proximate but content-free: only the imports edge fires (0.5).
      const neighbor = entryWith("src/neighbor.ts", {});
      neighbor.internalRelations = [
        {
          source: "file:src/neighbor.ts",
          target: "file:src/seed.ts",
          kind: "imports",
          provenance: "STATIC_EXACT",
        },
      ];
      // Content-matching but graph-disconnected: io-field import of "gizmo"
      // scores 0.2 at baseline (below the 0.5 structural bonus) and 0.6 fused.
      const lexical = entryWith("other/panel.ts", {});
      lexical.imports = [
        { sourceText: "./gizmo", importedNames: ["gizmo"], startLine: 1, isExternal: false },
      ];
      return {
        retriever: makeRetriever([seed, neighbor, lexical]),
        paths: ["src/seed.ts", "src/neighbor.ts", "other/panel.ts"],
      };
    }
    const rankOf = (r: ReturnType<HybridRetriever["retrieve"]>, path: string): number =>
      r.ranked.findIndex((x) => x.path === path);

    it("lifts a content-matching file above a graph-only neighbor", () => {
      const wasEnabled = M3_CONTENT_FUSION.enabled;
      try {
        const { retriever, paths } = fusionFixture();
        M3_CONTENT_FUSION.enabled = false;
        const baseline = retriever.retrieve("gizmo", { maxGraphDepth: 2 });
        M3_CONTENT_FUSION.enabled = true;
        const fused = retriever.retrieve("gizmo", { maxGraphDepth: 2 });
        // Baseline: graph proximity (imports seed) outranks the lexical match.
        expect(rankOf(baseline, paths[2])).toBeGreaterThan(rankOf(baseline, paths[1]));
        // Fused: the content bonus flips the order; the exact-symbol seed stays Top-1.
        expect(rankOf(fused, paths[2])).toBeLessThan(rankOf(fused, paths[1]));
        expect(fused.ranked[0]?.path).toBe(paths[0]);
        expect(baseline.ranked[0]?.path).toBe(paths[0]);
      } finally {
        M3_CONTENT_FUSION.enabled = wasEnabled;
      }
    });

    it("ablates exactly: disabled reproduces the pre-M3 signal-sum scores", () => {
      const wasEnabled = M3_CONTENT_FUSION.enabled;
      try {
        const { retriever } = fusionFixture();
        M3_CONTENT_FUSION.enabled = false;
        const baseline = retriever.retrieve("gizmo", { maxGraphDepth: 2 });
        for (const r of baseline.ranked) {
          const sum = r.signals.reduce((a, s) => a + s.weight, 0);
          expect(r.score).toBeCloseTo(sum, 10);
        }
        M3_CONTENT_FUSION.enabled = true;
        const fused = retriever.retrieve("gizmo", { maxGraphDepth: 2 });
        const byPath = new Map(fused.ranked.map((r) => [r.path, r.score] as const));
        for (const r of baseline.ranked) {
          expect(byPath.get(r.path)!).toBeGreaterThanOrEqual(r.score);
        }
      } finally {
        M3_CONTENT_FUSION.enabled = wasEnabled;
      }
    });
  });

  describe("M4b seed signals", () => {
    function seedFixture(): { retriever: HybridRetriever } {
      const seededFile = entryWith("src/auth/handler.ts", { symbols: ["handleLogin"] });
      const neighbor = entryWith("src/auth/service.ts", {});
      neighbor.internalRelations = [
        {
          source: "file:src/auth/handler.ts",
          target: "file:src/auth/service.ts",
          kind: "imports",
          provenance: "STATIC_EXACT",
        },
      ];
      const unrelated = entryWith("src/other/util.ts", {});
      const graph = new RelationshipGraph();
      const map = new Map<string, FileEntry>();
      for (const e of [seededFile, neighbor, unrelated]) {
        map.set(e.meta.path, e);
        graph.upsertEntry(e);
      }
      const retriever = new HybridRetriever("/tmp", graph, new GitMetadata(), map);
      retriever.rebuild();
      return { retriever };
    }

    it("S1 signal-only: seed fires DIFF_TOUCHED without pinning, neighbors get SEED_NEIGHBOR (S2)", () => {
      const wasPolicy = M4_SEED_WEIGHTS.slotPolicy;
      const wasBoost = M4_SEED_WEIGHTS.neighborBoost;
      try {
        const { retriever } = seedFixture();
        const hints = [
          { path: "src/auth/handler.ts", kind: "DIFF_TOUCHED" as const, detail: "unstaged" },
        ];
        M4_SEED_WEIGHTS.slotPolicy = "signal-only";
        M4_SEED_WEIGHTS.neighborBoost = 0.4;
        const result = retriever.retrieve("nothing matches this vocabulary", {
          maxGraphDepth: 2,
          seedHints: hints,
        });
        const seeded = result.ranked.find((r) => r.path === "src/auth/handler.ts");
        expect(seeded?.signals.some((s) => s.kind === "DIFF_TOUCHED")).toBe(true);
        const nb = result.ranked.find((r) => r.path === "src/auth/service.ts");
        expect(nb?.signals.some((s) => s.kind === "SEED_NEIGHBOR")).toBe(true);
        expect(nb?.signals.find((s) => s.kind === "SEED_NEIGHBOR")?.weight).toBe(0.4);
        expect(result.ranked.find((r) => r.path === "src/other/util.ts")).toBeUndefined();
        // A hint with no signal source must NOT be pinned into results in
        // signal-only mode (pinning is the "slots" policy behavior).
        expect(
          retriever
            .retrieve("zzz nothing", { maxGraphDepth: 1, seedHints: hints })
            .ranked.find((r) => r.path === "src/auth/handler.ts"),
        ).toBeDefined(); // DIFF_TOUCHED 0.6 keeps it ranked
      } finally {
        M4_SEED_WEIGHTS.slotPolicy = wasPolicy;
        M4_SEED_WEIGHTS.neighborBoost = wasBoost;
      }
    });

    it("S1: signal-only seeds are NOT pinned (zero-signal hint absent from results)", () => {
      const wasPolicy = M4_SEED_WEIGHTS.slotPolicy;
      const wasEnabled = M4_SEED_WEIGHTS.enabled;
      try {
        const { retriever } = seedFixture();
        // With seeds disabled entirely, a hint path must not be pinned in
        // signal-only mode (the old "slots" policy pinned every hint path).
        M4_SEED_WEIGHTS.enabled = false;
        M4_SEED_WEIGHTS.slotPolicy = "signal-only";
        const result = retriever.retrieve("zzz nothing", {
          maxGraphDepth: 1,
          seedHints: [{ path: "src/auth/handler.ts", kind: "DIFF_TOUCHED" as const }],
        });
        expect(result.ranked.find((r) => r.path === "src/auth/handler.ts")).toBeUndefined();
      } finally {
        M4_SEED_WEIGHTS.enabled = wasEnabled;
        M4_SEED_WEIGHTS.slotPolicy = wasPolicy;
      }
    });
  });
});
