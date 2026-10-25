import { describe, expect, it } from "vitest";

import {
  randomDecoys,
  revealGold,
  sameDirDecoys,
  stripRevealedPackage,
  stripRevealedRanked,
} from "./seedsSim";
import type { RankedFile } from "./metrics";

describe("revealGold (M4 simulation sampler)", () => {
  it("reveals ceil(k/2), deterministically, disjoint from hidden", () => {
    const gold = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const a = revealGold("task:1", gold);
    const b = revealGold("task:1", gold);
    expect(a).toEqual(b); // deterministic
    expect(a.revealed).toHaveLength(3); // ceil(5/2)
    expect(a.hidden).toHaveLength(2);
    const all = new Set([...a.revealed, ...a.hidden]);
    expect(all.size).toBe(5);
    for (const g of gold) expect(all.has(g)).toBe(true);
  });

  it("k=2 reveals exactly one", () => {
    const r = revealGold("t:x", ["a.ts", "b.ts"]);
    expect(r.revealed).toHaveLength(1);
    expect(r.hidden).toHaveLength(1);
  });

  it("differs across tasks (seeded by task id)", () => {
    const gold = ["a.ts", "b.ts", "c.ts", "d.ts"];
    const picks = new Set(
      Array.from({ length: 12 }, (_, i) => revealGold(`t:${i}`, gold).revealed.sort().join("|")),
    );
    expect(picks.size).toBeGreaterThan(1);
  });
});

describe("fairness removal (applied to every arm)", () => {
  const ranked: RankedFile[] = [
    { path: "revealed.ts", score: 5 },
    { path: "hidden.ts", score: 4 },
    { path: "other.ts", score: 3 },
  ];

  it("strips revealed files from ranked lists, preserving order", () => {
    expect(stripRevealedRanked(ranked, ["revealed.ts"])).toEqual([
      { path: "hidden.ts", score: 4 },
      { path: "other.ts", score: 3 },
    ]);
    expect(stripRevealedRanked(ranked, [])).toEqual(ranked);
  });

  it("strips revealed files from packages", () => {
    expect(stripRevealedPackage(["revealed.ts", "hidden.ts"], ["revealed.ts"])).toEqual([
      "hidden.ts",
    ]);
  });
});

describe("decoy pickers", () => {
  const snapshot = ["src/a.ts", "src/b.ts", "src/c.ts", "lib/l.ts", "readme.md"];
  it("same-dir decoys come from revealed directories and exclude gold", () => {
    const decoys = sameDirDecoys(snapshot, ["src/a.ts"], ["src/a.ts", "src/b.ts"], 1, "t:1");
    expect(decoys).toEqual(["src/c.ts"]);
  });
  it("random decoys exclude gold and revealed", () => {
    const decoys = randomDecoys(snapshot, ["src/a.ts"], ["src/a.ts", "src/b.ts"], 2, "t:1");
    expect(decoys).toHaveLength(2);
    expect(decoys).not.toContain("src/a.ts");
    expect(decoys).not.toContain("src/b.ts");
    const again = randomDecoys(snapshot, ["src/a.ts"], ["src/a.ts", "src/b.ts"], 2, "t:1");
    expect(again).toEqual(decoys); // deterministic
  });
});
