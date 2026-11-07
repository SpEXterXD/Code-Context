import { beforeEach, describe, expect, it, vi } from "vitest";

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

/**
 * Extension-layer tests for the right-click context-menu commands. The
 * `vscode` module is mocked; the application facade is REAL and runs against
 * a temporary fixture repository, so these tests prove the full wiring:
 * Uri argument resolution (right-click vs. palette/active-editor fallback),
 * scope construction, preview-on-generate vs. clipboard-only-on-copy, and
 * the confirmation toast contents.
 */
const state = vi.hoisted(() => ({
  messages: [] as string[],
  warnings: [] as string[],
  errors: [] as string[],
  clipboard: null as string | null,
  clipboardFails: false,
  activeEditorUri: null as string | null,
  workspaceRoot: null as string | null,
  /** F13: response for the next showInputBox call (undefined = cancelled). */
  inputBoxResponse: undefined as string | undefined,
  /** F13: response for the next showQuickPick call (undefined = cancelled). */
  quickPickResponse: undefined as unknown,
  /** FU3: output-channel lines recorded by the securityScan mock. */
  channelLines: [] as string[],
  configOverrides: {} as Record<string, unknown>,
  registered: new Map<string, (...args: unknown[]) => unknown>(),
}));

function fileUri(p: string): { scheme: string; path: string; fsPath: string } {
  return { scheme: "file", path: p.replace(/\\/g, "/"), fsPath: p };
}

/** Flips each letter's case — simulates Windows drive-letter/path casing mismatch. */
function toDifferentCase(p: string): string {
  return p.replace(/[a-zA-Z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
}

vi.mock("vscode", () => {
  class EventEmitter {
    event = (_listener: unknown) => ({ dispose() {} });
    fire(_value: unknown): void {}
    dispose(): void {}
  }
  return {
    Uri: {
      file: fileUri,
      parse: (s: string) => ({
        scheme: s.slice(0, s.indexOf(":")),
        path: s.slice(s.indexOf(":") + 1),
        fsPath: s,
      }),
    },
    EventEmitter,
    ViewColumn: { Beside: 2 },
    ProgressLocation: { Window: 1 },
    commands: {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        state.registered.set(id, handler);
        return { dispose() {} };
      },
      executeCommand: async () => undefined,
    },
    window: {
      createOutputChannel: () => ({
        appendLine: (line: string) => state.channelLines.push(line),
        show() {},
      }),
      withProgress: (_options: unknown, callback: (p: unknown, t: unknown) => unknown) =>
        callback({}, { isCancellationRequested: false }),
      showInformationMessage: (message: string) => {
        state.messages.push(message);
        return Promise.resolve(undefined);
      },
      showWarningMessage: (message: string) => {
        state.warnings.push(message);
        return Promise.resolve(undefined);
      },
      showErrorMessage: (message: string) => {
        state.errors.push(message);
        return Promise.resolve(undefined);
      },
      showInputBox: async () => state.inputBoxResponse,
      showQuickPick: async () => state.quickPickResponse,
      showTextDocument: async () => ({}),
      get activeTextEditor() {
        return state.activeEditorUri
          ? { document: { uri: fileUri(state.activeEditorUri) } }
          : undefined;
      },
    },
    workspace: {
      openTextDocument: async () => ({}),
      get workspaceFolders() {
        return state.workspaceRoot ? [{ uri: fileUri(state.workspaceRoot) }] : undefined;
      },
      getConfiguration: () => ({
        get: (key: string) =>
          key in state.configOverrides
            ? state.configOverrides[key]
            : (
                { maxGraphDepth: 3, currentChangesMaxTokens: 1500, changeSeeds: false } as Record<
                  string,
                  unknown
                >
              )[key],
      }),
    },
    env: {
      clipboard: {
        writeText: async (text: string) => {
          if (state.clipboardFails) throw new Error("clipboard unavailable (simulated)");
          state.clipboard = text;
        },
      },
    },
  };
});

const { OccApplication } = await import("../application/contextService");
const { DEFAULT_CONFIG } = await import("../application/contextService");
const { registerCommands } = await import("./commands");
const { ContextPreviewProvider } = await import("./previewProvider");
const { CancellationSource } = await import("../shared/cancellation");
type OccApplicationType = InstanceType<(typeof OccApplication)["prototype"]>;

const FIXTURE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "cmd-fixture", version: "1.0.0" }) + "\n",
  "src/app/index.ts": [
    "/** Application bootstrap. */",
    'import { api } from "./api";',
    "export const start = () => api();",
    "",
  ].join("\n"),
  "src/app/api.ts": [
    "/** API helpers. */",
    'import { util } from "../shared/util";',
    "export const api = () => util() + 1;",
    "",
  ].join("\n"),
  "src/shared/util.ts": ["/** Shared utility. */", "export const util = () => 2;", ""].join("\n"),
};

