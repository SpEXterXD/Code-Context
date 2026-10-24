import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { safeGit } from "../git/safeGit";
import { collectGitSeeds, parseStatusZ } from "./seedCollector";
import { applyFloodControl, isGeneratedOrLockfilePath, normalizeSeedSet } from "./seedSet";
import { parseStackTrace, STACK_TRACE_MAX_INPUT_CHARS } from "./stackTrace";

describe("flood control (M4)", () => {
  const p = (path: string, state: "staged" | "unstaged" | "untracked" | "deleted") => ({
    path,
    state,
  });

  it("orders by state priority then path, caps, and drops lockfiles/generated", () => {
    const { kept } = applyFloodControl(
      [
        p("z.ts", "deleted"),
        p("package-lock.json", "staged"),
        p("dist/bundle.min.js", "staged"),
        p("b.ts", "unstaged"),
        p("a.ts", "unstaged"),
        p("c.ts", "staged"),
        p("d.ts", "untracked"),
      ],
      { maxPaths: 3 },
    );
    expect(kept.map((k) => k.path)).toEqual(["c.ts", "a.ts", "b.ts"]);
  });

  it("is deterministic and identical for a 500-changed-files repo", () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      p(`src/f${i.toString().padStart(3, "0")}.ts`, i % 2 ? "unstaged" : "staged"),
    );
    const a = applyFloodControl(many, { maxPaths: 20 });
    const b = applyFloodControl(many, { maxPaths: 20 });
    expect(a.kept).toEqual(b.kept);
    expect(a.kept).toHaveLength(20);
    expect(a.kept[0]!.path).toBe("src/f000.ts"); // staged before unstaged, path order
    expect(a.droppedCount).toBe(480);
  });

  it("applies the caller exclusion predicate before the cap", () => {
    const { kept, droppedExcluded } = applyFloodControl(
      [p("ignored/x.ts", "staged"), p("kept.ts", "staged")],
      { maxPaths: 20, isExcluded: (p2) => p2.startsWith("ignored/") },
    );
    expect(kept.map((k) => k.path)).toEqual(["kept.ts"]);
    expect(droppedExcluded).toBe(1);
  });

  it("classifies generated and lockfile paths", () => {
    expect(isGeneratedOrLockfilePath("yarn.lock")).toBe(true);
    expect(isGeneratedOrLockfilePath("src/util.min.js")).toBe(true);
    expect(isGeneratedOrLockfilePath("dist/index.js")).toBe(true);
    expect(isGeneratedOrLockfilePath("src/util.ts")).toBe(false);
  });
});

describe("stack trace parser (M4)", () => {
  it("parses Node/TS, Go, Java, Python and plain file:line:col", () => {
    const node = parseStackTrace(
      "Error: boom\n    at handler (/home/u/proj/src/handler.ts:12:9)\n    at node:internal/main/run_main_module:23:47",
    );
    expect(node).toEqual([
      { path: "/home/u/proj/src/handler.ts", line: 12, source: "file-line-col" },
    ]);

    const go = parseStackTrace(
      "goroutine 1 [running]:\nmain.main()\n\t/src/app/cmd/main.go:42 +0x1c",
    );
    expect(go[0]).toEqual({ path: "/src/app/cmd/main.go", line: 42, source: "file-line-col" });

    const java = parseStackTrace("at com.example.Foo.bar(Foo.java:88)");
    expect(java).toEqual([{ path: "Foo.java", line: 88, source: "java" }]);

    const py = parseStackTrace(
      'Traceback (most recent call last):\n  File "app/models/user.py", line 7, in <module>',
    );
    expect(py).toEqual([{ path: "app/models/user.py", line: 7, source: "python" }]);

    const plain = parseStackTrace("check src/config.ts:31 for the bad default");
    expect(plain).toEqual([{ path: "src/config.ts", line: 31, source: "file-line-col" }]);
  });

  it("deduplicates, caps matches, caps input at 64 KB, and resists adversarial input", () => {
    const dup = parseStackTrace("a.ts:1\na.ts:1\nb.ts:2");
    expect(dup).toHaveLength(2);

    const many = parseStackTrace(
      Array.from({ length: 200 }, (_, i) => `at f${i} (src/f${i}.ts:${i}:1)`).join("\n"),
    );
    expect(many.length).toBeLessThanOrEqual(50);

    const huge = `at y (real.ts:9:1)\nat x (${"/a".repeat(STACK_TRACE_MAX_INPUT_CHARS)}x.ts:1:1)`;
    const t0 = performance.now();
    const hugeResult = parseStackTrace(huge);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500); // linear, hard-capped input
    expect(hugeResult.some((f) => f.path.endsWith("real.ts"))).toBe(true);

    // Adversarial: quantifier bombs against naive matchers parse instantly.
    const evil = "(".repeat(2000) + "a.ts:1:2" + ")".repeat(2000);
    const t1 = performance.now();
    expect(parseStackTrace(evil).length).toBeGreaterThan(0);
    expect(performance.now() - t1).toBeLessThan(500);
  });
});

