import { afterEach, describe, expect, it } from "vitest";

import * as fs from "node:fs";

import * as path from "node:path";

import { OccApplication, resolveProjectName, DEFAULT_CONFIG } from "./contextService";
import { makeTempDir, removeRepo, writeRepo, createLinkFixture } from "../testing/fixtures";
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

  // Review finding (follow-up 6): file-scope normalization dropped seedSet —
  // with an identical SeedSet, the activeFile request rendered CURRENT CHANGES
  // while scope:{kind:'file'} silently lost the diff and hints.
  it("file scope forwards the seedSet (hints survive normalization; diffs omitted)", async () => {
    app = await makeApp();
    const seedSet = {
      changedPaths: [{ path: "src/app/api.ts", state: "unstaged" as const }],
      diffSections: [{ path: "src/app/api.ts", diff: "+export const fresh = 1;" }],
      openEditors: [],
      diagnostics: [],
      stackFrames: [],
      notes: [],
    };
    const viaScope = app.buildContext("project", {
      scope: { kind: "file", relPath: "src/app/api.ts" },
      seedSet,
    });
    const viaMode = app.buildContext("file", { activeFile: "src/app/api.ts", seedSet });
    expect(viaScope.payload).toBe(viaMode.payload);
    // Stage 1: the forwarded seedSet's diff text is omitted at the shared
    // boundary; the changed-path hint still reaches WHY in both paths.
    expect(viaScope.payload).not.toContain("## CURRENT CHANGES");
    expect(viaScope.payload).not.toContain("+export const fresh = 1;");
    expect(viaScope.rankedForDisplay.some((w) => w.path === "src/app/api.ts")).toBe(true);
  });

  // Stage 2 correction B: the live source read is bounded by the configured
  // byte cap. A file that grows past the cap after indexing degrades to
  // metadata-only (the grown content, and anything in it, never exports);
  // exact-cap files export; the cap counts UTF-8 BYTES, not characters.
  describe("Stage 2 correction B: bounded live source snapshots", () => {
    afterEach(() => {
      if (root) removeRepo(root);
    });

    function makeCappedApp(cap: number): OccApplication {
      const app2 = new OccApplication(root, path.join(root, ".occ-store"), {
        maxFiles: 40,
        maxChars: 120000,
        maxLines: 3000,
        maxTokens: 30000,
        maxGraphDepth: 3,
        maxCodeLinesPerFile: 400,
        structureDepth: 4,
        currentChangesMaxTokens: 1500,
        secretPolicy: "block",
        redactSecrets: true,
        enableGitRecency: false,
        excludePatterns: [],
        respectGitignore: true,
        maxFileSizeBytes: cap,
      });
      return app2;
    }

    it("growth past the cap after indexing skips the live source (metadata kept)", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "package.json": JSON.stringify({ name: "grow", version: "1.0.0" }) + "\n",
        "src/grown.ts": "export const small = 1;\n",
      });
      const app = makeCappedApp(300);
      await app.indexing.indexWorkspace(CancellationSource.never());
      // Grow the file well past the cap WITHOUT reindexing. The grown body is
      // credential-free on purpose: a credential would trip BLOCK and mask
      // the size violation. Only the byte bound can keep this source out.
      fs.writeFileSync(
        path.join(root, "src", "grown.ts"),
        "export const small = 1;\n" +
          Array.from({ length: 20 }, (_, i) => `// pad ${i} aaaa`).join("\n") +
          "\nexport const tail = 2;\n",
      );
      const result = app.buildContext("file", { activeFile: "src/grown.ts" });
      // No grown source bytes reach the payload; metadata-only WHY remains.
      expect(result.payload).not.toContain("### FILE: src/grown.ts");
      expect(result.payload).not.toContain("// pad 19 aaaa");
      const why = result.rankedForDisplay.find((w) => w.path === "src/grown.ts");
      expect(why).toBeDefined();
      expect(why?.included).toBe(false);
    });

    it("a file of exactly the cap exports normally", async () => {
      root = makeTempDir();
      const exact = 'export const exact = "' + "x".repeat(250) + '";\n';
      writeRepo(root, {
        "package.json": JSON.stringify({ name: "exact", version: "1.0.0" }) + "\n",
        "src/exact.ts": exact,
      });
      // 300 bytes minus the BOM-free exact content: pad to exactly 300.
      const raw = fs.readFileSync(path.join(root, "src", "exact.ts"));
      expect(raw.length).toBeLessThanOrEqual(300);
      const padded = Buffer.concat([raw, Buffer.from("// " + "".padEnd(0), "utf8")]);
      const filler = Buffer.alloc(300 - padded.length, 0x20); // spaces
      fs.writeFileSync(
        path.join(root, "src", "exact.ts"),
        Buffer.concat([padded, filler, Buffer.from("\n", "utf8")]).subarray(0, 300),
      );
      expect(fs.statSync(path.join(root, "src", "exact.ts")).size).toBe(300);
      const app = makeCappedApp(300);
      await app.indexing.indexWorkspace(CancellationSource.never());
      const result = app.buildContext("file", { activeFile: "src/exact.ts" });
      expect(result.payload).toContain("### FILE: src/exact.ts");
    });

    it("the cap counts UTF-8 bytes, not characters (grown multibyte content)", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "package.json": JSON.stringify({ name: "utf8", version: "1.0.0" }) + "\n",
        "src/wide.ts": "export const wide = 1;\n",
        "src/narrow.ts": "export const narrow = 1;\n",
      });
      const app = makeCappedApp(300);
      await app.indexing.indexWorkspace(CancellationSource.never());
      // Grow both small indexed files WITHOUT reindexing. The wide growth is
      // 200 two-byte characters = 400 BYTES (over the 300-byte cap) but only
      // ~210 characters; the narrow growth stays under 300 bytes. A
      // character-counting bound would export wide.ts; byte counting skips it.
      const wide = "é".repeat(200);
      const narrow = "é".repeat(100);
      const wideBody = 'export const wide = "' + wide + '";\n';
      const narrowBody = 'export const narrow = "' + narrow + '";\n';
      expect(Buffer.byteLength(wideBody, "utf8")).toBeGreaterThan(300);
      expect(wideBody.length).toBeLessThan(300);
      expect(Buffer.byteLength(narrowBody, "utf8")).toBeLessThanOrEqual(300);
      fs.writeFileSync(path.join(root, "src", "wide.ts"), wideBody);
      fs.writeFileSync(path.join(root, "src", "narrow.ts"), narrowBody);
      const wideResult = app.buildContext("file", { activeFile: "src/wide.ts" });
      expect(wideResult.payload).not.toContain("### FILE: src/wide.ts");
      const narrowResult = app.buildContext("file", { activeFile: "src/narrow.ts" });
      expect(narrowResult.payload).toContain("### FILE: src/narrow.ts");
    });
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