let root: string;
let app: OccApplicationType;
let previewSetPayload: ReturnType<typeof vi.spyOn>;
let previewPayloads: string[];

beforeEach(async () => {
  state.messages = [];
  state.warnings = [];
  state.errors = [];
  state.clipboard = null;
  state.clipboardFails = false;
  state.activeEditorUri = null;
  state.inputBoxResponse = undefined;
  state.quickPickResponse = undefined;
  state.channelLines = [];
  state.configOverrides = {};
  state.registered.clear();

  root = fs.mkdtempSync(path.join(os.tmpdir(), "occ-cmds-"));
  state.workspaceRoot = root;
  for (const [rel, content] of Object.entries(FIXTURE)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  app = new OccApplication(root, path.join(root, ".occ-store")) as OccApplicationType;
  await app.indexing.indexWorkspace(CancellationSource.never());

  const preview = new ContextPreviewProvider();
  previewPayloads = [];
  previewSetPayload = vi
    .spyOn(preview, "setPayload")
    .mockImplementation((payload: string, mode: string) => {
      previewPayloads.push(payload);
      return {
        scheme: "offline-code-context-preview",
        path: `/context-${mode}.txt`,
        fsPath: `offline-code-context-preview:context-${mode}.txt`,
      };
    });
  const fakeContext = { subscriptions: [] as unknown[], asAbsolutePath: (p: string) => p };
  registerCommands(
    fakeContext as unknown as Parameters<typeof registerCommands>[0],
    app,
    preview as unknown as Parameters<typeof registerCommands>[2],
  );
});

describe("context-menu commands (mocked vscode, real pipeline)", () => {
  it("registers the new copy commands alongside the palette commands", () => {
    expect(state.registered.has("offlineCodeContext.copyProjectContextToClipboard")).toBe(true);
    expect(state.registered.has("offlineCodeContext.copyFileContextToClipboard")).toBe(true);
    expect(state.registered.has("offlineCodeContext.generateProjectContext")).toBe(true);
    expect(state.registered.has("offlineCodeContext.generateFileContext")).toBe(true);
  });

  it("generateProjectContext with a folder Uri scopes to the subtree and opens the preview", async () => {
    const folderUri = fileUri(path.join(root, "src", "app"));
    await state.registered.get("offlineCodeContext.generateProjectContext")!(folderUri);
    expect(previewSetPayload).toHaveBeenCalledTimes(1);
    expect(previewPayloads[0]).toContain("### FILE: src/app/index.ts");
    expect(previewPayloads[0]).not.toContain("### FILE: src/shared/util.ts");
    expect(state.clipboard).toBeNull(); // generate never copies
  });

  it("copyProjectContextToClipboard copies without opening the preview, with counts in the toast", async () => {
    const folderUri = fileUri(path.join(root, "src", "app"));
    await state.registered.get("offlineCodeContext.copyProjectContextToClipboard")!(folderUri);
    expect(state.clipboard).not.toBeNull();
    expect(state.clipboard!.startsWith("# PROJECT CONTEXT")).toBe(true);
    expect(state.clipboard).toContain("### FILE: src/app/index.ts");
    expect(state.clipboard).not.toContain("### FILE: src/shared/util.ts");
    expect(previewSetPayload).not.toHaveBeenCalled(); // copy variant never previews
    const toast = state.messages.find((m) => m.startsWith("OCC: copied project context"));
    expect(toast).toBeDefined();
    expect(toast).toMatch(/files/);
    expect(toast).toMatch(/lines/);
    expect(toast).toMatch(/~\d+ tokens/);
  });

  it("generateFileContext uses the right-clicked Uri (background tab case)", async () => {
    const fileUriArg = fileUri(path.join(root, "src", "app", "api.ts"));
    await state.registered.get("offlineCodeContext.generateFileContext")!(fileUriArg);
    expect(previewSetPayload).toHaveBeenCalledTimes(1);
    expect(previewPayloads[0]).toContain("### FILE: src/app/api.ts");
    // USER_SELECTED seed + tier expansion: the file itself plus related files.
    expect(state.messages.some((m) => m.includes("file context for src/app/api.ts"))).toBe(true);
  });

  it("copyFileContextToClipboard falls back to the active editor when no Uri is passed", async () => {
    state.activeEditorUri = path.join(root, "src", "app", "index.ts");
    await state.registered.get("offlineCodeContext.copyFileContextToClipboard")!();
    expect(state.clipboard).toContain("### FILE: src/app/index.ts");
    const toast = state.messages.find((m) => m.startsWith("OCC: copied file context"));
    expect(toast).toBeDefined();
  });

  it("copyFileContextToClipboard prefers the right-clicked Uri over the active editor", async () => {
    state.activeEditorUri = path.join(root, "src", "app", "api.ts");
    const tabUri = fileUri(path.join(root, "src", "shared", "util.ts"));
    await state.registered.get("offlineCodeContext.copyFileContextToClipboard")!(tabUri);
    // The right-clicked file is the USER_SELECTED seed...
    expect(state.clipboard).toContain("### FILE: src/shared/util.ts");
    const why = state.clipboard!.slice(
      state.clipboard!.indexOf("## WHY THESE FILES WERE SELECTED"),
      state.clipboard!.indexOf("## SOURCE"),
    );
    const utilBlock = why.slice(why.indexOf("### src/shared/util.ts"));
    expect(utilBlock).toContain("explicitly selected by user");
    // ...while the active editor file may legitimately appear via tier
    // expansion (api.ts imports util.ts → direct dependent), never as seed.
    expect(why.slice(why.indexOf("### src/shared/util.ts"))).not.toContain(
      "### src/app/api.ts\n- Tier: explicitly selected by user",
    );
  });

  it("warns and aborts when the resource is outside the workspace", async () => {
    const outside = fileUri(path.join(path.dirname(root), "outside-folder"));
    await state.registered.get("offlineCodeContext.copyProjectContextToClipboard")!(outside);
    expect(state.warnings.some((m) => m.includes("outside the current workspace"))).toBe(true);
    expect(state.clipboard).toBeNull();
  });

  it("surfaces clipboard failures as errors without crashing", async () => {
    state.clipboardFails = true;
    await state.registered.get("offlineCodeContext.copyProjectContextToClipboard")!(
      fileUri(path.join(root, "src", "app")),
    );
    expect(state.errors.some((m) => m.includes("clipboard write failed"))).toBe(true);
  });

  it("palette invocation (no Uri) keeps the unscoped whole-project behavior", async () => {
    await state.registered.get("offlineCodeContext.generateProjectContext")!();
    expect(previewSetPayload).toHaveBeenCalledTimes(1);
    expect(previewPayloads[0]).toContain("### FILE: src/shared/util.ts");
  });

  it("the copied payload is byte-identical to a directly-built scoped context", async () => {
    await state.registered.get("offlineCodeContext.copyProjectContextToClipboard")!(
      fileUri(path.join(root, "src", "app")),
    );
    const direct = app.buildContext("project", { scope: { kind: "folder", relPath: "src/app" } });
    expect(state.clipboard).toBe(direct.payload);
  });

  // F13: task and selection generation must follow the same preview policy as
  // project/file generation (docs/COMMANDS.md documents both as opening the
  // preview). The original implementation discarded the build result.
  it("F13: generateTaskContext opens the preview", async () => {
    state.inputBoxResponse = "Add rate limiting to the login endpoint.";
    await state.registered.get("offlineCodeContext.generateTaskContext")!();
    expect(previewSetPayload).toHaveBeenCalledTimes(1);
    // Wire format keeps the PROJECT CONTEXT header; task mode adds the task section.
    expect(previewPayloads[0]).toContain("## DEVELOPER TASK");
    expect(previewPayloads[0]).toContain("Add rate limiting to the login endpoint.");
    expect(state.clipboard).toBeNull(); // generate never copies
    const toast = state.messages.find((m) => m.includes("task context ready"));
    expect(toast).toBeDefined();
  });

  it("F13: generateSelectionContext opens the preview", async () => {
    state.activeEditorUri = path.join(root, "src", "app", "api.ts");
    state.quickPickResponse = { label: "Expand with dependencies & tests", value: true };
    await state.registered.get("offlineCodeContext.generateSelectionContext")!();
    expect(previewSetPayload).toHaveBeenCalledTimes(1);
    expect(previewPayloads[0]).toContain("### FILE: src/app/api.ts");
    expect(state.clipboard).toBeNull();
  });

  it("F13: cancelling the task input does not open the preview", async () => {
    state.inputBoxResponse = undefined;
    await state.registered.get("offlineCodeContext.generateTaskContext")!();
    expect(previewSetPayload).not.toHaveBeenCalled();
  });

  it("F13: cancelling the selection quick pick does not open the preview", async () => {
    state.activeEditorUri = path.join(root, "src", "app", "api.ts");
    state.quickPickResponse = undefined;
    await state.registered.get("offlineCodeContext.generateSelectionContext")!();
    expect(previewSetPayload).not.toHaveBeenCalled();
  });

  // FU3: the Security Scan output previously listed one flat line per finding
  // with no per-file grouping and no source excerpt, making flagged lines hard
  // to locate. Findings are now grouped per file, each with an excerpt quoted
  // from the REDACTED content only (the credential value is already replaced
  // by the placeholder there) — raw secret material never reaches the output
  // channel, and blocked files (no content to quote) get no excerpt.
  // FU7: a drive-letter/path casing mismatch between the editor URI and the
  // workspace folder broke the raw slice — the copy command reported
  // "no active file" instead of compiling the file context.
  it("FU7: copyFileContextToClipboard tolerates root casing mismatches", async () => {
    state.workspaceRoot = toDifferentCase(root);
    state.activeEditorUri = path.join(toDifferentCase(root), "src", "app", "api.ts");
    await state.registered.get("offlineCodeContext.copyFileContextToClipboard")!();
    expect(state.clipboard).toContain("### FILE: src/app/api.ts");
    expect(state.warnings.some((m) => m.includes("no active file"))).toBe(false);
  });

  it("FU3: securityScan groups findings per file with redacted excerpts", async () => {
    fs.writeFileSync(
      path.join(root, "src", "creds.ts"),
      'export const cfg = { apiKey: "AKIAIOSFODNN7EXAMPLE" };\n',
    );
    state.configOverrides = { secretPolicy: "warn", redactSecrets: true };
    await app.indexing.indexSingleFile("src/creds.ts", CancellationSource.never());
    // WARN + redact so the finding lands in safeFindings with its source
    // available in redactedContent (values already placeholder-replaced).
    app.updateConfig({ ...DEFAULT_CONFIG, secretPolicy: "warn", redactSecrets: true });
    state.inputBoxResponse = "update the apiKey used by creds";
    await state.registered.get("offlineCodeContext.generateTaskContext")!();
    await state.registered.get("offlineCodeContext.securityScan")!();
    const perFile = state.channelLines.filter((l) => l.includes("src/creds.ts"));
    expect(perFile.length).toBeGreaterThan(0);
    expect(state.channelLines.some((l) => /\(\d+ finding\(s\)\)/.test(l))).toBe(true);
    const excerpt = state.channelLines.find((l) => l.trim().startsWith(">"));
    expect(excerpt).toBeDefined();
    expect(excerpt).toContain("[REDACTED:");
    expect(excerpt).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
