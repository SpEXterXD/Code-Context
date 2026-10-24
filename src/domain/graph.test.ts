import { describe, expect, it } from "vitest";

import { RelationshipGraph, traverse } from "./graph";
import type { FileEntry } from "./model";
import { sha256Hex } from "../shared/ids";
import { mulberry32 } from "../testing/prng";

/** Minimal entry factory: file with importsEdges already encoded as internalRelations. */
function entry(
  path: string,
  internalRelations: FileEntry["internalRelations"] = [],
  symbols: FileEntry["symbols"] = [],
): FileEntry {
  return {
    meta: {
      path,
      language: "typescript",
      sizeBytes: 10,
      lineCount: 1,
      contentHash: sha256Hex(path),
      isTest: false,
      parseStatus: "PARSED",
    },
    symbols,
    imports: [],
    exports: [],
    calls: [],
    internalRelations,
  };
}

function importsEdge(from: string, to: string): FileEntry["internalRelations"][number] {
  return {
    source: `file:${from}`,
    target: `file:${to}`,
    kind: "imports",
    provenance: "STATIC_EXACT",
  };
}

describe("RelationshipGraph", () => {
  it("derives dependents from imports without duplicate edges", () => {
    const graph = new RelationshipGraph();
    graph.upsertEntry(entry("a.ts", [importsEdge("a.ts", "b.ts")]));
    graph.upsertEntry(entry("b.ts", []));
    expect(graph.fileDependencies("a.ts")).toEqual(["b.ts"]);
    expect(graph.fileDependents("b.ts")).toEqual(["a.ts"]);
    // duplicate upsert must not duplicate edges
    graph.upsertEntry(entry("a.ts", [importsEdge("a.ts", "b.ts")]));
    expect(graph.edgesFrom("file:a.ts").filter((e) => e.kind === "imports")).toHaveLength(1);
  });

  it("removes stale edges when a file is deleted", () => {
    const graph = new RelationshipGraph();
    graph.upsertEntry(entry("a.ts", [importsEdge("a.ts", "b.ts")]));
    graph.upsertEntry(entry("b.ts", []));
    graph.removeFile("a.ts");
    expect(graph.fileDependencies("a.ts")).toEqual([]);
    expect(graph.fileDependents("b.ts")).toEqual([]);
    expect(graph.edgesTo("file:b.ts")).toHaveLength(0);
  });

  it("keeps dir contains edges for nested files", () => {
    const graph = new RelationshipGraph();
    graph.upsertEntry(entry("src/x/a.ts", []));
    expect(graph.edgesFrom("dir:src/x").map((e) => e.kind)).toContain("contains");
  });
});

