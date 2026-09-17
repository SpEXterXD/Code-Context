import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, removeRepo, writeRepo, writeBinary } from "../testing/fixtures";
import { countLines, WorkspaceScanner } from "./workspaceScanner";
import { NEVER_CANCELLED } from "../shared/cancellation";

describe("countLines", () => {
  it("counts lines with and without trailing newline", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\r\nb\r\n")).toBe(2);
  });
});

describe("workspace scanner", () => {
  let root: string;

  afterEach(() => {
    if (root) removeRepo(root);
  });

  it("discovers files recursively with metadata", () => {
    root = makeTempDir();
    writeRepo(root, {
      "src/a.ts": "export const a = 1;\n",
      "src/deep/b.ts": "export const b = 2;\n",
      "README.md": "# hi\n",
    });
    const scan = new WorkspaceScanner().scan(root, NEVER_CANCELLED);
    expect(scan.files.map((f) => f.path)).toEqual(["README.md", "src/a.ts", "src/deep/b.ts"]);
    const a = scan.files.find((f) => f.path === "src/a.ts")!;
    expect(a.language).toBe("typescript");
    expect(a.lineCount).toBe(1);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.status).toBe("OK");
  });

  it("skips binary files and records the skip", () => {
    root = makeTempDir();
    writeRepo(root, { "src/a.ts": "const a = 1;\n" });
    writeBinary(root, "assets/logo.bin");
    const scan = new WorkspaceScanner().scan(root, NEVER_CANCELLED);
    const bin = scan.files.find((f) => f.path === "assets/logo.bin");
    expect(bin?.status).toBe("SKIPPED_BINARY");
    expect(bin?.lineCount).toBe(0);
  });

  it("skips oversized files", () => {
    root = makeTempDir();
    writeRepo(root, { "big.ts": "x".repeat(3000) });
    const scan = new WorkspaceScanner({ maxFileSizeBytes: 1024 }).scan(root, NEVER_CANCELLED);
    expect(scan.files[0]?.status).toBe("SKIPPED_TOO_LARGE");
  });

  it("respects .gitignore and config excludes", () => {
    root = makeTempDir();
    writeRepo(root, {
      ".gitignore": "ignored-dir/\n*.log\n",
      "src/keep.ts": "export {};\n",
      "ignored-dir/junk.ts": "junk\n",
      "noise.log": "noise\n",
      "node_modules/pkg/index.js": "module.exports = 1;\n",
    });
    const scan = new WorkspaceScanner().scan(root, NEVER_CANCELLED);
    expect(scan.files.map((f) => f.path)).toEqual([".gitignore", "src/keep.ts"]);
    expect(scan.excludedPaths.length).toBeGreaterThan(0);
  });

  it("detects test files by convention", () => {
    root = makeTempDir();
    writeRepo(root, {
      "src/auth.service.ts": "export class S {}\n",
      "src/auth.service.test.ts": "it('works', () => {});\n",
    });
    const scan = new WorkspaceScanner().scan(root, NEVER_CANCELLED);
    const test = scan.files.find((f) => f.path.endsWith(".test.ts"))!;
    expect(test.isTest).toBe(true);
    expect(scan.files.find((f) => f.path.endsWith("auth.service.ts"))!.isTest).toBe(false);
  });

  it("is deterministic: identical trees produce identical hashes and order", () => {
    const make = (): string => {
      const dir = makeTempDir();
      writeRepo(dir, {
        "b.ts": "export const b = 2;\n",
        "a.ts": "export const a = 1;\n",
        "src/c.ts": "export const c = 3;\n",
      });
      return dir;
    };
    const r1 = make();
    const r2 = make();
    try {
      const s1 = new WorkspaceScanner().scan(r1, NEVER_CANCELLED);
      const s2 = new WorkspaceScanner().scan(r2, NEVER_CANCELLED);
      expect(s1.files.map((f) => [f.path, f.contentHash, f.lineCount])).toEqual(
        s2.files.map((f) => [f.path, f.contentHash, f.lineCount]),
      );
    } finally {
      removeRepo(r1);
      removeRepo(r2);
    }
  });
});