describe("git seed collector (temp repo, through safeGit)", () => {
  let repo = "";
  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "occ-seeds-"));
    const run = async (args: string[]): Promise<void> => {
      await safeGit({ cwd: repo, args, timeoutMs: 15000 });
    };
    await run(["init", "-q", "-b", "main", "."]);
    await run(["config", "user.email", "s@example.dev"]);
    await run(["config", "user.name", "s"]);
    fs.writeFileSync(path.join(repo, "base.ts"), "export const base = 1;\n");
    fs.writeFileSync(path.join(repo, "old-name.ts"), "export const moved = 1;\n");
    fs.writeFileSync(path.join(repo, "unstaged.ts"), "export const u = 1;\n");
    await run(["add", "-A"]);
    await run(["commit", "-q", "-m", "init"]);
    // working tree: staged new file, unstaged tracked edit, untracked,
    // deletion, rename
    fs.writeFileSync(path.join(repo, "staged.ts"), "export const s = 2;\n");
    await run(["add", "staged.ts"]);
    fs.writeFileSync(path.join(repo, "unstaged.ts"), "export const u = 2;\n");
    fs.writeFileSync(path.join(repo, "untracked.ts"), "export const n = 3;\n");
    fs.rmSync(path.join(repo, "base.ts"));
    await run(["mv", "old-name.ts", "new-name.ts"]);
  });
  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("collects staged/unstaged/untracked/deleted/renamed seeds with diffs", async () => {
    const { seedSet, unavailableReason } = await collectGitSeeds(repo, {
      maxPaths: 20,
      maxDiffBytesPerFile: 32 * 1024,
      maxUntrackedContentBytes: 64 * 1024,
      isBlockedPath: () => false,
    });
    expect(unavailableReason).toBeUndefined();
    const byPath = new Map(seedSet.changedPaths.map((c) => [c.path, c.state] as const));
    expect(byPath.get("staged.ts")).toBe("staged");
    expect(byPath.get("unstaged.ts")).toBe("unstaged");
    expect(byPath.get("untracked.ts")).toBe("untracked");
    expect(byPath.get("base.ts")).toBe("deleted");
    expect(byPath.get("new-name.ts")).toBe("staged");
    expect(byPath.get("old-name.ts")).toBeDefined(); // renames seed both paths
    const diffPaths = seedSet.diffSections.map((d) => d.path);
    expect(diffPaths).toContain("unstaged.ts");
    expect(diffPaths).toContain("untracked.ts"); // small untracked renders as add-diff
    expect(diffPaths).not.toContain("base.ts"); // deleted: path-only, never read
    expect(seedSet.diffSections.find((d) => d.path === "untracked.ts")?.diff).toContain(
      "+export const n = 3;",
    );
  });

  it("applies the sensitive-path veto BEFORE reading diff content", async () => {
    const blockedSeen: string[] = [];
    const { seedSet } = await collectGitSeeds(repo, {
      maxPaths: 20,
      maxDiffBytesPerFile: 32 * 1024,
      maxUntrackedContentBytes: 64 * 1024,
      isBlockedPath: (p) => {
        blockedSeen.push(p);
        return p === "staged.ts" || p === "new-name.ts";
      },
    });
    expect(blockedSeen).toContain("staged.ts"); // veto consulted pre-read
    const diffPaths = seedSet.diffSections.map((d) => d.path);
    expect(diffPaths).not.toContain("staged.ts");
    expect(diffPaths).not.toContain("new-name.ts");
    expect(seedSet.changedPaths.some((c) => c.path === "staged.ts")).toBe(true); // path-only seed stays
  });

  it("notes merge-in-progress and fails soft outside a repo", async () => {
    fs.writeFileSync(path.join(repo, ".git", "MERGE_HEAD"), "deadbeef\n");
    const withMerge = await collectGitSeeds(repo, {
      maxPaths: 20,
      maxDiffBytesPerFile: 32 * 1024,
      maxUntrackedContentBytes: 64 * 1024,
      isBlockedPath: () => false,
    });
    expect(withMerge.seedSet.notes.some((n) => n.includes("merge in progress"))).toBe(true);
    fs.rmSync(path.join(repo, ".git", "MERGE_HEAD"));

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "occ-norepo-"));
    try {
      const failed = await collectGitSeeds(outside, {
        maxPaths: 20,
        maxDiffBytesPerFile: 32 * 1024,
        maxUntrackedContentBytes: 64 * 1024,
        isBlockedPath: () => false,
      });
      expect(failed.unavailableReason).toBeDefined();
      expect(failed.seedSet.changedPaths).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("status -z parser", () => {
  it("handles renames, deletions, untracked and gitlinks", () => {
    const entries = parseStatusZ(
      [
        "R  new.ts\0old.ts\0",
        " D gone.ts\0",
        "?? fresh.ts\0",
        "M  mod.ts\0",
        "?? vendored/sub\0",
        "",
      ].join("\0"),
    );
    expect(entries).toEqual([
      { x: "R", y: " ", path: "new.ts", origPath: "old.ts" },
      { x: " ", y: "D", path: "gone.ts" },
      { x: "?", y: "?", path: "fresh.ts" },
      { x: "M", y: " ", path: "mod.ts" },
      { x: "?", y: "?", path: "vendored/sub" },
    ]);
  });
});

describe("normalizeSeedSet", () => {
  it("caps editors and diagnostics and flattens messages", () => {
    const s = normalizeSeedSet({
      changedPaths: [],
      openEditors: Array.from({ length: 15 }, (_, i) => ({ path: `f${i}.ts`, active: false })),
      diagnostics: [{ path: "a.ts", message: "line1\nline2" }],
    });
    expect(s.openEditors).toHaveLength(10);
    expect(s.openEditors[0]!.active).toBe(true); // first becomes active-capable
    expect(s.diagnostics[0]!.message).toBe("line1");
  });
});
