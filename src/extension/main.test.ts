import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const state = vi.hoisted(() => ({
  root: null as string | null,
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  messages: [] as string[],
  warnings: [] as string[],
  errors: [] as string[],
  clipboard: null as string | null,
  clipboardFails: false,
  infoChoice: null as string | null,
  warningChoice: null as string | null,
  inputBox: null as string | null,
  quickPickChoice: null as unknown,
  quickPickOptions: [] as unknown[],
  openedDocuments: [] as string[],
  shownTextDocuments: [] as string[],
  statusTexts: [] as string[],
  statusShown: 0,
  statusHidden: 0,
  treeViews: [] as string[],
  contentProviders: new Map<string, unknown>(),
  watcherListeners: { create: [], change: [], delete: [] } as Record<
    string,
    Array<(uri: unknown) => void>
  >,
  configChangeListeners: [] as Array<
    (e: { affectsConfiguration: (key: string) => boolean }) => void
  >,
  outputLines: [] as string[],
  cancelled: false,
  executed: [] as string[],
}));

function fileUri(p: string): { scheme: string; path: string; fsPath: string } {
  return { scheme: "file", path: p.replace(/\\/g, "/"), fsPath: p };
}

vi.mock("vscode", () => {
  class EventEmitter {
    event = (_l: unknown) => ({ dispose() {} });
    fire(_v: unknown): void {}
    dispose(): void {}
  }
  const configuration = {
    get: (key: string) => {
      const defaults: Record<string, unknown> = {
        maxFiles: 40,
        maxChars: 120000,
        maxLines: 3000,
        maxTokens: 30000,
        maxGraphDepth: 3,
        maxCodeLinesPerFile: 400,
        structureDepth: 4,
        excludePatterns: [],
        maxFileSizeBytes: 1048576,
        secretPolicy: "block",
        redactSecrets: true,
        enableGitRecency: false,
        respectGitignore: true,
        statusBar: true,
      };
      return defaults[key];
    },
  };
  return {
    Uri: {
      file: fileUri,
      parse: (s: string) => ({ scheme: s.slice(0, s.indexOf(":")), path: s, fsPath: s }),
      joinPath: (base: { fsPath: string }, rel: string) => fileUri(path.join(base.fsPath, rel)),
    },
    EventEmitter,
    ViewColumn: { Beside: 2 },
    ProgressLocation: { Window: 1 },
    StatusBarAlignment: { Right: 2 },
    ThemeIcon: class {
      constructor(public id: string) {}
    },
    TreeItemCollapsibleState: { None: 0 },
    commands: {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        state.commands.set(id, handler);
        return { dispose() {} };
      },
      executeCommand: async (id: string, ...args: unknown[]) => {
        state.executed.push(id);
        const handler = state.commands.get(id);
        return handler ? handler(...args) : undefined;
      },
    },
    window: {
      createOutputChannel: () => ({
        appendLine: (line: string) => state.outputLines.push(line),
        show: () => undefined,
      }),
      withProgress: (_o: unknown, cb: (p: unknown, t: unknown) => unknown) =>
        cb(
          {},
          {
            get isCancellationRequested() {
              return state.cancelled;
            },
          },
        ),
      showInformationMessage: (message: string) => {
        state.messages.push(message);
        return Promise.resolve(state.infoChoice);
      },
      showWarningMessage: (message: string, ..._buttons: string[]) => {
        state.warnings.push(message);
        return Promise.resolve(state.warningChoice ?? (state.quickPickChoice as string | null));
      },
      showErrorMessage: (message: string) => {
        state.errors.push(message);
        return Promise.resolve(undefined);
      },
      showInputBox: async () => state.inputBox,
      showQuickPick: async (items: unknown[], _options?: unknown) => {
        state.quickPickOptions = items;
        if (typeof state.quickPickChoice === "function") {
          return (state.quickPickChoice as (items: unknown[]) => unknown)(items);
        }
        return state.quickPickChoice;
      },
      showTextDocument: async (doc: {
        uri?: { fsPath?: string };
        fileName?: string;
        fsPath?: string;
      }) => {
        state.shownTextDocuments.push(doc.fileName ?? doc.fsPath ?? doc.uri?.fsPath ?? "(doc)");
      },
      createStatusBarItem: () => ({
        text: "",
        tooltip: "",
        command: "",
        show: () => state.statusShown++,
        hide: () => state.statusHidden++,
        dispose: () => undefined,
      }),
      createTreeView: (id: string) => {
        state.treeViews.push(id);
        return { dispose() {} };
      },
      get activeTextEditor() {
        return state.root
          ? { document: { uri: fileUri(path.join(state.root, "src", "app", "index.ts")) } }
          : undefined;
      },
    },
    workspace: {
      get workspaceFolders() {
        return state.root ? [{ uri: fileUri(state.root) }] : undefined;
      },
      openTextDocument: async (uriOrStr: { fsPath?: string; path?: string } | string) => {
        const id =
          typeof uriOrStr === "string" ? uriOrStr : (uriOrStr.fsPath ?? uriOrStr.path ?? "(doc)");
        state.openedDocuments.push(id);
        return { fileName: id, uri: typeof uriOrStr === "string" ? fileUri(uriOrStr) : uriOrStr };
      },
      registerTextDocumentContentProvider: (scheme: string, provider: unknown) => {
        state.contentProviders.set(scheme, provider);
        return { dispose() {} };
      },
      createFileSystemWatcher: (_glob: string) => ({
        onDidCreate: (cb: (uri: unknown) => void) => {
          state.watcherListeners.create.push(cb);
          return { dispose() {} };
        },
        onDidChange: (cb: (uri: unknown) => void) => {
          state.watcherListeners.change.push(cb);
          return { dispose() {} };
        },
        onDidDelete: (cb: (uri: unknown) => void) => {
          state.watcherListeners.delete.push(cb);
          return { dispose() {} };
        },
        dispose: () => undefined,
      }),
      getConfiguration: (_scope?: string) => configuration,
      onDidChangeConfiguration: (
        cb: (e: { affectsConfiguration: (key: string) => boolean }) => void,
      ) => {
        state.configChangeListeners.push(cb);
        return { dispose() {} };
      },
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

const { activate } = await import("./main");
const { OccApplication } = await import("../application/contextService");
const { CancellationSource } = await import("../shared/cancellation");
const { PREVIEW_SCHEME, ContextPreviewProvider } = await import("./previewProvider");
const { entryRelativePath } = await import("../index/schema");

const WORKSPACE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "activation-audit", version: "0.0.1" }) + "\n",
  "src/app/index.ts": [
    "/** Application entry. */",
    'import { api } from "./api";',
    "export const start = () => api() + 1;",
    "",
  ].join("\n"),
  "src/app/api.ts": [
    "/** API helpers. */",
    'import { util } from "../shared/util";',
    "export const api = () => util() + 1;",
    "",
  ].join("\n"),
  "src/shared/util.ts": ["/** Shared utility. */", "export const util = () => 2;", ""].join("\n"),
  "src/app/leak.ts": [
    "const apiKey = 'J8s2kLq9zX1pQw7vR3mNtYu5';",
    "export const use = apiKey;",
    "",
  ].join("\n"),
  "README.md": "# activation audit fixture\n",
};

