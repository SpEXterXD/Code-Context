import * as vscode from "vscode";

import { OccApplication } from "../application/contextService";
import type { ContextBuildResult, ContextMode, ContextScope } from "../context/contextBuilder";
import { ContextPreviewProvider } from "./previewProvider";
import { OccError } from "../shared/errors";
import { logger } from "../shared/logging";

/**
 * Registers all commands. Keep this layer thin: it adapts VS Code concepts
 * (editors, quick picks, input boxes) to the application services; all logic
 * lives in the application/domain layers.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  app: OccApplication,
  preview: ContextPreviewProvider,
): vscode.Disposable[] {
  const channel = vscode.window.createOutputChannel("Offline Code Context");
  context.subscriptions.push(channel);
  logger.addSink({
    log: (level, message) => channel.appendLine(`[${level}] ${message}`),
  });

  /** Stores the last built result so Preview/Copy are byte-identical. */
  let last: { mode: ContextMode; result: ContextBuildResult } | null = null;

  const withProgress = async <T>(
    title: string,
    task: (token: vscode.CancellationToken) => Promise<T>,
  ): Promise<T> => {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `OCC: ${title}` },
      async (_progress, token) => task(token),
    );
  };

  const buildAndStore = async (
    mode: ContextMode,
    request: {
      taskText?: string;
      activeFile?: string;
      selectedPaths?: string[];
      expandSelection?: boolean;
      scope?: ContextScope;
    },
    label: string,
    options: { silent?: boolean } = {},
  ): Promise<ContextBuildResult | null> => {
    try {
      const result = await withProgress(`building ${label}`, async () => {
        return app.buildContext(mode, request);
      });
      last = { mode, result };
      if (!options.silent) {
        const findings = result.security.safeFindings.length;
        void vscode.window.showInformationMessage(
          `OCC: ${label} ready: ${result.filesIncluded} files, ~${result.estimatedTokens} tokens` +
            (findings > 0 ? `, ${findings} security finding(s)` : ""),
        );
      }
      return result;
    } catch (e) {
      if (OccError.is(e, "NOT_INDEXED")) {
        const choice = await vscode.window.showWarningMessage(
          "OCC: the workspace is not indexed yet.",
          "Index Workspace",
        );
        if (choice === "Index Workspace")
          await vscode.commands.executeCommand("offlineCodeContext.indexWorkspace");
        return null;
      }
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith("SECURITY:")) {
        void vscode.window.showErrorMessage(`OCC: ${message}`);
      } else {
        void vscode.window.showErrorMessage(`OCC: ${label} failed: ${message}`);
      }
      return null;
    }
  };

  const activeRelPath = (): string | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return undefined;
    const rel = editor.document.uri.fsPath
      .slice(root.uri.fsPath.length)
      .replace(/\\/g, "/")
      .replace(/^\//, "");
    return rel.length > 0 ? rel : undefined;
  };

  /** Workspace-relative POSIX path for a right-clicked/selected resource, or null when outside the workspace. */
  const relFromUri = (uri: vscode.Uri | undefined): string | null => {
    if (!uri) return null;
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return null;
    const prefix = root.uri.fsPath;
    if (!uri.fsPath.startsWith(prefix)) return null;
    const rel = uri.fsPath.slice(prefix.length).replace(/\\/g, "/").replace(/^\//, "");
    return rel.length > 0 ? rel : null;
  };

  /**
   * Folder scope for the Explorer right-click commands. Returns null when no
   * Uri was passed (palette invocation → unscoped project context) or when
   * the resource is outside the workspace (warns and aborts via a thrown
   * sentinel handled by the caller).
   */
  const folderScopeFromUri = (uri: vscode.Uri | undefined): ContextScope | null | undefined => {
    if (!uri) return undefined; // palette invocation: unscoped
    const rel = relFromUri(uri);
    if (rel === null) {
      void vscode.window.showWarningMessage(
        "OCC: the selected folder is outside the current workspace.",
      );
      return null;
    }
    return { kind: "folder", relPath: rel };
  };

  /** Opens the byte-exact preview document for the given build result. */
  const openPreview = async (mode: ContextMode, result: ContextBuildResult): Promise<void> => {
    const uri = preview.setPayload(result.payload, mode);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside,
    });
  };

  /** Human-readable security suffix for confirmation toasts (no finding values, kinds only). */
  const securityNote = (result: ContextBuildResult): string => {
    const findings = result.security.safeFindings;
    const blocked = findings.filter((f) => f.action === "blocked").length;
    const redacted = findings.filter((f) => f.action === "redacted").length;
    const parts: string[] = [];
    if (blocked > 0) parts.push(`${blocked} blocked by security policy`);
    if (redacted > 0) parts.push(`${redacted} redacted for potential secrets`);
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
  };

  /** Builds, stores as `last` (Preview stays byte-consistent), and copies to the clipboard. Never opens the preview. */
  const buildAndCopy = async (
    mode: ContextMode,
    request: {
      taskText?: string;
      activeFile?: string;
      selectedPaths?: string[];
      expandSelection?: boolean;
      scope?: ContextScope;
    },
    label: string,
  ): Promise<void> => {
    const result = await buildAndStore(mode, request, label, { silent: true });
    if (!result) return;
    try {
      await vscode.env.clipboard.writeText(result.payload);
      void vscode.window.showInformationMessage(
        `OCC: copied ${label} to clipboard: ${result.filesIncluded} files, ` +
          `${result.lines} lines, ~${result.estimatedTokens} tokens` +
          `${securityNote(result)}`,
      );
    } catch (e) {
      void vscode.window.showErrorMessage(
        `OCC: clipboard write failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  /** Single-file selection: the active editor's path (multi-select is a future feature). */
  const selectionRelPath = (): string[] | undefined => {
    const editor = vscode.window.activeTextEditor;
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!editor || !root) return undefined;
    // Selection mode uses the active file as the (single) explicit selection;
    // multi-file selection would require a UI multi-pick, offered in Task mode.
    const rel = activeRelPath();
    return rel ? [rel] : undefined;
  };

  return [
    vscode.commands.registerCommand("offlineCodeContext.indexWorkspace", async () => {
      await withProgress("indexing workspace", async (token) => {
        const result = await app.indexing.indexWorkspace(toSignal(token));
        void vscode.window.showInformationMessage(
          `OCC: indexed ${result.totalFiles} files (${result.reparsed} parsed, ${result.reused} reused, ${result.removed} removed) in ${result.durationMs} ms`,
        );
      });
    }),

    vscode.commands.registerCommand("offlineCodeContext.rebuildIndex", async () => {
      await withProgress("rebuilding index", async (token) => {
        const result = await app.indexing.rebuild(toSignal(token));
        void vscode.window.showInformationMessage(
          `OCC: rebuilt index: ${result.totalFiles} files in ${result.durationMs} ms`,
        );
      });
    }),

    vscode.commands.registerCommand("offlineCodeContext.indexCurrentFile", async () => {
      const rel = activeRelPath();
      if (!rel) {
        void vscode.window.showWarningMessage("OCC: no active file to index.");
        return;
      }
      const outcome = await app.indexing.indexSingleFile(rel, neverSignal());
      void vscode.window.showInformationMessage(`OCC: ${rel} → ${outcome}`);
    }),

    vscode.commands.registerCommand("offlineCodeContext.showIndexStatus", async () => {
      await vscode.commands.executeCommand("offlineCodeContext.indexStatus.focus");
    }),

    vscode.commands.registerCommand("offlineCodeContext.searchCodebase", async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Search codebase (files, symbols, identifiers)",
        placeHolder: "e.g. rate limiting middleware",
      });
      if (query === undefined || query.trim().length === 0) return;
      const result = app.retriever.retrieve(query, { maxGraphDepth: 3, limit: 15 });
      if (result.ranked.length === 0) {
        void vscode.window.showInformationMessage(`OCC: no results for "${query}"`);
        return;
      }
      const picks = result.ranked.map((r) => ({
        label: `$(file) ${r.path}`,
        description: `score ${r.score.toFixed(2)}`,
        detail: app.retriever.explain(r).join(" · ") || "no specific signals",
        target: r.path,
      }));
      const chosen = await vscode.window.showQuickPick(picks, {
        placeHolder: "Top matches (reasons shown below each file)",
        matchOnDetail: true,
      });
      if (chosen) {
        const root = vscode.workspace.workspaceFolders?.[0];
        if (root) {
          const doc = vscode.Uri.file(`${root.uri.fsPath}/${chosen.target}`);
          void vscode.window.showTextDocument(doc, { preview: true });
        }
      }
    }),

    vscode.commands.registerCommand(
      "offlineCodeContext.generateProjectContext",
      async (uri?: vscode.Uri) => {
        const scope = folderScopeFromUri(uri);
        if (scope === null) return; // resource outside workspace (warning shown)
        const label = scope ? `project context (${scope.relPath}/)` : "project context";
        const result = await buildAndStore("project", scope ? { scope } : {}, label);
        if (result) await openPreview("project", result);
      },
    ),

    vscode.commands.registerCommand(
      "offlineCodeContext.copyProjectContextToClipboard",
      async (uri?: vscode.Uri) => {
        const scope = folderScopeFromUri(uri);
        if (scope === null) return;
        const label = scope ? `project context (${scope.relPath}/)` : "project context";
        await buildAndCopy("project", scope ? { scope } : {}, label);
      },
    ),

    vscode.commands.registerCommand(
      "offlineCodeContext.generateFileContext",
      async (uri?: vscode.Uri) => {
        // Right-click passes the tab/editor's Uri; palette falls back to the
        // active editor. A file scope is normalized to the file mode by the
        // application facade (pinned seed + existing tier expansion).
        const rel = relFromUri(uri) ?? activeRelPath();
        if (!rel) {
          void vscode.window.showWarningMessage("OCC: no active file.");
          return;
        }
        const result = await buildAndStore(
          "file",
          { scope: { kind: "file", relPath: rel } },
          `file context for ${rel}`,
        );
        if (result) await openPreview("file", result);
      },
    ),

    vscode.commands.registerCommand(
      "offlineCodeContext.copyFileContextToClipboard",
      async (uri?: vscode.Uri) => {
        const rel = relFromUri(uri) ?? activeRelPath();
        if (!rel) {
          void vscode.window.showWarningMessage("OCC: no active file.");
          return;
        }
        await buildAndCopy(
          "file",
          { scope: { kind: "file", relPath: rel } },
          `file context for ${rel}`,
        );
      },
    ),

    vscode.commands.registerCommand("offlineCodeContext.generateTaskContext", async () => {
      const task = await vscode.window.showInputBox({
        prompt: "Describe the task for the LLM (used to select relevant context)",
        placeHolder: "e.g. Add rate limiting to the login endpoint.",
      });
      if (task === undefined || task.trim().length === 0) return;
      await buildAndStore("task", { taskText: task }, "task context");
    }),

    vscode.commands.registerCommand("offlineCodeContext.generateSelectionContext", async () => {
      const paths = selectionRelPath();
      if (!paths || paths.length === 0) {
        void vscode.window.showWarningMessage("OCC: no active file to use as selection.");
        return;
      }
      const expand = await vscode.window.showQuickPick(
        [
          { label: "Exact selection only", value: false },
          { label: "Expand with dependencies & tests", value: true },
        ],
        { placeHolder: "Selection context scope" },
      );
      if (!expand) return;
      await buildAndStore(
        "selection",
        { selectedPaths: paths, expandSelection: expand.value },
        "selection context",
      );
    }),

    vscode.commands.registerCommand("offlineCodeContext.previewContext", async () => {
      if (!last) {
        void vscode.window.showWarningMessage(
          "OCC: generate a context first (Project/File/Task/Selection).",
        );
        return;
      }
      await openPreview(last.mode, last.result);
    }),

    vscode.commands.registerCommand("offlineCodeContext.copyContext", async () => {
      if (!last) {
        void vscode.window.showWarningMessage(
          "OCC: generate a context first (Project/File/Task/Selection).",
        );
        return;
      }
      try {
        await vscode.env.clipboard.writeText(last.result.payload);
        void vscode.window.showInformationMessage(
          `OCC: copied ${last.result.filesIncluded} files (~${last.result.estimatedTokens} tokens) to clipboard. Paste into your LLM chat.`,
        );
      } catch (e) {
        void vscode.window.showErrorMessage(
          `OCC: clipboard write failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }),

    vscode.commands.registerCommand("offlineCodeContext.securityScan", async () => {
      if (!last) {
        void vscode.window.showWarningMessage(
          "OCC: generate a context first; Security Scan reports on the current context package.",
        );
        return;
      }
      const findings = last.result.security.safeFindings;
      if (findings.length === 0) {
        void vscode.window.showInformationMessage(
          "OCC: no security findings in the current context package.",
        );
        return;
      }
      channel.appendLine(`Security findings in current context package (${findings.length}):`);
      for (const f of findings) {
        channel.appendLine(
          `  [${f.action}] ${f.kind} at ${f.filePath}:${f.line} - ${f.description}`,
        );
      }
      channel.show();
      void vscode.window.showWarningMessage(
        `OCC: ${findings.length} security finding(s). Details in the Output panel.`,
      );
    }),

    vscode.commands.registerCommand("offlineCodeContext.clearIndex", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "OCC: delete the local index for this workspace? (Rebuild on next index run.)",
        "Delete",
      );
      if (confirm !== "Delete") return;
      await app.indexing.clearIndex();
      void vscode.window.showInformationMessage("OCC: local index cleared.");
    }),
  ];
}

import { NEVER_CANCELLED, type CancellationSignal } from "../shared/cancellation";

function toSignal(token: vscode.CancellationToken): CancellationSignal {
  return {
    get isCancellationRequested(): boolean {
      return token.isCancellationRequested;
    },
    throwIfCancelled(): void {
      if (token.isCancellationRequested) throw new OccError("CANCELLED", "cancelled");
    },
  };
}

function neverSignal(): CancellationSignal {
  return NEVER_CANCELLED;
}
