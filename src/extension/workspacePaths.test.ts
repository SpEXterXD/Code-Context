import { describe, expect, it } from "vitest";

import * as path from "node:path";

import { isInsideRoot, relativeToRoot } from "./workspacePaths";

describe("FU7: workspace path resolution", () => {
  const root = path.join("C:", "repo");

  it("resolves an inside path to POSIX-relative", () => {
    expect(relativeToRoot(root, path.join("C:", "repo", "src", "a.ts"))).toBe("src/a.ts");
  });

  it("returns null for outside paths", () => {
    expect(relativeToRoot(root, path.join("C:", "other", "a.ts"))).toBeNull();
    expect(relativeToRoot(root, path.join("C:", "repo"))).toBeNull(); // root itself
  });

  it("is case-tolerant on Windows (drive-letter and path casing)", () => {
    // The original raw slice + case-sensitive startsWith returned null here,
    // surfacing as "no active file" / "outside the workspace".
    expect(relativeToRoot(path.join("c:", "repo"), path.join("C:", "REPO", "src", "a.ts"))).toBe(
      "src/a.ts",
    );
    expect(isInsideRoot(path.join("c:", "repo"), path.join("C:", "REPO", "a.ts"))).toBe(true);
  });

  it("rejects traversal results", () => {
    expect(relativeToRoot(root, path.join("C:", "repo", "..", "outside.ts"))).toBeNull();
  });
});