let root: string;
let storageDir: string;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the predicate holds; indexing duration varies (cold JIT). */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Counts persisted JSON entry shards on disk. */
function countStoreEntries(dir: string): number {
  const entriesDir = path.join(dir, "entries");
  if (!fs.existsSync(entriesDir)) return 0;
  let count = 0;
  for (const shard of fs.readdirSync(entriesDir)) {
    count += fs.readdirSync(path.join(entriesDir, shard)).filter((f) => f.endsWith(".json")).length;
  }
  return count;
}

beforeEach(async () => {
  state.commands.clear();
  state.messages = [];
  state.warnings = [];
  state.errors = [];
  state.clipboard = null;
  state.clipboardFails = false;
  state.infoChoice = null;
  state.warningChoice = null;
  state.inputBox = null;
  state.quickPickChoice = null;
  state.quickPickOptions = [];
  state.openedDocuments = [];
  state.shownTextDocuments = [];
  state.statusTexts = [];
  state.statusShown = 0;
  state.statusHidden = 0;
  state.treeViews = [];
  state.contentProviders.clear();
  state.watcherListeners = { create: [], change: [], delete: [] };
  state.configChangeListeners = [];
  state.outputLines = [];
  state.executed = [];
  state.cancelled = false;

  root = fs.mkdtempSync(path.join(os.tmpdir(), "occ-activate-"));
  state.root = root;
  for (const [rel, content] of Object.entries(WORKSPACE)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }

  storageDir = path.join(path.dirname(root), path.basename(root) + "-storage");
  const context = {
    subscriptions: [] as Array<{ dispose(): void }>,
    storageUri: fileUri(storageDir),
    globalStorageUri: fileUri(path.join(storageDir, "global")),
    asAbsolutePath: (p: string) => p,
  };
  activate(context as never);
  await waitFor(() => countStoreEntries(storageDir) >= 6, 30000, "startup index entries");
});

