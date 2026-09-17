import * as vscode from "vscode";

export const PREVIEW_SCHEME = "offline-code-context-preview";

/**
 * Virtual document showing the EXACT payload that Copy will export. Because
 * Copy re-uses the same string (never regenerates), preview and clipboard are
 * byte-identical by construction.
 */
export class ContextPreviewProvider implements vscode.TextDocumentContentProvider {
  private current: string | null = null;
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  setPayload(payload: string, mode: string): vscode.Uri {
    this.current = payload;
    const uri = vscode.Uri.parse(`${PREVIEW_SCHEME}:context-${mode}.txt`);
    this._onDidChange.fire(uri);
    return uri;
  }

  provideTextDocumentContent(_uri: vscode.Uri): string {
    return this.current ?? "(no context generated yet; run a Generate Context command first)";
  }
}
