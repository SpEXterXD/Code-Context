import { describe, expect, it } from "vitest";

import {
  aggregateRuns,
  allGoldAccAtK,
  bestGoldRank,
  bootstrapMeanCi,
  recallAtK,
  reciprocalRank,
  taskMetrics,
  top1Hit,
  type RankedFile,
} from "./metrics";

function rank(paths: string[], score = 1): RankedFile[] {
  return paths.map((path, i) => ({ path, score: score - i / 1000 }));
}

describe("bestGoldRank / reciprocalRank", () => {
  it("finds the first gold hit and handles misses", () => {
    expect(bestGoldRank(rank(["a.ts", "b.ts", "c.ts"]), ["b.ts", "d.ts"])).toBe(2);
    expect(reciprocalRank(rank(["a.ts", "b.ts", "c.ts"]), ["b.ts"])).toBe(0.5);
    expect(bestGoldRank(rank(["a.ts", "b.ts"]), ["d.ts"])).toBeNull();
    expect(reciprocalRank(rank(["a.ts"]), ["d.ts"])).toBe(0);
    expect(reciprocalRank([], ["a.ts"])).toBe(0);
  });
});

describe("recallAtK / allGoldAccAtK / top1Hit", () => {
  it("counts gold files within the top k", () => {
    expect(recallAtK(rank(["g1.ts", "x.ts", "g2.ts"]), ["g1.ts", "g2.ts"], 1)).toBe(0.5);
    expect(recallAtK(rank(["g1.ts", "x.ts", "g2.ts"]), ["g1.ts", "g2.ts"], 2)).toBe(0.5);
    expect(recallAtK(rank(["g1.ts", "x.ts", "g2.ts"]), ["g1.ts", "g2.ts"], 3)).toBe(1);
    expect(recallAtK(rank(["a.ts"]), [], 10)).toBe(1);
    expect(allGoldAccAtK(rank(["g1.ts", "x.ts", "g2.ts"]), ["g1.ts", "g2.ts"], 3)).toBe(1);
    expect(allGoldAccAtK(rank(["g1.ts", "x.ts", "g2.ts"]), ["g1.ts", "g2.ts"], 2)).toBe(0);
    expect(top1Hit(rank(["g1.ts"]), ["g1.ts"])).toBe(1);
    expect(top1Hit(rank(["x.ts"]), ["g1.ts"])).toBe(0);
    expect(top1Hit([], ["g1.ts"])).toBe(0);
  });
});

describe("taskMetrics / aggregateRuns", () => {
  it("computes the whole family for one task", () => {
    const m = taskMetrics(rank(["g.ts", "a.ts", "b.ts", "c.ts", "d.ts"]), ["g.ts", "b.ts"]);
    expect(m).toEqual({ top1: 1, recall5: 1, recall10: 1, allGoldAcc10: 1, mrr: 1 });
    const m2 = taskMetrics(rank(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]), ["g.ts", "e.ts"]);
    expect(m2.top1).toBe(0);
    expect(m2.recall5).toBe(0.5);
    expect(m2.recall10).toBe(0.5);
    expect(m2.allGoldAcc10).toBe(0);
    expect(m2.mrr).toBe(0.2);
  });

   it("aggregates means deterministically", () => {
    const vals = [
      { top1: 1, recall5: 1, recall10: 1, allGoldAcc10: 1, mrr: 1 },
      { top1: 0, recall5: 0.5, recall10: 1, allGoldAcc10: 0, mrr: 0.5 },
    ];
    const agg = aggregateRuns(vals, 7);
    expect(agg.top1.mean).toBe(0.5);
    expect(agg.recall5.mean).toBe(0.75);
    expect(agg.mrr.mean).toBe(0.75);
    expect(agg.top1.ciLow).toBeLessThanOrEqual(agg.top1.mean);
    expect(agg.top1.mean).toBeLessThanOrEqual(agg.top1.ciHigh);
  });
});

describe("bootstrapMeanCi", () => {
  it("is reproducible for the same inputs", () => {
    const values = [0, 1, 1, 1, 0, 0, 1, 0];
    expect(bootstrapMeanCi(values, 42)).toEqual(bootstrapMeanCi(values, 42));
  });

  it(" brackets the observed mean and collapses for constant data", () => {
    const ci = bootstrapMeanCi([1, 1, 1, 0], 3);
    expect(ci.mean).toBe(0.75);
    expect(ci.ciLow).toBeLessThanOrEqual(ci.mean);
    expect(ci.mean).toBeLessThanOrEqual(ci.ciHigh);
    const allOnes = bootstrapMeanCi([1, 1, 1, 1], 5);
    expect(allOnes.mean).toBe(1);
    expect(allOnes.ciLow).toBe(1);
    expect(allOnes.ciHigh).toBe(1);
  });

  it("handles empty input", () => {
    expect(bootstrapMeanCi([], 1)).toEqual({ mean: 0, ciLow: 0, ciHigh: 0 });
  });
});
