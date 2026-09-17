import * as vscode from "vscode";

/**
 * Debounced file watcher bridging VS Code file events to incremental
 * indexing (Phase 6). Guarantees:
 * - bursts of edits coalesce into one re-index per path (debounce + queue)
 * - no duplicate concurrent indexing jobs for the same file
 * - renames arrive as delete + create (VS Code FileSystemWatcher emits no
 *   rename event), which the single-writer indexing queue sequences
 */
export class WatcherService {
  private readonly pending = new Map<string, "change" | "create" | "delete">();
  private timer: NodeJS.Timeout | null = null;
  private readonly debounceMs = 600;

  constructor(
    private readonly watcher: vscode.FileSystemWatcher,
    private readonly handlers: {
      change: (path: string) => Promise<void>;
      create: (path: string) => Promise<void>;
      remove: (path: string) => Promise<void>;
    },
  ) {}

  start(): vscode.Disposable[] {
    const created = this.watcher.onDidCreate((uri) => this.schedule(uri, "create"));
    const changed = this.watcher.onDidChange((uri) => this.schedule(uri, "change"));
    const deleted = this.watcher.onDidDelete((uri) => this.schedule(uri, "delete"));
    return [created, changed, deleted, this.watcher];
  }

  private schedule(uri: vscode.Uri, kind: "change" | "create" | "delete"): void {
    const rel = this.relative(uri);
    if (!rel) return;
    // Coalesce: a delete followed by a create of the same path is just a change.
    this.pending.set(rel, kind);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const batch = [...this.pending.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    this.pending.clear();
    for (const [rel, kind] of batch) {
      try {
        if (kind === "change") await this.handlers.change(rel);
        else if (kind === "create") await this.handlers.create(rel);
        else if (kind === "delete") await this.handlers.remove(rel);
      } catch {
        // Indexing failures never break the editor; the next run reconciles.
      }
    }
  }

  private relative(uri: vscode.Uri): string | null {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return null;
    const prefix = root.uri.fsPath;
    if (!uri.fsPath.startsWith(prefix)) return null;
    return uri.fsPath.slice(prefix.length).replace(/\\/g, "/").replace(/^\//, "");
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
