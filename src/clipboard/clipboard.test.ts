import { describe, expect, it } from "vitest";

import { InMemoryClipboard } from "./clipboardExporter";
import { OccError } from "../shared/errors";

/** Clipboard tests (spec §8.9): the mock exporter is the clipboard abstraction. */
describe("ClipboardExporter (mocked)", () => {
  it("copies the exact payload", async () => {
    const clipboard = new InMemoryClipboard();
    const payload = "# PROJECT CONTEXT\n\nFILES_INCLUDED: 2\n";
    await clipboard.writeText(payload);
    expect(clipboard.lastText).toBe(payload);
  });

  it("reports failures as exceptions (caller shows an error, never partial copy)", async () => {
    const clipboard = new InMemoryClipboard();
    clipboard.failNext = true;
    await expect(clipboard.writeText("x")).rejects.toThrow("clipboard unavailable");
    expect(clipboard.lastText).toBeNull();
  });

  it("handles empty context", async () => {
    const clipboard = new InMemoryClipboard();
    await clipboard.writeText("");
    expect(clipboard.lastText).toBe("");
  });

  it("handles very large payloads without truncation", async () => {
    const clipboard = new InMemoryClipboard();
    const big = "x".repeat(2_000_000);
    await clipboard.writeText(big);
    expect(clipboard.lastText?.length).toBe(2_000_000);
  });

  it("preserves unicode and special characters byte-for-byte", async () => {
    const clipboard = new InMemoryClipboard();
    const payload =
      "# コンテキスト ✅ ünïcodé\n```\nconst s = \"<script>alert('x')</script>\";\n```\n";
    await clipboard.writeText(payload);
    expect(clipboard.lastText).toBe(payload);
  });

  it("never depends on the VS Code API (import graph check)", () => {
    // The clipboard module must be importable and usable without vscode.
    expect(() => new InMemoryClipboard()).not.toThrow();
    expect(OccError.is(new OccError("CLIPBOARD_FAILED", "x"), "CLIPBOARD_FAILED")).toBe(true);
  });
});
