import * as vscode from "vscode";

import { OccApplication } from "../application/contextService";
import { readConfig, statusBarEnabled } from "./config";
import { StatusBar } from "./statusBar";
import { IndexStatusView } from "./indexStatusView";
import { ContextPreviewProvider, PREVIEW_SCHEME } from "./previewProvider";
import { WatcherService } from "./watcherService";
import { registerCommands } from "./commands";
import { OccError } from "../shared/errors";
import { logger } from "../shared/logging";
import { NEVER_CANCELLED, type CancellationSignal } from "../shared/cancellation";

let app: OccApplication | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showWarningMessage("OCC: open a folder to use Offline Code Context.");
    return;
  }

  const config = readConfig();
  const storeRoot =
    context.storageUri?.fsPath ?? vscode.Uri.joinPath(context.globalStorageUri, "store").fsPath;
  app = new OccApplication(root, storeRoot, config);
  app.initialize();

  // ---- git trust gate (see docs/SECURITY.md) ----
  // Repo-controlled git configuration (core.fsmonitor, hooks, ext:: transport)
  // is only safe to exercise where VS Code trusts the workspace. Git features
  // (currently: the optional recency bonus) are skipped entirely in
  // untrusted workspaces, with a visible status note until trust is granted.
  // `!== false` keeps headless/mock environments (no trust API) permissive.
  const gitTrusted = vscode.workspace.isTrusted !== false;
  app.setGitRecencyAllowed(gitTrusted);
  if (gitTrusted) void app.refreshGitRecency();
  let trustNote: vscode.StatusBarItem | null = null;
  const showTrustNote = (): void => {
    if (trustNote || !config.enableGitRecency) return;
    trustNote = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    trustNote.text = "$(shield) OCC: git metadata off (untrusted workspace)";
    trustNote.tooltip =
      "Git-based recency metadata is disabled because this workspace is not trusted. It enables automatically when you trust the workspace.";
    trustNote.show();
  };
  if (config.enableGitRecency && !gitTrusted) showTrustNote();
  if (typeof vscode.workspace.onDidGrantWorkspaceTrust === "function") {
    context.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        app?.setGitRecencyAllowed(true);
        void app?.refreshGitRecency();
        trustNote?.dispose();
        trustNote = null;
      }),
    );
  }

  // ---- UI wiring ----
  const statusView = new IndexStatusView();
  const tree = vscode.window.createTreeView("offlineCodeContext.indexStatus", {
    treeDataProvider: statusView,
  });
  const statusBar = new StatusBar(statusBarEnabled);

  app.indexing.onStatusChange((_s) => {
    statusView.refresh();
  });
  statusView.attach((cb) => app?.indexing.onStatusChange(cb));
  statusBar.attach((cb) => app?.indexing.onStatusChange(cb));

  const preview = new ContextPreviewProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, preview),
  );

  // ---- commands ----
  const commands = registerCommands(context, app, preview);
  context.subscriptions.push(...commands, tree, statusBar, statusView);

  // ---- watcher (Phase 6) ----
  // VS Code emits no rename events: a rename arrives as delete + create,
  // which the indexing queue sequences. IndexingService.renameFile remains
  // available (tested) for future callers that observe renames directly.
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const watcherService = new WatcherService(watcher, {
    change: (rel) => app!.indexing.indexSingleFile(rel, neverCancelled()).then(() => undefined),
    create: (rel) => app!.indexing.indexSingleFile(rel, neverCancelled()).then(() => undefined),
    remove: (rel) => app!.indexing.removeFile(rel),
  });
  context.subscriptions.push(...watcherService.start(), watcherService);

  // Config changes trigger a fresh configuration on next use; a full rebuild
  // is required when exclusion patterns change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("offlineCodeContext")) {
        void vscode.window
          .showInformationMessage(
            "OCC: settings changed. Rebuild the index to apply new exclusions?",
            "Rebuild",
          )
          .then((choice) => {
            if (choice === "Rebuild") {
              void vscode.commands.executeCommand("offlineCodeContext.rebuildIndex");
            }
          });
      }
    }),
  );

  // Background warm-up: index on startup (non-blocking, cancellable).
  const warmup: { cancelled: boolean } = { cancelled: false };
  const warmupSignal: CancellationSignal = {
    get isCancellationRequested(): boolean {
      return warmup.cancelled;
    },
    throwIfCancelled(): void {
      if (warmup.cancelled) throw new OccError("CANCELLED", "startup indexing cancelled");
    },
  };
  context.subscriptions.push({ dispose: () => (warmup.cancelled = true) });
  void app.indexing.indexWorkspace(warmupSignal).catch((e: unknown) => {
    logger.error(`startup indexing failed: ${(e as Error)?.message ?? String(e)}`);
  });

  logger.info("Offline Code Context activated (offline mode, no telemetry).");
}

export function deactivate(): void {
  app = null;
}

function neverCancelled(): CancellationSignal {
  return NEVER_CANCELLED;
}
