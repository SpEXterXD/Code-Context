import { describe, expect, it } from "vitest";

import type { LsTreeEntry, MinedCommit } from "./gitminer";
import { applyModeGoldFilter, buildDataset, datasetHash, type DatasetTask } from "./dataset";

function mined(
  over: Partial<MinedCommit> & { sha: string; files: MinedCommit["files"] },
): MinedCommit {
  const n = over.sha.length;
  return {
    sha: over.sha,
    parents: over.parents ?? [over.sha.padEnd(7, "0").slice(0, 7)],
    authorName: over.authorName ?? "Ada",
    authorEmail: over.authorEmail ?? "ada@example.dev",
    committerTime: over.committerTime ?? 1_700_000_000 + over.sha.length,
    subject: over.subject ?? "fix: handle empty session id gracefully",
    body: over.body ?? "",
    files: over.files,
  };
}

const mod = (status: string, path: string) => ({ status, prePath: path, postPath: path });

describe("buildDataset", () => {
  it("captures per-reason rejection counts and accepted tasks", () => {
    const minedCommits = [
      mined({
        sha: "a1",
        subject: "fix: handle empty session id cases",
        files: [mod("M", "src/q.ts")],
      }),
      mined({
        sha: "a2",
        subject: "docs: fix spelling and grammar in readme quickly",
        files: [mod("M", "README.md")],
      }),
      mined({
        sha: "mer",
        parents: ["p1", "p2"],
        subject: "merge thing",
        files: [mod("M", "src/x.ts")],
      }),
      mined({ sha: "bot", authorName: "dependabot[bot]", files: [mod("M", "src/y.ts")] }),
      mined({ sha: "few", subject: "short", body: "", files: [mod("M", "src/z.ts")] }),
    ];
    const { tasks, stats } = buildDataset("rep", minedCommits, 3, 7);
    expect(stats.mined).toBe(5);
    expect(stats.accepted).toBe(1);
    expect(stats.rejectedByReason).toEqual({
      "merge-commit": 1,
      "bot-author": 1,
      "task-too-short": 1,
      "docs-only": 1,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.repoId).toBe("rep");
    expect(tasks[0]!.gold).toEqual(["src/q.ts"]);
    expect(tasks[0]!.task.length).toBeGreaterThan(0);
  });

  it("drops duplicate task texts keeping the earliest commit", () => {
    const sameSubject = "fix: handle empty session id gracefully";
    const t0 = 1_700_000_000;
    const list = [
      mined({
        sha: "late1",
        committerTime: t0 + 10,
        subject: sameSubject,
        files: [mod("M", "src/a.ts")],
      }),
      mined({
        sha: "mid1",
        committerTime: t0 + 5,
        subject: sameSubject,
        files: [mod("M", "src/b.ts")],
      }),
      mined({
        sha: "early1",
        committerTime: t0,
        subject: sameSubject,
        files: [mod("M", "src/a.ts")],
      }),
    ];
    const { tasks, stats } = buildDataset("rep", list, 1, 1);
    expect(stats.duplicateTaskTextDropped).toBe(2);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.sha).toBe("early1");
    expect(tasks[0]!.parentSha).toBe("early1".padEnd(7, "0").slice(0, 7));
  });

  it("is deterministic and sample-bounded", () => {
    const pool = Array.from({ length: 60 }, (_, i) =>
      mined({
        sha: `sha${i.toString().padStart(3, "0")}`,
        committerTime: 1_700_000_000 + i * 3_600,
        subject: `fix: distinct improvement number ${i}`,
        files: [mod("M", `src/mod${i}.ts`)],
      }),
    );
    const a = buildDataset("rep", pool, 10, 99);
    const b = buildDataset("rep", pool, 10, 99);
    expect(a.tasks.map((t) => t.sha)).toEqual(b.tasks.map((t) => t.sha));
    expect(a.tasks).toHaveLength(10);
    expect(a.stats.evalPoolSize).toBe(30);
    expect(a.stats.tuningHalfSize).toBe(30);
  });

  it("split='tuning' samples the earlier half, disjoint from the eval sample", () => {
    const pool = Array.from({ length: 60 }, (_, i) =>
      mined({
        sha: `sha${i.toString().padStart(3, "0")}`,
        committerTime: 1_700_000_000 + i * 3_600,
        subject: `fix: distinct improvement number ${i}`,
        files: [mod("M", `src/mod${i}.ts`)],
      }),
    );
    const evalRun = buildDataset("rep", pool, 10, 99);
    const tuningRun = buildDataset("rep", pool, 10, 99, "tuning");
    expect(tuningRun.tasks).toHaveLength(10);
    // The tuning sample must come from the earlier half (shas 000-029 here).
    const evalShas = new Set(evalRun.tasks.map((t) => t.sha));
    for (const t of tuningRun.tasks) {
      expect(parseInt(t.sha.slice(3), 10)).toBeLessThan(30);
      expect(evalShas.has(t.sha)).toBe(false);
    }
    // Default argument keeps the eval-half behavior bit-for-bit.
    expect(buildDataset("rep", pool, 10, 99).tasks.map((t) => t.sha)).toEqual(
      evalRun.tasks.map((t) => t.sha),
    );
  });

  it("sorts gold paths and reports excluded new files", () => {
    const { tasks, stats } = buildDataset(
      "rep",
      [
        mined({
          sha: "classic",
          files: [mod("A", "src/z.ts"), mod("M", "src/b.ts"), mod("M", "src/a.ts")],
        }),
      ],
      1,
      1,
    );
    expect(tasks[0]!.gold).toEqual(["src/a.ts", "src/b.ts"]);
    expect(tasks[0]!.excludedNewFiles).toBe(1);
    expect(stats.excludedNewFiles).toBe(1);
  });

  it("datasetHash is stable for the same tasks and differs for mutations", () => {
    const t: DatasetTask = {
      id: "rep:abc",
      repoId: "rep",
      sha: "aaaa000",
      parentSha: "bbbb000",
      task: "fix: something",
      gold: ["src/a.ts"],
      excludedNewFiles: 0,
      excludedModeFiles: [],
      committerTime: 1700000000,
      subject: "fix: something",
    };
    expect(datasetHash([t])).toBe(datasetHash([{ ...t }]));
    expect(datasetHash([t])).not.toBe(datasetHash([{ ...t, gold: ["src/other.ts"] }]));
    expect(datasetHash([t])).not.toBe(datasetHash([{ ...t, excludedModeFiles: ["README.md"] }]));
  });
});

