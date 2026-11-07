import { afterEach, describe, expect, it } from "vitest";

import * as fs from "node:fs";

import * as path from "node:path";

import { OccApplication } from "./contextService";
import { makeTempDir, removeRepo, writeRepo } from "../testing/fixtures";
import { CancellationSource } from "../shared/cancellation";

/**
 * Tests for the ContextScope entry points used by the right-click commands:
 * folder scope (Explorer) and file scope (editor/tab menus). The scope only
 * constrains the candidate set at the retrieval boundary. Determinism,
 * budgeting, security screening, and the wire format must be unaffected.
 */
const SECRET_VALUE = "J8s2kLq9" + "zX1pQw7v" + "R3mNtYu5";

const FIXTURE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "scope-fixture", version: "1.0.0" }) + "\n",
  "src/app/index.ts": [
    "/** Application bootstrap for the app module. */",
    'import { api } from "./api";',
    'import { util } from "../shared/util";',
    "export const start = () => api() + util();",
    "",
  ].join("\n"),
  "src/app/api.ts": [
    "/** API helpers for the app module. */",
    'import { util } from "../shared/util";',
    "export const api = () => util() + 1;",
    "",
  ].join("\n"),
  "src/app/secret.ts": [
    `const apiKey = '${SECRET_VALUE}';`,
    "export const leak = apiKey;",
    "",
  ].join("\n"),
  "src/shared/util.ts": [
    "/** Shared utility outside the app folder. */",
    "export const util = () => 42;",
    "",
  ].join("\n"),
  "src/other/thing.ts": ["/** Unrelated module. */", "export const thing = 1;", ""].join("\n"),
};

