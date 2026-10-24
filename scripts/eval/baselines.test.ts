import { describe, expect, it } from "vitest";

import { bm25Baseline, filenameBaseline, randomBaseline, type Snapshot } from "./baselines";

describe("filenameBaseline", () => {
  it("puts basename-matching files ahead of everything else", () => {
    const snapshot: Snapshot = new Map([
      ["src/auth/session.ts", "x"],
      ["src/router/middleware.ts", "x"],
      ["src/auth/edges.ts", "x"],
      ["docs/other-notes.md", "x"],
    ]);
    const ranked = filenameBaseline(snapshot, "fix session cleanup for request auth");
    expect(ranked.length).toBeGreaterThanOrEqual(2);
    const hits = ranked.slice(0, 2).map((r) => r.path);
    expect(hits.sort()).toEqual(["src/auth/edges.ts", "src/auth/session.ts"]);
  });

  it("returns every path exactly once, deterministic across calls", () => {
    const snapshot: Snapshot = new Map([
      ["src/task.ts", "a"],
      ["src/taskParser/parser.ts", "b"],
      ["src/other.ts", "c"],
    ]);
    const a = filenameBaseline(snapshot, "task parser edge case");
    const b = filenameBaseline(snapshot, "task parser edge case");
    expect(a).toEqual(b);
    expect(a.map((r) => r.path).sort()).toEqual([...snapshot.keys()].sort());
  });

  it("prefers basename matches over path-only matches", () => {
    const snap: Snapshot = new Map([
      ["x/task.ts", "a"],
      ["src/taskParser/parser.ts", "b"],
    ]);
    const ranked = filenameBaseline(snap, "task parser edge case");
    expect(ranked[0]!.path).toBe("src/taskParser/parser.ts");
  });
});

describe("bm25Baseline", () => {
  it("ranks the content-matching file first", () => {
    const snapshot: Snapshot = new Map([
      ["src/retry.ts", "const backoff = exponential(retryCount); retry requests with backoff"],
      ["src/cache.ts", "cache entries expire after ttl; the cache stores values"],
      ["src/handshake.ts", "tls handshake performs certificate verification"],
    ]);
    const ranked = bm25Baseline(snapshot, "exponential backoff retry");
    expect(ranked[0]!.path).toBe("src/retry.ts");
  });

  it("is deterministic and complete (every path ranked once)", () => {
    const snapshot: Snapshot = new Map([
      ["src/retry.ts", "const backoff = exponential(retryCount); retry requests with backoff"],
      ["src/handshake.ts", "tls handshake performs certificate verification"],
    ]);
    const a = bm25Baseline(snapshot, "certificate");
    const b = bm25Baseline(snapshot, "certificate");
    expect(a).toEqual(b);
    expect(a.map((r) => r.path).sort()).toEqual([...snapshot.keys()].sort());
  });
});

describe("randomBaseline", () => {
  const paths = Array.from({ length: 9 }, (_, i) => `src/file${i}.ts`);
  const snapshot: Snapshot = new Map(paths.map((p) => [p, ""]));

  it("is reproducible for the same task+seed", () => {
    expect(randomBaseline(snapshot, "same task", 11).map((r) => r.path)).toEqual(
      randomBaseline(snapshot, "same task", 11).map((r) => r.path),
    );
  });

  it("permutes across tasks (different seeds give different orders)", () => {
    const a = randomBaseline(snapshot, "task one", 11).map((r) => r.path);
    const b = randomBaseline(snapshot, "task two", 11).map((r) => r.path);
    expect(a).not.toEqual(b);
    expect(a.slice().sort()).toEqual(paths.slice().sort());
  });
});
