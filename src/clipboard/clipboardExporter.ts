import { OccError } from "../shared/errors";

/**
 * Clipboard abstraction. Domain/application code depends on this interface
 * only; the VS Code implementation lives in the extension layer and unit
 * tests inject mocks (no real OS clipboard access in tests).
 */
export interface ClipboardExporter {
  /** Writes text to the OS clipboard. Throws on failure. */
  writeText(text: string): Promise<void>;
}

export class InMemoryClipboard implements ClipboardExporter {
  lastText: string | null = null;
  failNext = false;

  async writeText(text: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new OccError("CLIPBOARD_FAILED", "clipboard unavailable (simulated)");
    }
    this.lastText = text;
  }
}