describe("applyModeGoldFilter", () => {
  const entry = (mode: string, path: string): LsTreeEntry => ({
    mode,
    type: mode === "160000" ? "commit" : "blob",
    sha: "f" + path.length,
    path,
  });
  const tree = [
    entry("100644", "src/a.ts"),
    entry("100755", "run.sh"),
    entry("120000", "README.md"),
    entry("160000", "vendored/sub"),
  ];
  const lookup = () => tree;

  const task = (id: string, gold: string[], parentSha = "p1"): DatasetTask => ({
    id,
    repoId: "rep",
    sha: id.split(":")[1]!,
    parentSha,
    task: "fix: something",
    gold,
    excludedNewFiles: 0,
    excludedModeFiles: [],
    committerTime: 1700000000,
    subject: "fix: something",
  });

  it("keeps regular-file gold and drops symlink/gitlink gold with counts", () => {
    const { tasks, stats } = applyModeGoldFilter(
      [task("rep:1", ["src/a.ts", "README.md", "vendored/sub", "run.sh"])],
      lookup,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.gold).toEqual(["run.sh", "src/a.ts"]);
    expect(tasks[0]!.excludedModeFiles).toEqual(["README.md", "vendored/sub"]);
    expect(stats.evaluatedTasks).toBe(1);
    expect(stats.tasksWithPartialGoldDrop).toBe(1);
    expect(stats.droppedGoldSymlink).toBe(1);
    expect(stats.droppedGoldGitlink).toBe(1);
    expect(stats.tasksDroppedEmptyGold).toBe(0);
  });

  it("excludes tasks whose effective gold is empty, counted per reason", () => {
    const { tasks, stats } = applyModeGoldFilter(
      [task("rep:2", ["README.md"]), task("rep:3", ["vendored/sub", "README.md"])],
      lookup,
    );
    expect(tasks).toHaveLength(0);
    expect(stats.tasksDroppedEmptyGold).toBe(2);
    expect(stats.evaluatedTasks).toBe(0);
    expect(stats.droppedGoldSymlink).toBe(2);
    expect(stats.droppedGoldGitlink).toBe(1);
  });

  it("counts gold paths absent from the parent tree as missing (0 expected in practice)", () => {
    const { stats } = applyModeGoldFilter([task("rep:4", ["src/a.ts", "ghost.md"])], lookup);
    expect(stats.droppedGoldMissing).toBe(1);
    expect(stats.evaluatedTasks).toBe(1);
    // A MISSING TS/JS path is equally refused — the hard stop is about the
    // file being dropped, whichever bucket would absorb it.
    expect(() => applyModeGoldFilter([task("rep:4b", ["ghost.ts"])], lookup)).toThrow(
      /refusing to drop TS\/JS gold/,
    );
  });

  it("hard-stops when a TS/JS gold file would be dropped by mode", () => {
    const symlinkedSource = [entry("100644", "src/a.ts"), entry("120000", "src/link.ts")];
    expect(() =>
      applyModeGoldFilter([task("rep:5", ["src/a.ts", "src/link.ts"])], () => symlinkedSource),
    ).toThrow(/refusing to drop TS\/JS gold/);
  });

  it("caches per-parent lookups and preserves task order", () => {
    let calls = 0;
    const counting = (parentSha: string) => {
      calls++;
      return parentSha === "p1" ? tree : [entry("100644", "src/b.ts")];
    };
    const { tasks } = applyModeGoldFilter(
      [
        task("rep:6", ["src/a.ts"]),
        task("rep:7", ["src/b.ts"], "p2"),
        task("rep:8", ["src/a.ts"], "p1"),
      ],
      counting,
    );
    expect(tasks.map((t) => t.id)).toEqual(["rep:6", "rep:7", "rep:8"]);
    expect(calls).toBe(2);
  });
});