function sourceFilesOf(payload: string): string[] {
  const source = payload.slice(payload.indexOf("## SOURCE"));
  const files: string[] = [];
  for (const match of source.matchAll(/^### FILE: (.+)$/gm)) {
    files.push(match[1]);
  }
  return files;
}

describe("OccApplication context scopes (right-click entry points)", () => {
  let root: string;
  let app: OccApplication;

  async function makeApp(): Promise<OccApplication> {
    root = makeTempDir();
    writeRepo(root, FIXTURE);
    const app2 = new OccApplication(root, path.join(root, ".occ-store"));
    await app2.indexing.indexWorkspace(CancellationSource.never());
    return app2;
  }

  afterEach(() => {
    if (root) removeRepo(root);
  });

  it("folder scope restricts source files to the subtree", async () => {
    app = await makeApp();
    const result = app.buildContext("project", { scope: { kind: "folder", relPath: "src/app" } });
    const files = sourceFilesOf(result.payload);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.startsWith("src/app/"), `source file outside scope: ${file}`).toBe(true);
    }
    // Root selection is folder-scoped even though these files exist project-wide.
    expect(files).not.toContain("src/shared/util.ts");
    expect(files).not.toContain("src/other/thing.ts");
    // Unscoped project context still covers the whole project (regression guard).
    const unscoped = app.buildContext("project", {});
    const unscopedFiles = sourceFilesOf(unscoped.payload);
    expect(unscopedFiles).toContain("src/shared/util.ts");
  });

  it("folder scope keeps cross-boundary relationships explainable", async () => {
    app = await makeApp();
    const result = app.buildContext("project", { scope: { kind: "folder", relPath: "src/app" } });
    const why = result.payload.slice(
      result.payload.indexOf("## WHY THESE FILES WERE SELECTED"),
      result.payload.indexOf("## SOURCE"),
    );
    const apiBlock = why.slice(
      why.indexOf("### src/app/api.ts"),
      why.indexOf("###", why.indexOf("### src/app/api.ts") + 4),
    );
    expect(apiBlock).toContain("imports src/shared/util.ts");
  });

  it("folder scope is deterministic (byte-identical payload)", async () => {
    app = await makeApp();
    const request = { scope: { kind: "folder" as const, relPath: "src/app" } };
    const r1 = app.buildContext("project", request);
    const r2 = app.buildContext("project", request);
    expect(r1.payload).toBe(r2.payload);
  });

  it("file scope normalizes onto the existing file mode (identical payload)", async () => {
    app = await makeApp();
    const viaScope = app.buildContext("project", {
      scope: { kind: "file", relPath: "src/app/api.ts" },
    });
    const viaMode = app.buildContext("file", { activeFile: "src/app/api.ts" });
    expect(viaScope.payload).toBe(viaMode.payload);
    // The seeded file is always present regardless of ranking.
    expect(viaScope.payload).toContain("### FILE: src/app/api.ts");
  });

  it("copy-path stats are computed and security policy still applies in scope", async () => {
    app = await makeApp();
    const result = app.buildContext("project", { scope: { kind: "folder", relPath: "src/app" } });
    expect(result.filesIncluded).toBeGreaterThan(0);
    expect(result.lines).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    // Default BLOCK policy withholds the secret file's source; the value is
    // byte-absent from the payload even from the scoped entry point.
    expect(result.security.blockedFiles.has("src/app/secret.ts")).toBe(true);
    expect(result.payload).not.toContain(SECRET_VALUE);
    expect(result.payload).toContain("### FILE: src/app/index.ts");
  });

  it("folder scope of the workspace root behaves like the unscoped project context", async () => {
    app = await makeApp();
    const scoped = app.buildContext("project", { scope: { kind: "folder", relPath: "" } });
    const unscoped = app.buildContext("project", {});
    expect(scoped.payload).toBe(unscoped.payload);
  });

  describe("F04: clear/rebuild reset derived retrieval indexes", () => {
    let root: string;
    let app: OccApplication;

    afterEach(() => {
      if (root) removeRepo(root);
    });

    function rankedPaths(app2: OccApplication, query: string): string[] {
      try {
        return (app2.buildContext("task", { taskText: query }).retrieval?.ranked ?? []).map(
          (r) => r.path,
        );
      } catch (e) {
        // after clearIndex the empty index throws NOT_INDEXED: no old results.
        if ((e as { code?: string }).code === "NOT_INDEXED") return [];
        throw e;
      }
    }

    it("rebuild after deleting a file drops it from search results", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "src/alpha.ts":
          "/** Alpha module with distinctive vocabulary. */\nexport const alpha = 1;\n",
      });
      app = new OccApplication(root, path.join(root, ".occ-store"), undefined as never);
      app.initialize();
      await app.indexing.indexWorkspace(CancellationSource.never());
      expect(rankedPaths(app, "alpha")).toContain("src/alpha.ts");
      fs.rmSync(path.join(root, "src/alpha.ts"));
      await app.indexing.rebuild(CancellationSource.never());
      expect(rankedPaths(app, "alpha")).not.toContain("src/alpha.ts");
    });

    it("clearIndex drops stale search results; reindex agrees with a fresh app", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "src/alpha.ts":
          "/** Alpha module with distinctive vocabulary. */\nexport const alpha = 1;\n",
        "src/beta.ts":
          "/** Beta module with different words entirely. */\nexport const beta = 2;\n",
      });
      app = new OccApplication(root, path.join(root, ".occ-store"), undefined as never);
      app.initialize();
      await app.indexing.indexWorkspace(CancellationSource.never());
      expect(rankedPaths(app, "alpha")).toContain("src/alpha.ts");
      await app.indexing.clearIndex();
      expect(rankedPaths(app, "alpha")).toHaveLength(0);
      // reindex after clear agrees with a fresh application (scores/IDF reset)
      await app.indexing.rebuild(CancellationSource.never());
      const fresh = new OccApplication(
        root,
        path.join(root, ".occ-store-fresh"),
        undefined as never,
      );
      fresh.initialize();
      await fresh.indexing.indexWorkspace(CancellationSource.never());
      expect(rankedPaths(app, "alpha")).toEqual(rankedPaths(fresh, "alpha"));
      const scored = app.buildContext("task", { taskText: "alpha" }).retrieval?.ranked ?? [];
      const freshScored = fresh.buildContext("task", { taskText: "alpha" }).retrieval?.ranked ?? [];
      expect(scored.map((r) => r.path + ":" + r.score.toFixed(4))).toEqual(
        freshScored.map((r) => r.path + ":" + r.score.toFixed(4)),
      );
    });
  });
});
