import * as vscode from "vscode";

import type { IndexStatus } from "../application/indexingService";

/** Non-blocking status bar item reflecting index state. */
export class StatusBar {
  private item: vscode.StatusBarItem;

  constructor(private readonly enabled: () => boolean) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  }

  attach(onStatus: (cb: (s: IndexStatus) => void) => void): void {
    onStatus((status) => this.render(status));
  }

  private render(status: IndexStatus): void {
    if (!this.enabled()) {
      this.item.hide();
      return;
    }
    this.item.command = "offlineCodeContext.showIndexStatus";
    switch (status.state) {
      case "indexing":
        this.item.text = `$(sync~spin) OCC: indexing… (${status.fileCount} files)`;
        this.item.tooltip = "Offline Code Context is indexing the workspace";
        break;
      case "ready":
        this.item.text = `$(check) OCC: ${status.fileCount} files`;
        this.item.tooltip = "Offline Code Context index is up to date";
        break;
      case "empty":
        this.item.text = "$(circle-slash) OCC: not indexed";
        this.item.tooltip = "Run 'OCC: Index Workspace' to build the local index";
        break;
      case "error":
        this.item.text = "$(error) OCC: index error";
        this.item.tooltip = status.lastError ?? "Indexing failed";
        break;
    }
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
