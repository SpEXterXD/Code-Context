import { describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ImportResolver, loadAliasMapping } from "./importResolver";
import { createLinkFixture } from "../testing/fixtures";
import { bindWorkspaceRoot } from "../workspace/containment";

function makeRepo(
  files: Record<string, string>,
  tsconfig?: string,
): { root: string; known: Set<string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "occ-resolve-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  if (tsconfig) fs.writeFileSync(path.join(root, "tsconfig.json"), tsconfig);
  const known = new Set(Object.keys(files));
  return { root, known };
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

describe("ImportResolver", () => {
  it("resolves relative imports with extension omission", () => {
    const { root, known } = makeRepo({ "src/a.ts": "", "src/b.ts": "" });
    const resolver = new ImportResolver(known, loadAliasMapping(root));
    expect(resolver.resolve("./b", "src/a.ts")).toEqual({
      status: "RESOLVED",
      path: "src/b.ts",
      viaAlias: false,
    });
    cleanup(root);
  });

  it("resolves directory index files", () => {
    const { root, known } = makeRepo({ "src/a.ts": "", "src/lib/index.ts": "" });
    const resolver = new ImportResolver(known, loadAliasMapping(root));
    expect(resolver.resolve("./lib", "src/a.ts")).toEqual({
      status: "RESOLVED",
      path: "src/lib/index.ts",
      viaAlias: false,
    });
    cleanup(root);
  });

  it("maps .js specifiers to .ts sources", () => {
    const { root, known } = makeRepo({ "src/a.ts": "", "src/b.ts": "" });
    const resolver = new ImportResolver(known, loadAliasMapping(root));
    expect(resolver.resolve("./b.js", "src/a.ts")).toEqual({
      status: "RESOLVED",
      path: "src/b.ts",
      viaAlias: false,
    });
    cleanup(root);
  });

  it("resolves tsconfig path aliases", () => {
    const { root, known } = makeRepo(
      { "src/services/auth.ts": "", "src/routes/r.ts": "" },
      `{
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "@/*": ["src/*"] }
        }
      }`,
    );
    const resolver = new ImportResolver(known, loadAliasMapping(root));
    expect(resolver.resolve("@/services/auth", "src/routes/r.ts")).toEqual({
      status: "RESOLVED",
      path: "src/services/auth.ts",
      viaAlias: true,
    });
    cleanup(root);
  });

  it("falls back to jsconfig when tsconfig is oversized or linked outside the root", () => {
    const primary = '{"compilerOptions":{"paths":{"@lib/*":["left/*"]}}}';
    const fallback = '{"compilerOptions":{"paths":{"@lib/*":["right/*"]}}}';
    const { root, known } = makeRepo(
      { "left/foo.ts": "", "right/foo.ts": "", "jsconfig.json": fallback },
      primary,
    );
    const outside = makeRepo({}, primary);
    const tsconfig = path.join(root, "tsconfig.json");
    try {
      const binding = bindWorkspaceRoot(root);
      const resolve = () =>
        new ImportResolver(known, loadAliasMapping(binding, 256)).resolve("@lib/foo", "a.ts");
      const expectedFallback = { status: "RESOLVED", path: "right/foo.ts", viaAlias: true };
      expect(resolve()).toEqual({ status: "RESOLVED", path: "left/foo.ts", viaAlias: true });

      fs.writeFileSync(tsconfig, primary + " ".repeat(256));
      expect(resolve()).toEqual(expectedFallback);

      fs.unlinkSync(tsconfig);
      const link = createLinkFixture(path.join(outside.root, "tsconfig.json"), tsconfig, "file");
      try {
        expect(resolve()).toEqual(expectedFallback);
      } finally {
        link.cleanup();
      }
    } finally {
      cleanup(root);
      cleanup(outside.root);
    }
  });

  it("classifies bare specifiers as external with package root", () => {
    const { root, known } = makeRepo({ "src/a.ts": "" });
    const resolver = new ImportResolver(known, loadAliasMapping(root));
    expect(resolver.resolve("express", "src/a.ts")).toEqual({ status: "EXTERNAL", pkg: "express" });
    expect(resolver.resolve("@scope/pkg/sub", "src/a.ts")).toEqual({
      status: "EXTERNAL",
      pkg: "@scope/pkg",
    });
    cleanup(root);
  });

  it("returns UNRESOLVED with a reason instead of guessing", () => {
    const { root, known } = makeRepo({ "src/a.ts": "" });
    const resolver = new ImportResolver(known, loadAliasMapping(root));
    const outcome = resolver.resolve("./missing", "src/a.ts");
    expect(outcome.status).toBe("UNRESOLVED");
    expect(outcome.status === "UNRESOLVED" && outcome.reason).toContain("missing");
    cleanup(root);
  });
});