afterEach(() => {
  state.root = null;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe("activation audit (real activate(), mocked vscode)", () => {
  it("registers all 15 commands, the tree view, and the preview provider on activation", () => {
    expect(state.commands.size).toBe(15);
    expect(state.commands.has("offlineCodeContext.indexWorkspace")).toBe(true);
    expect(state.commands.has("offlineCodeContext.rebuildIndex")).toBe(true);
    expect(state.commands.has("offlineCodeContext.generateTaskContext")).toBe(true);
    expect(state.commands.has("offlineCodeContext.generateFileContext")).toBe(true);
    expect(state.commands.has("offlineCodeContext.searchCodebase")).toBe(true);
    expect(state.commands.has("offlineCodeContext.previewContext")).toBe(true);
    expect(state.commands.has("offlineCodeContext.copyContext")).toBe(true);
    expect(state.treeViews).toContain("offlineCodeContext.indexStatus");
    expect(state.contentProviders.has(PREVIEW_SCHEME)).toBe(true);
    expect(state.watcherListeners.change.length).toBeGreaterThan(0);
    expect(state.watcherListeners.create.length).toBeGreaterThan(0);
    expect(state.watcherListeners.delete.length).toBeGreaterThan(0);
  });

  it("auto-indexes the workspace on startup (silent warm-up, persisted store)", () => {
    expect(state.messages.some((m) => m.includes("not indexed"))).toBe(false);

    const manifestPath = path.join(storageDir, "manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.entryCount).toBe(6);
    expect(Object.keys(manifest.files).sort()).toEqual([
      "README.md",
      "package.json",
      "src/app/api.ts",
      "src/app/index.ts",
      "src/app/leak.ts",
      "src/shared/util.ts",
    ]);

    const indexPath = path.join(storageDir, entryRelativePath("src/app/index.ts"));
    expect(fs.existsSync(indexPath)).toBe(true);
    const indexEntry = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    expect(indexEntry.meta.path).toBe("src/app/index.ts");
    expect(indexEntry.meta.language).toBe("typescript");
    expect(indexEntry.meta.parseStatus).toBe("PARSED");
    expect(indexEntry.symbols.some((s: { name: string }) => s.name === "start")).toBe(true);
    expect(
      indexEntry.imports.some(
        (i: { sourceText: string; importedNames: string[] }) =>
          i.sourceText === "./api" && i.importedNames.includes("api"),
      ),
    ).toBe(true);

    const apiPath = path.join(storageDir, entryRelativePath("src/app/api.ts"));
    expect(fs.existsSync(apiPath)).toBe(true);
    const apiEntry = JSON.parse(fs.readFileSync(apiPath, "utf8"));
    expect(apiEntry.symbols.some((s: { name: string }) => s.name === "api")).toBe(true);
    expect(
      apiEntry.imports.some(
        (i: { sourceText: string; importedNames: string[] }) =>
          i.sourceText === "../shared/util" && i.importedNames.includes("util"),
      ),
    ).toBe(true);
  });

  it("generateTaskContext -> preview -> copy: preview shows exactly what the clipboard gets", async () => {
    state.inputBox = "how does api work";
    await state.commands.get("offlineCodeContext.generateTaskContext")!();
    await state.commands.get("offlineCodeContext.previewContext")!();
    expect(state.openedDocuments.length).toBeGreaterThan(0);
    const previewUriStr = String(state.openedDocuments[state.openedDocuments.length - 1]);
    expect(previewUriStr).toContain(PREVIEW_SCHEME);

    await state.commands.get("offlineCodeContext.copyContext")!();
    expect(state.clipboard).toContain("# PROJECT CONTEXT");
    expect(state.clipboard).toContain("how does api work");

    const provider = state.contentProviders.get(PREVIEW_SCHEME) as ContextPreviewProvider;
    expect(provider).toBeDefined();
    const served = provider.provideTextDocumentContent({
      scheme: PREVIEW_SCHEME,
      path: previewUriStr,
      fsPath: previewUriStr,
    } as never);
    expect(served).toBe(state.clipboard);
  });

  it("right-click folder commands scope to the subtree; copy variant never previews", async () => {
    const before = state.openedDocuments.length;
    await state.commands.get("offlineCodeContext.copyProjectContextToClipboard")!(
      fileUri(path.join(root, "src", "shared")),
    );
    expect(state.clipboard).toContain("### FILE: src/shared/util.ts");
    expect(state.clipboard).not.toContain("### FILE: src/app/index.ts");
    expect(state.openedDocuments.length).toBe(before);
    expect(state.messages.some((m) => m.startsWith("OCC: copied project context"))).toBe(true);
  });

  it("right-click file commands seed from the clicked file and expand dependencies", async () => {
    await state.commands.get("offlineCodeContext.generateFileContext")!(
      fileUri(path.join(root, "src", "app", "api.ts")),
    );
    expect(state.openedDocuments.length).toBeGreaterThan(0);
    const previewUri = String(state.openedDocuments[state.openedDocuments.length - 1]);
    expect(previewUri).toContain(PREVIEW_SCHEME);
    expect(previewUri).toContain("context-file.txt");

    await state.commands.get("offlineCodeContext.copyContext")!();
    expect(state.clipboard).toContain("### FILE: src/app/api.ts");
    expect(state.clipboard).toContain("### FILE: src/shared/util.ts");
    expect(state.clipboard).toContain("### FILE: src/app/index.ts");
    expect(state.clipboard).not.toContain("### FILE: README.md");
    expect(state.clipboard).not.toContain("### FILE: package.json");
    expect(state.clipboard).toContain("### src/app/api.ts\n- Tier: explicitly selected by user");
  });

  it("default BLOCK policy withholds the secret file and the leak gate keeps the value absent", async () => {
    state.inputBox = "api leak apiKey environment";
    await state.commands.get("offlineCodeContext.generateTaskContext")!();
    await state.commands.get("offlineCodeContext.copyContext")!();
    expect(state.clipboard).not.toContain("J8s2kLq9zX1pQw7vR3mNtYu5");
    expect(state.clipboard).toContain("### FILE: src/app/api.ts");
    await state.commands.get("offlineCodeContext.securityScan")!();
    expect(state.outputLines.some((l) => l.includes("blocked") || l.includes("finding"))).toBe(
      true,
    );
  });

  it("search opens a quick pick with explained results and opens the chosen file", async () => {
    state.inputBox = "api";
    state.quickPickChoice = (items: Array<{ target: string }>) => items[0];
    await state.commands.get("offlineCodeContext.searchCodebase")!();
    expect(state.quickPickOptions.length).toBeGreaterThan(0);

    const topPick = state.quickPickOptions[0] as {
      label: string;
      description: string;
      detail: string;
      target: string;
    };
    expect(topPick.target).toBe("src/app/api.ts");
    expect(topPick.label).toContain("src/app/api.ts");
    expect(topPick.description).toMatch(/^score \d+\.\d{2}$/);
    expect(topPick.detail.length).toBeGreaterThan(0);
    expect(state.shownTextDocuments.some((d) => d.endsWith("api.ts"))).toBe(true);
  });

  it("selection mode exact-only returns only the active file", async () => {
    state.quickPickChoice = { label: "Exact selection only", value: false };
    await state.commands.get("offlineCodeContext.generateSelectionContext")!();
    await state.commands.get("offlineCodeContext.copyContext")!();
    expect(state.clipboard).toContain("### FILE: src/app/index.ts");
    expect(state.clipboard).not.toContain("### FILE: src/app/api.ts");
  });

  it("watcher: a debounced edit re-indexes only the changed file", async () => {
    const target = path.join(root, "src", "app", "api.ts");
    fs.writeFileSync(target, fs.readFileSync(target, "utf8") + "// watcher edit\n");
    for (const listener of state.watcherListeners.change) listener(fileUri(target));
    await waitFor(
      async () => {
        await state.commands.get("offlineCodeContext.copyFileContextToClipboard")!(fileUri(target));
        return state.clipboard?.includes("// watcher edit") ?? false;
      },
      10000,
      "watcher re-index content reflection",
    );
    expect(state.clipboard).toContain("// watcher edit");
  });

  it("watcher: deletion removes the entry and its records", async () => {
    const target = path.join(root, "src", "app", "leak.ts");
    fs.rmSync(target);
    for (const listener of state.watcherListeners.delete) listener(fileUri(target));

    await waitFor(
      () => countStoreEntries(storageDir) === 5,
      10000,
      "watcher to process file deletion and remove index entry",
    );

    const leakEntryPath = path.join(storageDir, entryRelativePath("src/app/leak.ts"));
    expect(fs.existsSync(leakEntryPath)).toBe(false);

    state.inputBox = "leak apiKey";
    await state.commands.get("offlineCodeContext.generateTaskContext")!();
    await state.commands.get("offlineCodeContext.copyContext")!();
    expect(state.clipboard).not.toContain("src/app/leak.ts");
  });

  it("index is reused across a restart with zero reparses", async () => {
    const second = new OccApplication(root, storageDir);
    second.initialize();
    expect(second.indexing.getEntries().size).toBe(6);
    second.resetParseCounter();
    const run = await second.indexing.indexWorkspace(CancellationSource.never());
    expect(run.reused).toBe(6);
    expect(run.reparsed).toBe(0);
    expect(second.parsedFileCount()).toBe(0);
  });

  it("generate before indexing offers to index through UI prompt (NOT_INDEXED path)", async () => {
    state.warningChoice = "Delete";
    await state.commands.get("offlineCodeContext.clearIndex")!();
    expect(countStoreEntries(storageDir)).toBe(0);

    state.inputBox = "implement auth";
    state.warningChoice = "Index Workspace";
    await state.commands.get("offlineCodeContext.generateTaskContext")!();

    expect(state.warnings).toContain("OCC: the workspace is not indexed yet.");
    expect(state.executed).toContain("offlineCodeContext.indexWorkspace");
    expect(state.messages.some((m) => m.startsWith("OCC: indexed"))).toBe(true);
    expect(countStoreEntries(storageDir)).toBe(6);
  });

  it("rebuild command re-indexes from scratch and updates store entries", async () => {
    const newFile = path.join(root, "src", "app", "newService.ts");
    fs.writeFileSync(newFile, "export const service = () => 99;\n");

    expect(countStoreEntries(storageDir)).toBe(6);
    await state.commands.get("offlineCodeContext.rebuildIndex")!();

    expect(state.messages.some((m) => m.startsWith("OCC: rebuilt index: 7 files"))).toBe(true);
    expect(countStoreEntries(storageDir)).toBe(7);

    const manifest = JSON.parse(fs.readFileSync(path.join(storageDir, "manifest.json"), "utf8"));
    expect(manifest.files["src/app/newService.ts"]).toBeDefined();

    const entryPath = path.join(storageDir, entryRelativePath("src/app/newService.ts"));
    expect(fs.existsSync(entryPath)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(entryPath, "utf8"));
    expect(entry.meta.path).toBe("src/app/newService.ts");
    expect(entry.symbols.some((s: { name: string }) => s.name === "service")).toBe(true);
  });

  it("indexCurrentFile reports outcome and persists incremental updates", async () => {
    await state.commands.get("offlineCodeContext.indexCurrentFile")!();
    expect(state.messages.some((m) => m.includes("src/app/index.ts → unchanged"))).toBe(true);

    const indexPath = path.join(root, "src", "app", "index.ts");
    fs.writeFileSync(
      indexPath,
      fs.readFileSync(indexPath, "utf8") + "export const extraSymbol = 42;\n",
    );

    state.messages = [];
    await state.commands.get("offlineCodeContext.indexCurrentFile")!();
    expect(state.messages.some((m) => m.includes("src/app/index.ts → indexed"))).toBe(true);

    const entryPath = path.join(storageDir, entryRelativePath("src/app/index.ts"));
    const entry = JSON.parse(fs.readFileSync(entryPath, "utf8"));
    expect(entry.symbols.some((s: { name: string }) => s.name === "extraSymbol")).toBe(true);

    state.messages = [];
    await state.commands.get("offlineCodeContext.indexCurrentFile")!();
    expect(state.messages.some((m) => m.includes("src/app/index.ts → unchanged"))).toBe(true);
  });

  it("showIndexStatus focuses the tree view", async () => {
    await state.commands.get("offlineCodeContext.showIndexStatus")!();
    expect(state.executed).toContain("offlineCodeContext.indexStatus.focus");
  });

  it("preview without a generated context warns instead of throwing", async () => {
    await state.commands.get("offlineCodeContext.previewContext")!();
    expect(state.warnings.some((w) => w.includes("generate a context first"))).toBe(true);
  });

  it("copy without a generated context warns instead of throwing", async () => {
    await state.commands.get("offlineCodeContext.copyContext")!();
    expect(state.warnings.some((w) => w.includes("generate a context first"))).toBe(true);
  });

  it("clipboard failure surfaces as an error message", async () => {
    state.inputBox = "api";
    await state.commands.get("offlineCodeContext.generateTaskContext")!();
    state.clipboardFails = true;
    await state.commands.get("offlineCodeContext.copyContext")!();
    expect(state.errors.some((e) => e.includes("clipboard write failed"))).toBe(true);
    state.clipboardFails = false;
  });

  it("clearIndex requires confirmation and completely clears store and manifest", async () => {
    expect(countStoreEntries(storageDir)).toBe(6);

    state.warningChoice = null;
    await state.commands.get("offlineCodeContext.clearIndex")!();
    expect(countStoreEntries(storageDir)).toBe(6);
    expect(state.messages.some((m) => m.includes("local index cleared"))).toBe(false);

    state.warningChoice = "Delete";
    await state.commands.get("offlineCodeContext.clearIndex")!();
    expect(state.messages.some((m) => m.includes("local index cleared"))).toBe(true);
    expect(countStoreEntries(storageDir)).toBe(0);

    const manifestPath = path.join(storageDir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(manifest.entryCount).toBe(0);
      expect(Object.keys(manifest.files).length).toBe(0);
    }
  });

  it("settings change prompts for a rebuild and rebuilds on confirm", async () => {
    state.infoChoice = "Rebuild";
    for (const listener of state.configChangeListeners) {
      listener({ affectsConfiguration: () => true });
    }
    await waitFor(
      () => state.executed.includes("offlineCodeContext.rebuildIndex"),
      10000,
      "rebuild command",
    );
    expect(state.messages.some((m) => m.includes("settings changed"))).toBe(true);
  });

  it("preview provider serves the exact payload string matching clipboard byte-for-byte", async () => {
    state.inputBox = "api util";
    await state.commands.get("offlineCodeContext.generateTaskContext")!();
    await state.commands.get("offlineCodeContext.previewContext")!();
    await state.commands.get("offlineCodeContext.copyContext")!();

    const provider = state.contentProviders.get(PREVIEW_SCHEME) as ContextPreviewProvider;
    expect(provider).toBeDefined();

    const previewUriStr = state.openedDocuments[state.openedDocuments.length - 1];
    const previewUri = {
      scheme: PREVIEW_SCHEME,
      path: previewUriStr,
      fsPath: previewUriStr,
    } as never;
    const servedContent = provider.provideTextDocumentContent(previewUri);

    expect(servedContent).toBe(state.clipboard);
    expect(servedContent).toContain("## WHY THESE FILES WERE SELECTED");

    const uninitialized = new ContextPreviewProvider();
    expect(uninitialized.provideTextDocumentContent(previewUri)).toContain(
      "no context generated yet",
    );
  });

  it("cancellation: indexWorkspace aborts cleanly when token is cancelled", async () => {
    state.cancelled = true;
    let threw = false;
    try {
      await state.commands.get("offlineCodeContext.indexWorkspace")!();
    } catch (e) {
      threw = true;
      expect((e as { code?: string }).code).toBe("CANCELLED");
    }
    expect(threw).toBe(true);
    expect(state.messages.some((m) => m.startsWith("OCC: indexed"))).toBe(false);
  });

  it("no workspace folder open: activate warns and aborts early", () => {
    state.root = null;
    state.commands.clear();
    state.warnings = [];
    state.treeViews = [];

    const dummyContext = {
      subscriptions: [] as Array<{ dispose(): void }>,
      storageUri: fileUri(path.join(os.tmpdir(), "dummy-storage")),
      globalStorageUri: fileUri(path.join(os.tmpdir(), "dummy-global")),
      asAbsolutePath: (p: string) => p,
    };
    activate(dummyContext as never);

    expect(state.warnings).toContain("OCC: open a folder to use Offline Code Context.");
    expect(state.commands.size).toBe(0);
    expect(state.treeViews.length).toBe(0);
  });

  it("watcher ignores file events outside workspace root", async () => {
    const beforeCount = countStoreEntries(storageDir);
    const outsideUri = fileUri(path.join(os.tmpdir(), "outside-workspace-file.ts"));

    for (const listener of state.watcherListeners.change) {
      listener(outsideUri);
    }
    await sleep(700);
    expect(countStoreEntries(storageDir)).toBe(beforeCount);
  });

  it("right-click folder outside workspace warns and aborts", async () => {
    const beforeDocs = state.openedDocuments.length;
    const outsideUri = fileUri(path.join(os.tmpdir(), "outside-folder"));

    await state.commands.get("offlineCodeContext.generateProjectContext")!(outsideUri);

    expect(state.warnings).toContain("OCC: the selected folder is outside the current workspace.");
    expect(state.openedDocuments.length).toBe(beforeDocs);
  });

  it("concurrent commands: rapid-fire indexing and task context generation do not conflict", async () => {
    state.inputBox = "concurrent execution task";
    const [indexRes, taskRes] = await Promise.allSettled([
      state.commands.get("offlineCodeContext.indexWorkspace")!(),
      state.commands.get("offlineCodeContext.generateTaskContext")!(),
    ]);

    expect(indexRes.status).toBe("fulfilled");
    expect(taskRes.status).toBe("fulfilled");
    expect(countStoreEntries(storageDir)).toBe(6);
  });
});
