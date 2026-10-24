import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  DiagnosticSeverity: { Error: 0, Warning: 1 },
  window: {},
  languages: {},
}));

import { collectChangeSeeds, seedFromClipboardText } from "./seedProvider";
import type { SeedSet } from "../seeds/seedSet";

describe("seedProvider (M4)", () => {
  const baseConfig = {
    changeSeeds: true,
    changeSeedsMaxPaths: 20,
    seedEditors: false,
    seedDiagnostics: false,
    seedStackTraces: false,
    maxFileSizeBytes: 1048576,
  };

  it("never invokes the git collector in untrusted workspaces", async () => {
    let collectorCalls = 0;
    const seeds = await collectChangeSeeds({
      rootPath: "/does/not/matter",
      trusted: false,
      config: baseConfig,
      collector: (async () => {
        collectorCalls++;
        return {
          seedSet: {
            changedPaths: [],
            diffSections: [],
            openEditors: [],
            diagnostics: [],
            stackFrames: [],
            notes: [],
          },
          unavailableReason: undefined,
        };
      }) as never,
    });
    expect(collectorCalls).toBe(0); // the veto happens BEFORE any git access
    expect(seeds.changedPaths).toEqual([]);
    expect(seeds.notes.some((n) => n.includes("untrusted"))).toBe(true);
  });

  it("invokes the collector when trusted and merges its result", async () => {
    const seeds = await collectChangeSeeds({
      rootPath: "/any",
      trusted: true,
      config: baseConfig,
      collector: (async () => ({
        seedSet: {
          changedPaths: [{ path: "src/a.ts", state: "unstaged" }],
          diffSections: [],
          openEditors: [],
          diagnostics: [],
          stackFrames: [],
          notes: [],
        },
        unavailableReason: undefined,
      })) as never,
    });
    expect(seeds.changedPaths).toEqual([{ path: "src/a.ts", state: "unstaged" }]);
  });

  it("degrades to an empty seed set when the collector throws", async () => {
    const seeds = await collectChangeSeeds({
      rootPath: "/any",
      trusted: true,
      config: baseConfig,
      collector: (async () => {
        throw new Error("git exploded");
      }) as never,
    });
    expect(seeds.changedPaths).toEqual([]);
    expect(seeds.notes.some((n) => n.includes("unavailable"))).toBe(true);
  });

  it("resolves stack frames to indexed paths and drops everything else", () => {
    const indexed = ["src/app/api.ts", "src/app/index.ts"];
    const text = [
      "Error: boom",
      "    at handler (/home/user/proj/src/app/api.ts:12:9)", // absolute, matches by suffix
      "    at node:internal/main/run_main_module:23:47", // dropped
      "    at evil (/etc/passwd:1:1)", // outside workspace: dropped
      "    at other (src/app/missing.ts:3:3)", // not indexed: dropped
    ].join("\n");
    const frames: SeedSet["stackFrames"] = seedFromClipboardText(text, indexed);
    expect(frames).toEqual([{ path: "src/app/api.ts", line: 12, source: "file-line-col" }]);
  });
});