describe("resolveProjectName containment", () => {
  let root: string;

  afterEach(() => {
    if (root) removeRepo(root);
  });

  it("linked package.json cannot supply the project name; regular package.json acts as positive control", () => {
    root = makeTempDir();
    const outside = makeTempDir();
    writeRepo(outside, {
      "package.json": JSON.stringify({ name: "hostile-pkg" }) + "\n",
    });

    const fixture = createLinkFixture(
      path.join(outside, "package.json"),
      path.join(root, "package.json"),
      "file",
    );
    try {
      // Rejection: linked package.json is ignored; falls back to directory name
      expect(resolveProjectName(root)).not.toBe("hostile-pkg");
      expect(resolveProjectName(root)).toBe(path.basename(root));
    } finally {
      fixture.cleanup();
      removeRepo(outside);
    }

    // Positive control: a regular package.json supplies the project name
    const positiveRoot = makeTempDir();
    try {
      writeRepo(positiveRoot, {
        "package.json": JSON.stringify({ name: "legit-pkg" }) + "\n",
      });
      expect(resolveProjectName(positiveRoot)).toBe("legit-pkg");
    } finally {
      removeRepo(positiveRoot);
    }
  });
});

describe("workspace root binding and identity verification", () => {
  let root: string;

  afterEach(() => {
    if (root) removeRepo(root);
  });

  it("Stage 3: moving workspace directory aside and replacing it fails closed without exporting replacement content", async () => {
    root = makeTempDir();
    writeRepo(root, {
      "package.json": JSON.stringify({ name: "root-binding-test", version: "1.0.0" }) + "\n",
      "sample.ts": "export const sample = 'ORIGINAL_MARKER_12345';\n",
    });

    const storeRoot = path.join(root, ".occ-store");
    const app = new OccApplication(root, storeRoot, DEFAULT_CONFIG);
    app.initialize();
    await app.indexing.indexWorkspace(CancellationSource.never());

    // Verify initial state: original content is present in the build payload
    const initialResult = app.buildContext("file", { activeFile: "sample.ts" });
    expect(initialResult.payload).toContain("ORIGINAL_MARKER_12345");

    // Move the workspace directory aside and put a replacement directory in its place
    const rootAside = root + "_aside";
    fs.renameSync(root, rootAside);
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(root, "sample.ts"),
      "export const sample = 'REPLACEMENT_MARKER_998877';\n",
    );

    try {
      // Re-read through the SAME OccApplication instance: root identity verification
      // detects that root has been replaced (different inode) -> fails closed
      const replacementResult = app.buildContext("file", { activeFile: "sample.ts" });
      expect(replacementResult.payload).not.toContain("REPLACEMENT_MARKER_998877");
      expect(replacementResult.payload).not.toContain("### FILE: sample.ts");

      // Confirm that an ordinary read from the original root still succeeds
      const originalApp = new OccApplication(
        rootAside,
        path.join(rootAside, ".occ-store"),
        DEFAULT_CONFIG,
      );
      originalApp.initialize();
      const originalResult = originalApp.buildContext("file", { activeFile: "sample.ts" });
      expect(originalResult.payload).toContain("ORIGINAL_MARKER_12345");
      expect(originalResult.payload).toContain("### FILE: sample.ts");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.renameSync(rootAside, root);
    }
  });
});
