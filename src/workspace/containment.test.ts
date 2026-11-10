import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  checkComponentLinks,
  hasTraversalSegment,
  isLexicallyInsideRoot,
  readBoundedBuffer,
  readBoundedFile,
} from "./containment";
import { makeTempDir, removeRepo, writeRepo, createLinkFixture } from "../testing/fixtures";

describe("Stage 3: shared containment policy", () => {
  let root: string;

  afterEach(() => {
    if (root) removeRepo(root);
  });

  describe("lexical containment checks", () => {
    it("hasTraversalSegment identifies actual '..' segments only", () => {
      expect(hasTraversalSegment("..")).toBe(true);
      expect(hasTraversalSegment("../file.ts")).toBe(true);
      expect(hasTraversalSegment("dir/../file.ts")).toBe(true);
      expect(hasTraversalSegment("dir/..")).toBe(true);
      expect(hasTraversalSegment("dir\\..\\file.ts")).toBe(true);

      // Legal file/folder names starting with dots are not traversal
      expect(hasTraversalSegment("..notes.ts")).toBe(false);
      expect(hasTraversalSegment("src/..notes.ts")).toBe(false);
      expect(hasTraversalSegment("...weird.ts")).toBe(false);
      expect(hasTraversalSegment("normal.ts")).toBe(false);
    });

    it("isLexicallyInsideRoot rejects traversal, outside paths, and the root itself", () => {
      const base = path.join("C:", "work", "repo");
      expect(isLexicallyInsideRoot(base, path.join(base, "src", "index.ts"))).toBe(true);
      expect(isLexicallyInsideRoot(base, path.join(base, "..notes.ts"))).toBe(true);
      expect(isLexicallyInsideRoot(base, path.join(base, "..", "outside.ts"))).toBe(false);
      expect(isLexicallyInsideRoot(base, path.join("C:", "work", "other", "a.ts"))).toBe(false);
      // Sibling root sharing a prefix fails
      expect(isLexicallyInsideRoot(base, path.join("C:", "work", "repo2", "a.ts"))).toBe(false);
      // The root itself is not a file
      expect(isLexicallyInsideRoot(base, base)).toBe(false);
    });
  });

  describe("checkComponentLinks input validation & root binding", () => {
    it("validates relative input and rejects traversal before walking", () => {
      root = makeTempDir();
      writeRepo(root, { "src/a.ts": "export const a = 1;\n" });

      // Traversal inputs rejected
      expect(checkComponentLinks(root, "../outside.ts")).toEqual({
        ok: false,
        reason: "traversal",
      });
      expect(checkComponentLinks(root, "src/../../outside.ts")).toEqual({
        ok: false,
        reason: "traversal",
      });
      expect(checkComponentLinks(root, "src/../..")).toEqual({
        ok: false,
        reason: "traversal",
      });

      // Absolute paths rejected
      const abs = path.join(root, "src", "a.ts");
      expect(checkComponentLinks(root, abs)).toEqual({
        ok: false,
        reason: "traversal",
      });

      // Sibling root sharing prefix rejected
      const siblingPath = root + "2/file.ts";
      expect(checkComponentLinks(root, path.relative(root, siblingPath))).toEqual({
        ok: false,
        reason: "traversal",
      });
    });

    it("accepts legal root-level names like ..notes.ts", () => {
      root = makeTempDir();
      writeRepo(root, { "..notes.ts": "export const n = 1;\n" });
      expect(checkComponentLinks(root, "..notes.ts", { requireLeafFile: true })).toMatchObject({
        ok: true,
      });
    });

    it("supports root-folder scope when requireLeafFile is false", () => {
      root = makeTempDir();
      expect(checkComponentLinks(root, "", { requireLeafFile: false })).toMatchObject({ ok: true });
      expect(checkComponentLinks(root, ".", { requireLeafFile: false })).toMatchObject({
        ok: true,
      });

      // With requireLeafFile true, root folder is not a regular file
      expect(checkComponentLinks(root, "", { requireLeafFile: true })).toEqual({
        ok: false,
        reason: "not-regular-file",
      });
    });

    it("verifies root binding: rejects missing or symlinked rootPath", () => {
      root = makeTempDir();
      const missingRoot = path.join(root, "nonexistent");
      expect(checkComponentLinks(missingRoot, "a.ts")).toEqual({ ok: false, reason: "missing" });

      // Symlinked rootPath
      const targetDir = path.join(root, "target");
      fs.mkdirSync(targetDir);
      const linkRoot = path.join(root, "linkRoot");
      const fixture = createLinkFixture(targetDir, linkRoot, "dir");
      try {
        expect(checkComponentLinks(linkRoot, "a.ts")).toEqual({
          ok: false,
          reason: "symlink-component",
        });
      } finally {
        fixture.cleanup();
      }
    });
  });

  describe("readBoundedBuffer and readBoundedFile", () => {
    it("reads normal in-workspace file content within size cap", () => {
      root = makeTempDir();
      writeRepo(root, { "src/hello.txt": "hello world\n" });
      const content = readBoundedFile(root, "src/hello.txt", 1024);
      expect(content).toBe("hello world\n");

      const buf = readBoundedBuffer(root, "src/hello.txt", 1024);
      expect(buf?.toString("utf8")).toBe("hello world\n");
    });

    it("fails closed on oversized files", () => {
      root = makeTempDir();
      writeRepo(root, { "src/big.txt": "x".repeat(500) });
      expect(readBoundedFile(root, "src/big.txt", 100)).toBeNull();
      expect(readBoundedBuffer(root, "src/big.txt", 100)).toBeNull();
    });

    it("fails closed on missing files or directories", () => {
      root = makeTempDir();
      writeRepo(root, { "src/dir/file.txt": "content" });
      expect(readBoundedFile(root, "src/nonexistent.txt")).toBeNull();
      expect(readBoundedFile(root, "src/dir")).toBeNull(); // directory is not a regular file
    });

    it("fails closed on link components", () => {
      root = makeTempDir();
      const outside = makeTempDir();
      writeRepo(outside, { "secret.txt": "SECRET_12345\n" });
      const fixture = createLinkFixture(outside, path.join(root, "outside-link"), "dir");
      try {
        expect(readBoundedFile(root, "outside-link/secret.txt")).toBeNull();
        expect(readBoundedBuffer(root, "outside-link/secret.txt")).toBeNull();
      } finally {
        fixture.cleanup();
        removeRepo(outside);
      }
    });
  });

  describe("native path representation", () => {
    it("validates and reads the same nested file", () => {
      root = makeTempDir();
      writeRepo(root, { "src/nested/file.txt": "nested-content\n" });

      const relativePath = path.join("src", "nested", "file.txt");
      expect(checkComponentLinks(root, relativePath, { requireLeafFile: true })).toEqual({
        ok: true,
        validatedPath: path.join(root, "src", "nested", "file.txt"),
      });
      expect(readBoundedFile(root, relativePath)).toBe("nested-content\n");
    });

    it("uses native backslash semantics when validating and reading a file", () => {
      root = makeTempDir();
      const relativePath = "src/lit\\file.ts";
      const fixturePath =
        process.platform === "win32"
          ? path.join(root, "src", "lit", "file.ts")
          : path.join(root, "src", "lit\\file.ts");
      fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
      fs.writeFileSync(fixturePath, "backslash-content\n");

      expect(checkComponentLinks(root, relativePath, { requireLeafFile: true })).toEqual({
        ok: true,
        validatedPath: fixturePath,
      });
      expect(readBoundedFile(root, relativePath)).toBe("backslash-content\n");
    });
  });
});