describe("traverse (hard depth limit)", () => {
  function chain(graph: RelationshipGraph, length: number): void {
    for (let i = 0; i < length; i++) {
      graph.upsertEntry(
        entry(`f${i}.ts`, i + 1 < length ? [importsEdge(`f${i}.ts`, `f${i + 1}.ts`)] : []),
      );
    }
  }

  it("never exceeds the configured depth on a chain", () => {
    const graph = new RelationshipGraph();
    chain(graph, 10);
    const result = traverse(graph, ["file:f0.ts"], 3);
    expect(result.nodes).toContain("file:f3.ts");
    expect(result.nodes).not.toContain("file:f4.ts");
  });

  it("terminates on cyclic fixtures without exceeding depth", () => {
    const graph = new RelationshipGraph();
    graph.upsertEntry(entry("a.ts", [importsEdge("a.ts", "b.ts")]));
    graph.upsertEntry(entry("b.ts", [importsEdge("b.ts", "a.ts")]));
    const result = traverse(graph, ["file:a.ts"], 5);
    expect(result.nodes).toEqual(["file:a.ts", "file:b.ts"]);
    // depth bookkeeping stays bounded
    expect(result.depthOf.get("file:b.ts")).toBe(1);
  });

  it("visits neighbors in deterministic sorted order", () => {
    const graph = new RelationshipGraph();
    graph.upsertEntry(entry("z.ts", []));
    graph.upsertEntry(entry("a.ts", []));
    graph.upsertEntry(entry("m.ts", []));
    graph.upsertEntry(
      entry("root.ts", [
        importsEdge("root.ts", "z.ts"),
        importsEdge("root.ts", "a.ts"),
        importsEdge("root.ts", "m.ts"),
      ]),
    );
    const result = traverse(graph, ["file:root.ts"], 1);
    expect(result.nodes).toEqual(["a.ts", "m.ts", "root.ts", "z.ts"].map((p) => `file:${p}`));
  });

  it("respects the edge filter", () => {
    const graph = new RelationshipGraph();
    graph.upsertEntry(entry("a.ts", [importsEdge("a.ts", "b.ts")]));
    graph.upsertEntry(entry("b.ts", []));
    const result = traverse(graph, ["file:a.ts"], 3, (e) => e.kind !== "imports");
    expect(result.nodes).toEqual(["file:a.ts"]);
  });

  it("M3-hardening: incremental externalPackages equals a full derivation under fuzzed ops", () => {
    // Public-API oracle: exactly what the old O(N) full derivation computed —
    // external targets of edges whose SOURCE is a file node.
    const oracle = (graph: RelationshipGraph): string[] => {
      const set = new Set<string>();
      for (const node of graph.nodes()) {
        if (!node.startsWith("file:")) continue;
        for (const e of graph.edgesFrom(node)) {
          if (e.target.startsWith("external:")) set.add(e.target.slice("external:".length));
        }
      }
      return [...set].sort();
    };

    const prng = mulberry32(20261025);
    const files = Array.from({ length: 12 }, (_, i) => `src/m${i}.ts`);
    const externals = Array.from({ length: 6 }, (_, i) => `pkg${i}`);
    const buildEntry = (path: string): FileEntry => {
      // 0-2 external imports, possibly shared between files, so removals do
      // not always empty an external node's incoming list.
      const rels: FileEntry["internalRelations"] = [];
      const count = Math.floor(prng() * 3);
      for (let i = 0; i < count; i++) {
        const pkg = externals[Math.floor(prng() * externals.length)]!;
        rels.push({
          source: `file:${path}`,
          target: `external:${pkg}`,
          kind: prng() < 0.5 ? "imports" : "references",
          provenance: "STATIC_EXACT",
        });
      }
      if (prng() < 0.3) {
        const other = files[Math.floor(prng() * files.length)]!;
        rels.push(importsEdge(path, other));
      }
      return entry(path, rels);
    };

    const graph = new RelationshipGraph();
    const live = new Set<string>();
    for (let step = 0; step < 400; step++) {
      const path = files[Math.floor(prng() * files.length)]!;
      if (live.has(path) && prng() < 0.35) {
        graph.removeFile(path);
        live.delete(path);
      } else {
        graph.upsertEntry(buildEntry(path));
        live.add(path);
      }
      expect(graph.allExternalPackages()).toEqual(oracle(graph));
    }
    // And a from-scratch rebuild in one pass matches the fuzzed end state.
    const fresh = new RelationshipGraph();
    for (const path of [...live].sort()) fresh.upsertEntry(buildEntryFresh(path));
    function buildEntryFresh(p: string): FileEntry {
      const rels: FileEntry["internalRelations"] = [];
      const count = Math.floor(prng() * 3);
      for (let i = 0; i < count; i++) {
        const pkg = externals[Math.floor(prng() * externals.length)]!;
        rels.push({
          source: `file:${p}`,
          target: `external:${pkg}`,
          kind: "imports",
          provenance: "STATIC_EXACT",
        });
      }
      return entry(p, rels);
    }
    // (The rebuild uses fresh random relations, so only the mechanism is
    // exercised again; the oracle invariant is the assertion.)
    expect(fresh.allExternalPackages()).toEqual(oracle(fresh));
  });
});
