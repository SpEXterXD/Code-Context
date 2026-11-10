import { describe, expect, it } from "vitest";

import * as path from "node:path";

import { relativeToRoot, relativeToRootWith } from "./workspacePaths";

describe("FU7: workspace path resolution", () => {
  const root = path.join("C:", "repo");

  it("resolves an inside path to POSIX-relative", () => {
    expect(relativeToRoot(root, path.join("C:", "repo", "src", "a.ts"))).toBe("src/a.ts");
  });

  it("returns null for outside paths and '' for the root itself", () => {
    expect(relativeToRoot(root, path.join("C:", "other", "a.ts"))).toBeNull();
    // Review fix: the root folder is a valid FOLDER scope — an empty string,
    // not a rejection. null always means outside.
    expect(relativeToRoot(root, root)).toBe("");
  });

  it("treats only an actual '..' segment as traversal", () => {
    expect(relativeToRoot(root, path.join("C:", "repo", "..", "outside.ts"))).toBeNull();
    // A legal name that merely BEGINS with dots is not traversal.
    expect(relativeToRoot(root, path.join("C:", "repo", "..notes.ts"))).toBe("..notes.ts");
  });

  // Platform-native semantics on every platform; win32 folding exercised
  // explicitly through the test seam so Linux/macOS CI covers it too.
  it("win32 comparison is case-insensitive (drive letter and path casing)", () => {
    expect(relativeToRootWith(path.win32, "c:\\repo", "C:\\REPO\\src\\a.ts")).toBe("src/a.ts");
    expect(isInsideRootWin32("c:\\repo", "C:\\REPO\\a.ts")).toBe(true);
    expect(isInsideRootWin32("c:\\repo", "C:\\other\\a.ts")).toBe(false);
  });

  it("posix comparison is case-sensitive and platform-native", () => {
    expect(relativeToRootWith(path.posix, "/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(relativeToRootWith(path.posix, "/repo", "/REPO/src/a.ts")).toBeNull();
    // Native helper agrees with the platform it runs on.
    const native = relativeToRoot(root, path.join("C:", "REPO", "src", "a.ts"));
    if (process.platform === "win32") expect(native).toBe("src/a.ts");
    else expect(native).toBeNull();
  });
});

function isInsideRootWin32(rootFsPath: string, fsPath: string): boolean {
  return relativeToRootWith(path.win32, rootFsPath, fsPath) !== null;
}
