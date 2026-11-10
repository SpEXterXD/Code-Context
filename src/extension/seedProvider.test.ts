import { describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => ({
  tabs: [] as Array<{ input: unknown }>,
  activeEditor: null as null | {
    document: { uri: { scheme?: string; fsPath: string } };
    selection: unknown;
  },
  diagnostics: [] as Array<[uri: { scheme?: string; fsPath: string }, diagnostics: unknown[]]>,
}));

vi.mock("vscode", () => ({
  DiagnosticSeverity: { Error: 0, Warning: 1 },
  TabInputText: class {
    uri: { scheme: string; fsPath: string };
    constructor(uri: { scheme?: string; fsPath: string }) {
      this.uri = { scheme: uri.scheme ?? "file", fsPath: uri.fsPath };
    }
  },
  window: {
    get tabGroups() {
      return { all: [{ tabs: vscodeState.tabs }] };
    },
    get activeTextEditor() {
      return vscodeState.activeEditor;
    },
  },
  languages: {
    getDiagnostics: () => vscodeState.diagnostics,
  },
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

  // Review fix (follow-up 6): the active flag must reflect the ACTUAL active
  // editor, not "first tab" — the first tab is active only when it IS active.
  const editorConfig = {
    ...baseConfig,
    changeSeeds: false,
    seedEditors: true,
  };

  it("marks the real active editor active, even when it is not the first tab", async () => {
    const TabInputTextCtor = (await import("vscode")).TabInputText as unknown as new (uri: {
      fsPath: string;
    }) => unknown;
    vscodeState.tabs = [
      { input: new TabInputTextCtor({ fsPath: "/repo/src/first.ts" }) },
      { input: new TabInputTextCtor({ fsPath: "/repo/src/second.ts" }) },
    ];
    vscodeState.activeEditor = {
      document: { uri: { scheme: "file", fsPath: "/repo/src/second.ts" } },
      selection: undefined,
    };
    const seeds = await collectChangeSeeds({
      rootPath: "/repo",
      trusted: true,
      config: editorConfig,
    });
    expect(seeds.openEditors).toEqual([
      { path: "src/first.ts", active: false },
      { path: "src/second.ts", active: true },
    ]);
  });

  it("fabricates no active editor when the active editor holds no tab", async () => {
    const TabInputTextCtor = (await import("vscode")).TabInputText as unknown as new (uri: {
      fsPath: string;
    }) => unknown;
    vscodeState.tabs = [{ input: new TabInputTextCtor({ fsPath: "/repo/src/only.ts" }) }];
    vscodeState.activeEditor = {
      document: { uri: { scheme: "file", fsPath: "/other/unrelated.ts" } },
      selection: undefined,
    };
    const seeds = await collectChangeSeeds({
      rootPath: "/repo",
      trusted: true,
      config: editorConfig,
    });
    expect(seeds.openEditors).toEqual([{ path: "src/only.ts", active: false }]);
  });

  it("orders and dedupes diagnostics deterministically", async () => {
    vscodeState.tabs = [];
    vscodeState.activeEditor = null;
    vscodeState.diagnostics = [
      [{ scheme: "file", fsPath: "/repo/z.ts" }, [{ severity: 1, message: "second" }]],
      [
        { scheme: "file", fsPath: "/repo/a.ts" },
        [
          { severity: 0, message: "dup" },
          { severity: 0, message: "dup" }, // duplicate removed deterministically
          { severity: 3, message: "info dropped" },
        ],
      ],
    ];
    const seeds = await collectChangeSeeds({
      rootPath: "/repo",
      trusted: true,
      config: { ...editorConfig, seedDiagnostics: true },
    });
    expect(seeds.diagnostics).toEqual([
      { path: "a.ts", message: "dup" },
      { path: "z.ts", message: "second" },
    ]);
  });

  it("rejects non-file URI schemes across tabs, active selection, and diagnostics", async () => {
    const TabInputTextCtor = (await import("vscode")).TabInputText as unknown as new (uri: {
      scheme?: string;
      fsPath: string;
    }) => unknown;
    // Non-file URIs matching valid workspace file paths
    vscodeState.tabs = [
      { input: new TabInputTextCtor({ scheme: "vscode-vfs", fsPath: "/repo/src/a.ts" }) },
    ];
    vscodeState.activeEditor = {
      document: { uri: { scheme: "vscode-vfs", fsPath: "/repo/src/a.ts" } },
      selection: {
        isEmpty: false,
        start: { line: 0 },
        end: { line: 5 },
      },
    };
    vscodeState.diagnostics = [
      [{ scheme: "vscode-vfs", fsPath: "/repo/src/a.ts" }, [{ severity: 0, message: "vfs error" }]],
    ];
    const seeds = await collectChangeSeeds({
      rootPath: "/repo",
      trusted: true,
      config: { ...editorConfig, seedDiagnostics: true },
    });
    expect(seeds.openEditors).toEqual([]);
    expect(seeds.selection).toBeUndefined();
    expect(seeds.diagnostics).toEqual([]);

    // Positive control: equivalent file URIs are accepted
    vscodeState.tabs = [
      { input: new TabInputTextCtor({ scheme: "file", fsPath: "/repo/src/a.ts" }) },
    ];
    vscodeState.activeEditor = {
      document: { uri: { scheme: "file", fsPath: "/repo/src/a.ts" } },
      selection: {
        isEmpty: false,
        start: { line: 0 },
        end: { line: 5 },
      },
    };
    vscodeState.diagnostics = [
      [{ scheme: "file", fsPath: "/repo/src/a.ts" }, [{ severity: 0, message: "file error" }]],
    ];
    const positiveSeeds = await collectChangeSeeds({
      rootPath: "/repo",
      trusted: true,
      config: { ...editorConfig, seedDiagnostics: true },
    });
    expect(positiveSeeds.openEditors).toEqual([{ path: "src/a.ts", active: true }]);
    expect(positiveSeeds.selection).toEqual({ path: "src/a.ts", startLine: 1, endLine: 6 });
    expect(positiveSeeds.diagnostics).toEqual([{ path: "src/a.ts", message: "file error" }]);
  });
});
