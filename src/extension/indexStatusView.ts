import * as vscode from "vscode";

import type { IndexStatus } from "../application/indexingService";

interface StatusNode extends vscode.TreeItem {
  contextValue: string;
}

/**
 * Index Status view: live, non-blocking progress during indexing plus the
 * last run summary (files, re-parsed, reused, removed, duration).
 */
export class IndexStatusView implements vscode.TreeDataProvider<StatusNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private status: IndexStatus = { state: "empty", fileCount: 0 };

  constructor() {
    // no-op
  }

  attach(onStatus: (cb: (s: IndexStatus) => void) => void): void {
    onStatus((s) => {
      this.status = s;
      this.refresh();
    });
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: StatusNode): vscode.TreeItem {
    return element;
  }

  getChildren(): StatusNode[] {
    const mk = (label: string, description?: string, icon = "info"): StatusNode => {
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None) as StatusNode;
      item.description = description;
      item.iconPath = new vscode.ThemeIcon(icon);
      item.contextValue = "statusNode";
      return item;
    };
    const nodes: StatusNode[] = [];
    switch (this.status.state) {
      case "empty":
        nodes.push(mk("Not indexed", "Run 'OCC: Index Workspace'", "circle-slash"));
        break;
      case "indexing":
        nodes.push(mk("Indexing…", `${this.status.fileCount} files indexed so far`, "sync~spin"));
        break;
      case "ready": {
        nodes.push(mk("Index ready", `${this.status.fileCount} files`, "check"));
        const last = this.status.lastResult;
        if (last) {
          nodes.push(
            mk(
              "Last full run",
              `${last.reparsed} parsed, ${last.reused} reused, ${last.removed} removed in ${last.durationMs} ms`,
              "history",
            ),
          );
        }
        break;
      }
      case "error":
        nodes.push(mk("Index error", this.status.lastError ?? "unknown", "error"));
        break;
    }
    return nodes;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
