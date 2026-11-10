import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

import { IndexingService } from "./indexingService";
import { OccApplication, DEFAULT_CONFIG } from "./contextService";
import { createDefaultParserRegistry } from "../parser/parserRegistry";
import {
  makeTempDir,
  removeRepo,
  writeRepo,
  createLinkFixture,
  type LinkFixture,
} from "../testing/fixtures";
import {
  setCustomLstatSync,
  setCustomReaddirSync,
  setCustomFstatSync,
  setCustomOpenSync,
} from "../workspace/containment";
import { CancellationSource } from "../shared/cancellation";
import { entryRelativePath, STORE_SCHEMA_VERSION } from "../index/schema";
import { JsonIndexStore, fingerprintForRoot } from "../index/indexStore";
import { SecretScanner } from "../security/secretScanner";

const registry = createDefaultParserRegistry();

function makeService(root: string): IndexingService {
  return new IndexingService(root, path.join(root, ".occ-store"), (p) => registry.resolve(p));
}

/** Reads the persisted store as comparable bytes (manifest + sorted entries). */
function storeBytes(root: string): string {
  const storeRoot = path.join(root, ".occ-store");
  const manifest = fs.readFileSync(path.join(storeRoot, "manifest.json"), "utf8");
  const entriesDir = path.join(storeRoot, "entries");
  const entryFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else entryFiles.push(full);
    }
  };
  if (fs.existsSync(entriesDir)) walk(entriesDir);
  entryFiles.sort();
  return manifest + "\n" + entryFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
}

describe("IndexingService (integration)", () => {
  let root: string;

  afterEach(() => {
    vi.restoreAllMocks();
    setCustomLstatSync(null);
    setCustomReaddirSync(null);
    setCustomFstatSync(null);
    setCustomOpenSync(null);
    if (root) removeRepo(root);
  });

  it("indexes a fresh repo and reuses unchanged files on second run", async () => {
    root = makeTempDir();
    writeRepo(root, {
      "src/a.ts": 'import { b } from "./b";\nexport const a = 1;\n',
      "src/b.ts": "export function b() { return 2; }\n",
      "README.md": "# demo\n",
    });
    const service = makeService(root);
    const run1 = await service.indexWorkspace(CancellationSource.never());
    expect(run1.reparsed).toBe(3);
    expect(run1.reused).toBe(0);
    expect(service.getEntries().size).toBe(3);

    const bytesAfterFirst = storeBytes(root);
    service.resetParseCounter();
    const run2 = await service.indexWorkspace(CancellationSource.never());
    expect(run2.reused).toBe(3);
    expect(run2.reparsed).toBe(0);
    expect(service.parsedFileCount()).toBe(0); // zero parser invocations
    expect(storeBytes(root)).toBe(bytesAfterFirst); // byte-identical state
  });

  it("survives restart with persisted state and no reparse of unchanged files", async () => {
    root = makeTempDir();
    writeRepo(root, { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" });
    const service1 = makeService(root);
    await service1.indexWorkspace(CancellationSource.never());
    const bytes = storeBytes(root);

    const service2 = makeService(root);
    service2.initialize();
    expect(service2.getEntries().size).toBe(2);
    service2.resetParseCounter();
    const run = await service2.indexWorkspace(CancellationSource.never());
    expect(run.reused).toBe(2);
    expect(service2.parsedFileCount()).toBe(0);
    expect(storeBytes(root)).toBe(bytes);
  });

  it("handles create, edit, delete and rename incrementally", async () => {
    root = makeTempDir();
    writeRepo(root, { "src/a.ts": "export const a = 1;\n" });
    const service = makeService(root);
    await service.indexWorkspace(CancellationSource.never());

    // create
    fs.writeFileSync(path.join(root, "src/c.ts"), "export const c = 3;\n");
    expect(await service.indexSingleFile("src/c.ts", CancellationSource.never())).toBe("indexed");
    expect(service.getEntries().has("src/c.ts")).toBe(true);

    // unchanged edit detection
    expect(await service.indexSingleFile("src/c.ts", CancellationSource.never())).toBe("unchanged");

    // edit
    fs.writeFileSync(path.join(root, "src/c.ts"), "export const c = 33;\n");
    expect(await service.indexSingleFile("src/c.ts", CancellationSource.never())).toBe("indexed");
    expect(service.getEntry("src/c.ts")?.meta.lineCount).toBe(1);

    // rename (no stale records under old path); the file was moved on disk first
    fs.renameSync(path.join(root, "src/c.ts"), path.join(root, "src/d.ts"));
    await service.renameFile("src/c.ts", "src/d.ts", CancellationSource.never());
    expect(service.getEntries().has("src/c.ts")).toBe(false);
    expect(service.getEntries().has("src/d.ts")).toBe(true);
    expect(service.status.fileCount).toBe(2);
    expect(fs.existsSync(path.join(root, ".occ-store", entryRelativePath("src/c.ts")))).toBe(false);

    // delete
    await service.removeFile("src/d.ts");
    expect(service.getEntries().size).toBe(1);
    expect(service.getGraph().allFiles()).toEqual(["src/a.ts"]);
  });

  it("removes stale records for files deleted from disk after full scan", async () => {
    root = makeTempDir();
    writeRepo(root, {
      "src/a.ts": "export const a = 1;\n",
      "src/gone.ts": "export const g = 1;\n",
    });
    const service = makeService(root);
    await service.indexWorkspace(CancellationSource.never());
    expect(service.getEntries().size).toBe(2);
    fs.rmSync(path.join(root, "src/gone.ts"));
    await service.indexWorkspace(CancellationSource.never());
    expect(service.getEntries().size).toBe(1);
    expect(service.getEntries().has("src/gone.ts")).toBe(false);
  });

  it("records parser failures as FAILED entries without corrupting the index", async () => {
    root = makeTempDir();
    writeRepo(root, { "src/ok.ts": "export const ok = 1;\n", "src/weird.ts": "const broken = }" });
    const service = makeService(root);
    const run = await service.indexWorkspace(CancellationSource.never());
    expect(run.reparsed).toBe(2);
    // TS parser is error-tolerant: no throw, valid state either way
    const weird = service.getEntry("src/weird.ts");
    expect(weird).toBeDefined();
    expect(service.getEntry("src/ok.ts")).toBeDefined();
    // Restart reads a valid index.
    const service2 = makeService(root);
    service2.initialize();
    expect(service2.getEntries().size).toBe(2);
  });

  it("keeps the previously committed state when cancelled mid-run", async () => {
    root = makeTempDir();
    writeRepo(root, {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/c.ts": "export const c = 3;\n",
      "src/d.ts": "export const d = 4;\n",
    });
    const service = makeService(root);
    await service.indexWorkspace(CancellationSource.never());
    const bytesBefore = storeBytes(root);

    // Edit everything, then cancel during the parse phase.
    for (const p of ["a", "b", "c", "d"]) {
      fs.writeFileSync(
        path.join(root, `src/${p}.ts`),
        `export const ${p} = 10${p === "a" ? "" : ""}${1};\n`,
      );
    }
    const source = new CancellationSource();
    source.cancel();
    const run = await service.indexWorkspace(source);
    expect(run.cancelled).toBe(true);
    // Index remains valid: a fresh service reads a non-corrupted state.
    const service2 = makeService(root);
    service2.initialize();
    expect(service2.getEntries().size).toBe(4);
    expect(service2.getEntry("src/a.ts")).toBeDefined();
    void bytesBefore;
  });

  it("serializes concurrent single-file jobs without interleaving", async () => {
    root = makeTempDir();
    writeRepo(root, { "src/a.ts": "export const a = 1;\n" });
    const service = makeService(root);
    await service.indexWorkspace(CancellationSource.never());
    fs.writeFileSync(path.join(root, "src/b.ts"), "export const b = 2;\n");
    fs.writeFileSync(path.join(root, "src/c.ts"), "export const c = 3;\n");
    const results = await Promise.all([
      service.indexSingleFile("src/b.ts", CancellationSource.never()),
      service.indexSingleFile("src/c.ts", CancellationSource.never()),
      service.indexSingleFile("src/b.ts", CancellationSource.never()),
    ]);
    expect(results.filter((r) => r === "indexed").length).toBe(2);
    expect(service.getEntries().size).toBe(3);
  });

  it("builds exact import edges for a known A→B→C chain", async () => {
    root = makeTempDir();
    writeRepo(root, {
      "src/a.ts":
        'import { cSymbol } from "./c";\nimport { bSymbol } from "./b";\nexport const a = () => cSymbol();\n',
      "src/b.ts":
        'import { cSymbol } from "./c";\nexport const b = () => cSymbol();\nexport function bSymbol() { return b(); }\n',
      "src/c.ts": "export function cSymbol() { return 3; }\n",
    });
    const service = makeService(root);
    await service.indexWorkspace(CancellationSource.never());
    const graph = service.getGraph();
    expect(graph.fileDependencies("src/a.ts").sort()).toEqual(["src/b.ts", "src/c.ts"]);
    expect(graph.fileDependencies("src/b.ts")).toEqual(["src/c.ts"]);
    expect(graph.fileDependents("src/c.ts").sort()).toEqual(["src/a.ts", "src/b.ts"]);

    // symbol-level calls: a → cSymbol (imported), b → cSymbol (local)
    const cEntry = service.getEntry("src/c.ts")!;
    const cSymbol = cEntry.symbols.find((s) => s.name === "cSymbol")!;
    const aEntry = service.getEntry("src/a.ts")!;
    const callsFromA = aEntry.internalRelations.filter(
      (r) => r.kind === "calls" && r.target === `symbol:${cSymbol.id}`,
    );
    expect(callsFromA).toHaveLength(1);
    expect(callsFromA[0]?.provenance).toBe("STATIC_EXACT");
  });

  // Stage 3 A: shared workspace containment. A linked ancestor directory
  // (junction on Windows, symlink elsewhere) points outside the root;
  // lexical checks and leaf lstat cannot see it. Discovery never follows
  // links, so direct/watch indexing, renames and live export must reject
  // any path with a link component.
  describe("Stage 3 A: linked ancestors are outside the containment policy", () => {
    it("root-level ..notes.ts is a legal name for direct indexing", async () => {
      root = makeTempDir();
      writeRepo(root, { "..notes.ts": "export const notes = 1;\n" });
      const service = makeService(root);
      expect(await service.indexSingleFile("..notes.ts", CancellationSource.never())).toBe(
        "indexed",
      );
      expect(service.getEntries().has("..notes.ts")).toBe(true);
    });

    it("a linked parent directory pointing outside is never indexed", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "src/real.ts": "export const real = 1;\n",
        "outside/cred.ts": 'export const k = "AKIA" + "QW8Z7XP6M5L4K3J2";\n',
      });
      const fixture = createLinkFixture(
        path.join(root, "outside"),
        path.join(root, "src", "link"),
        "dir",
      );
      try {
        const service = makeService(root);
        // Direct path through the linked parent: rejected (outside content).
        expect(await service.indexSingleFile("src/link/cred.ts", CancellationSource.never())).toBe(
          "ignored",
        );
        expect(service.getEntries().has("src/link/cred.ts")).toBe(false);
        // Rename destination under the linked parent: rejected.
        writeRepo(root, { "src/movable.ts": "export const m = 1;\n" });
        await service.indexSingleFile("src/movable.ts", CancellationSource.never());
        await service.renameFile("src/movable.ts", "src/link/moved.ts", CancellationSource.never());
        expect(service.getEntries().has("src/link/moved.ts")).toBe(false);
        // Containment is path-scoped: the same real path still indexes.
        expect(await service.indexSingleFile("src/movable.ts", CancellationSource.never())).toBe(
          "indexed",
        );
        expect(service.getEntries().has("src/movable.ts")).toBe(true);
        // Full scan stays link-free (the fixture itself has no links in-tree).
        await service.indexWorkspace(CancellationSource.never());
        expect(service.getEntries().has("src/link/cred.ts")).toBe(false);
      } finally {
        fixture.cleanup();
      }
    });

    it("a stale indexed file whose parent became a link is not exported", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "package.json": JSON.stringify({ name: "stale-link", version: "1.0.0" }) + "\n",
        "src/inside.ts": "export const inside = 1;\n",
      });
      const app = new OccApplication(root, path.join(root, ".occ-store"), {
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
        maxFileSizeBytes: 1024 * 1024,
      });
      await app.indexing.indexWorkspace(CancellationSource.never());
      // Replace the indexed parent directory with a link to an outside
      // directory holding same-named content with a synthetic credential.
      const secret = "AKIA" + "QW8Z7XP6M5L4K3J2";
      const outsideDir = path.join(path.dirname(root), path.basename(root) + "-outside");
      let fixture: LinkFixture | undefined;
      try {
        fs.mkdirSync(path.join(outsideDir, "src"), { recursive: true });
        fs.writeFileSync(
          path.join(outsideDir, "src", "inside.ts"),
          'export const inside = 1;\nexport const k = "' + secret + '";\n',
        );
        fs.rmSync(path.join(root, "src"), { recursive: true, force: true });
        fixture = createLinkFixture(outsideDir, path.join(root, "src"), "dir");
        const result = app.buildContext("file", { activeFile: "src/inside.ts" });
        // Revalidated immediately before the read: the stale indexed path
        // resolves through a link -> source omitted, metadata kept, marker
        // absent from the payload.
        expect(result.payload).not.toContain("### FILE: src/inside.ts");
        expect(result.payload).not.toContain(secret);
        const why = result.rankedForDisplay.find((w) => w.path === "src/inside.ts");
        expect(why).toBeDefined();
      } finally {
        fixture?.cleanup();
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("protects the full-scan parse read when a discovered file or parent is replaced before parse", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "package.json": JSON.stringify({ name: "parse-race-test", version: "1.0.0" }) + "\n",
        "src/dir/discovered.ts": "export const discovered = 1;\n",
        "src/normal.ts": "export const normal = 42;\n",
      });
      const OUTSIDE_MARKER = "OUTSIDE_PARSE_RACE_MARKER_998877";
      const outsideDir = makeTempDir();
      writeRepo(outsideDir, {
        "discovered.ts": `export const discovered = "${OUTSIDE_MARKER}";\n`,
      });

      const app = new OccApplication(root, path.join(root, ".occ-store"), {
        ...DEFAULT_CONFIG,
      });

      let linkFixture: LinkFixture | undefined;
      try {
        await app.indexing.indexWorkspace(CancellationSource.never(), (p) => {
          if (p.phase === "scan") {
            // Replace discovered directory before parse read with a link to outside
            fs.rmSync(path.join(root, "src", "dir"), { recursive: true, force: true });
            linkFixture = createLinkFixture(outsideDir, path.join(root, "src", "dir"), "dir");
          }
        });

        // 1. Resulting entry: parseStatus must be FAILED, not PARSED, and outside marker absent
        const entry = app.indexing.getEntries().get("src/dir/discovered.ts");
        expect(entry).toBeDefined();
        expect(entry?.meta.parseStatus).toBe("FAILED");
        expect(JSON.stringify(entry)).not.toContain(OUTSIDE_MARKER);

        // 2. Serialized shards: must not contain outside marker
        const storeDir = path.join(root, ".occ-store");
        const walkShards = (dir: string): string[] => {
          const files: string[] = [];
          for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, d.name);
            if (d.isDirectory()) files.push(...walkShards(full));
            else files.push(full);
          }
          return files;
        };
        for (const file of walkShards(storeDir)) {
          const text = fs.readFileSync(file, "utf8");
          expect(text).not.toContain(OUTSIDE_MARKER);
        }

        // 3. Generated payload: outside marker absent, normal file indexed and exported
        const result = app.buildContext("file", { activeFile: "src/normal.ts" });
        expect(result.payload).not.toContain(OUTSIDE_MARKER);
        expect(result.payload).toContain("### FILE: src/normal.ts");
        expect(result.payload).toContain("export const normal = 42;");
      } finally {
        linkFixture?.cleanup();
        removeRepo(outsideDir);
      }
    });

    it("linked .gitignore cannot influence direct-index eligibility (positive control respects regular .gitignore)", async () => {
      root = makeTempDir();
      const outside = makeTempDir();
      writeRepo(outside, {
        ".gitignore": "secret.ts\n",
      });
      writeRepo(root, {
        "src/dir/secret.ts": "export const secret = 1;\n",
      });

      const fixture = createLinkFixture(
        path.join(outside, ".gitignore"),
        path.join(root, "src", "dir", ".gitignore"),
        "file",
      );
      try {
        const service = makeService(root);
        // Rejection: linked .gitignore is ignored by containment; secret.ts indexes
        const outcome = await service.indexSingleFile(
          "src/dir/secret.ts",
          CancellationSource.never(),
        );
        expect(outcome).toBe("indexed");
        expect(service.getEntries().has("src/dir/secret.ts")).toBe(true);
      } finally {
        fixture.cleanup();
        removeRepo(outside);
      }

      // Positive control: regular in-workspace .gitignore DOES ignore secret.ts
      const positiveRoot = makeTempDir();
      try {
        writeRepo(positiveRoot, {
          "src/dir/.gitignore": "secret.ts\n",
          "src/dir/secret.ts": "export const secret = 1;\n",
        });
        const positiveService = makeService(positiveRoot);
        const outcome = await positiveService.indexSingleFile(
          "src/dir/secret.ts",
          CancellationSource.never(),
        );
        expect(outcome).toBe("ignored");
        expect(positiveService.getEntries().has("src/dir/secret.ts")).toBe(false);
      } finally {
        removeRepo(positiveRoot);
      }
    });
  });

  // Stage 3 B: a thrown parser error's message is UNTRUSTED — a synthetic
  // scanner-recognized token in the message must never reach the FAILED
  // shard, the manifest, or logs.
  it("Stage 3 B: thrown parser diagnostics persist as safe categories only", async () => {
    root = makeTempDir();
    writeRepo(root, {
      "src/boom.ts": "export const boom = 1;\n",
      "src/ok.ts": "export const ok = 1;\n",
    });
    const registry = createDefaultParserRegistry();
    const TOKEN = "SYNTHETIC-" + "SECRETMARKER123456";
    const service = new IndexingService(root, path.join(root, ".occ-store"), (p) => {
      if (p.replace(/\\/g, "/").endsWith("src/boom.ts")) {
        return {
          supports: () => true,
          parse: () => {
            throw new Error(`boom ${TOKEN} leaked-context`);
          },
        };
      }
      return registry.resolve(p);
    });
    await service.indexWorkspace(CancellationSource.never());
    const entry = service.getEntries().get("src/boom.ts");
    expect(entry?.meta.parseStatus).toBe("FAILED");
    expect(entry?.meta.parseError).toBeDefined();
    expect(entry!.meta.parseError!).not.toContain(TOKEN);
    // The whole serialized shard and manifest are token-free.
    const storeDir = path.join(root, ".occ-store");
    const shards: string[] = [];
    const walk = (dir: string): void => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) walk(full);
        else shards.push(full);
      }
    };
    walk(storeDir);
    for (const file of shards) {
      expect(fs.readFileSync(file, "utf8")).not.toContain(TOKEN);
    }
    // Other files still indexed; restart stays clean.
    expect(service.getEntries().has("src/ok.ts")).toBe(true);
    const restarted = new IndexingService(root, path.join(root, ".occ-store"), (p) =>
      registry.resolve(p),
    );
    restarted.initialize();
    expect(restarted.getEntries().get("src/boom.ts")?.meta.parseError).not.toContain(TOKEN);
  });
  it("marks unresolved imports explicitly as UNRESOLVED", async () => {
    root = makeTempDir();
    writeRepo(root, {
      "src/a.ts": 'import { nope } from "./nowhere";\nimport fs from "fs";\nexport const a = 1;\n',
    });
    const service = makeService(root);
    await service.indexWorkspace(CancellationSource.never());
    const entry = service.getEntry("src/a.ts")!;
    const unresolved = entry.internalRelations.find(
      (r) => r.kind === "imports" && r.provenance === "UNRESOLVED",
    );
    expect(unresolved?.target).toBe("unresolved:./nowhere");
    const external = entry.internalRelations.find(
      (r) => r.kind === "imports" && r.target === "external:fs",
    );
    expect(external?.provenance).toBe("STATIC_EXACT");
  });

  // Review finding 4: cross-file relations of IMPORTERS went stale when the
  // imported file changed (only fresh files were re-analyzed). The old
  // kind:startLine retargeting then invented STATIC_EXACT edges to whatever
  // symbol now occupies the old line, and a moved symbol silently lost its
  // callers. Dependents are now recomputed through the real analysis model,
  // so live state, a restart, and a fresh index all agree.
  describe("F03: importer relations track dependency changes", () => {
    const A = 'import { beta } from "./b";\nexport const alpha = () => beta();\n';
    const B = "export function beta() { return 2; }\n";

    function callTargets(service: IndexingService, path: string): string[] {
      return service
        .getEntry(path)!
        .internalRelations.filter((r) => r.kind === "calls")
        .map((r) => r.target)
        .sort();
    }

    it("a moved symbol keeps its callers at the NEW position across live/restart/fresh", async () => {
      root = makeTempDir();
      writeRepo(root, { "src/a.ts": A, "src/b.ts": B });
      const service = makeService(root);
      await service.indexWorkspace(CancellationSource.never());
      expect(callTargets(service, "src/a.ts")).toEqual(["symbol:src/b.ts#beta@function:1"]);

      // Move beta down one line; the watcher path re-indexes only b.ts.
      writeRepo(root, { "src/b.ts": "\nexport function beta() { return 2; }\n" });
      expect(await service.indexSingleFile("src/b.ts", CancellationSource.never())).toBe("indexed");
      expect(callTargets(service, "src/a.ts")).toEqual(["symbol:src/b.ts#beta@function:2"]);

      // Restart: the recomputed dependent was persisted, so reload agrees.
      const restarted = makeService(root);
      restarted.initialize();
      expect(callTargets(restarted, "src/a.ts")).toEqual(["symbol:src/b.ts#beta@function:2"]);

      // Fresh indexing of the same files agrees too.
      const fresh = makeService(root);
      await fresh.indexWorkspace(CancellationSource.never());
      expect(callTargets(fresh, "src/a.ts")).toEqual(["symbol:src/b.ts#beta@function:2"]);
    });

    it("a replaced symbol is never retargeted with STATIC_EXACT", async () => {
      root = makeTempDir();
      writeRepo(root, { "src/a.ts": A, "src/b.ts": B });
      const service = makeService(root);
      await service.indexWorkspace(CancellationSource.never());
      // beta replaced by gamma on the same line; a.ts unchanged.
      writeRepo(root, { "src/b.ts": "export function gamma() { return 3; }\n" });
      expect(await service.indexSingleFile("src/b.ts", CancellationSource.never())).toBe("indexed");
      // No fabricated STATIC_EXACT call to gamma: beta is simply gone.
      const relations = service.getEntry("src/a.ts")!.internalRelations;
      expect(
        relations.some(
          (r) =>
            r.kind === "calls" && r.target.includes("gamma") && r.provenance === "STATIC_EXACT",
        ),
      ).toBe(false);
      expect(callTargets(service, "src/a.ts")).toEqual([]);
      // Restart agrees (no invented edge resurrected from persisted state).
      const restarted = makeService(root);
      restarted.initialize();
      expect(callTargets(restarted, "src/a.ts")).toEqual([]);
      // A FULL re-parse of both files also produces NO gamma call: a.ts
      // still imports beta, which no longer exists — gamma is only reachable
      // if a.ts itself is rewritten to import gamma. No position guessing.
      const fresh = makeService(root);
      await fresh.indexWorkspace(CancellationSource.never());
      expect(callTargets(fresh, "src/a.ts")).toEqual([]);
      const freshRefs = fresh
        .getEntry("src/a.ts")!
        .internalRelations.filter((r) => r.kind === "references" && r.target.includes("beta"));
      expect(freshRefs.some((r) => r.provenance === "UNRESOLVED")).toBe(true);
    });

    it("never resolves STATIC_EXACT to a non-exported same-name declaration", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "src/a.ts": 'import { helper } from "./b";\nexport const use = () => helper();\n',
        // helper is NOT exported; only other is. A non-exported `helper`
        // exists in b.ts but must not be the STATIC_EXACT target.
        "src/b.ts": "function helper() { return 1; }\nexport function other() {}\n",
      });
      const service = makeService(root);
      await service.indexWorkspace(CancellationSource.never());
      const relations = service.getEntry("src/a.ts")!.internalRelations;
      const badRef = relations.find(
        (r) =>
          r.kind === "references" && r.provenance === "STATIC_EXACT" && r.target.includes("helper"),
      );
      expect(badRef).toBeUndefined();
      const unresolved = relations.find(
        (r) =>
          r.kind === "references" && r.provenance === "UNRESOLVED" && r.target.includes("helper"),
      );
      expect(unresolved).toBeDefined();
    });
  });

  describe("Stage 4: relationship parity", () => {
    const signal = CancellationSource.never();
    const child = [
      'import Base, { Parent as Alias } from "./base";',
      "export class Child extends Base implements Alias {}",
      "export interface Descendant extends Alias {}",
    ].join("\n");
    const base = "export default class Base {}\nexport interface Parent {}\n";

    function makeApp(store = ".occ-store"): OccApplication {
      return new OccApplication(root, path.join(root, store), {
        ...DEFAULT_CONFIG,
        excludePatterns: [".fresh-store"],
      });
    }

    function snapshot(app: OccApplication) {
      const { indexing } = app;
      const graph = indexing.getGraph();
      const context = app.buildContext("task", { taskText: "Child Base Parent" });
      return {
        count: indexing.status.fileCount,
        files: graph.allFiles(),
        edges: graph.nodes().flatMap((node) => graph.edgesFrom(node)),
        relations: indexing.getEntry("child.ts")?.internalRelations,
        retrieval: context.retrieval,
        indexVersion: context.payload.match(/^INDEX_VERSION: (.+)$/m)?.[1],
      };
    }

    async function expectParity(app: OccApplication): Promise<void> {
      const reopened = makeApp();
      reopened.initialize();
      const fresh = makeApp(".fresh-store");
      await fresh.indexing.indexWorkspace(signal);
      expect(snapshot(reopened)).toEqual(snapshot(app));
      expect(snapshot(fresh)).toEqual(snapshot(app));
      removeRepo(path.join(root, ".fresh-store"));
    }

    it("retains exact extends and implements targets after moving their definitions", async () => {
      root = makeTempDir();
      writeRepo(root, { "child.ts": child, "base.ts": base });
      const app = makeApp();
      await app.indexing.indexWorkspace(signal);
      writeRepo(root, { "base.ts": "\n" + base });
      await app.indexing.indexSingleFile("base.ts", signal);
      const relations = app.indexing.getEntry("child.ts")!.internalRelations;
      expect(
        relations
          .filter((r) => r.kind === "extends" || r.kind === "implements")
          .map(({ target, provenance }) => [target, provenance]),
      ).toEqual([
        ["symbol:base.ts#Base@class:2", "STATIC_EXACT"],
        ["symbol:base.ts#Parent@interface:3", "STATIC_EXACT"],
        ["symbol:base.ts#Parent@interface:3", "STATIC_EXACT"],
      ]);
      await expectParity(app);

      writeRepo(root, { "base.ts": "export default class Base {}\nexport interface Other {}\n" });
      await app.indexing.indexSingleFile("base.ts", signal);
      expect(app.indexing.getEntry("child.ts")!.internalRelations).toContainEqual(
        expect.objectContaining({
          target: "unresolved:base.ts#Parent",
          provenance: "UNRESOLVED",
          kind: "references",
        }),
      );
      expect(app.indexing.getEntry("child.ts")!.internalRelations).toContainEqual(
        expect.objectContaining({
          target: "unresolved:Alias",
          provenance: "UNRESOLVED",
          kind: "implements",
        }),
      );
      await expectParity(app);
    });

    it("persists unresolved targets after deleting a dependency and resolves them on create", async () => {
      root = makeTempDir();
      writeRepo(root, { "child.ts": child, "base.ts": base });
      const app = makeApp();
      await app.indexing.indexWorkspace(signal);
      fs.unlinkSync(path.join(root, "base.ts"));
      await app.indexing.removeFile("base.ts");
      expect(app.indexing.getGraph().fileDependencies("child.ts")).toEqual([]);
      const reopened = makeApp();
      reopened.initialize();
      expect(reopened.indexing.getGraph().fileDependencies("child.ts")).toEqual([]);
      expect(app.indexing.getGraph().edgesFrom("file:child.ts")).toContainEqual({
        source: "file:child.ts",
        target: "unresolved:./base",
        kind: "imports",
        provenance: "UNRESOLVED",
      });
      await expectParity(app);

      writeRepo(root, { "base.ts": base });
      await app.indexing.indexSingleFile("base.ts", signal);
      expect(app.indexing.getGraph().fileDependencies("child.ts")).toEqual(["base.ts"]);
      await expectParity(app);
    });

    it("resolves a missing or lower-priority import after an eligible file is created", async () => {
      root = makeTempDir();
      writeRepo(root, { "child.ts": child });
      const app = makeApp();
      await app.indexing.indexWorkspace(signal);
      expect(app.indexing.getGraph().fileDependencies("child.ts")).toEqual([]);
      await expectParity(app);

      writeRepo(root, { "base/index.ts": base });
      await app.indexing.indexSingleFile("base/index.ts", signal);
      expect(app.indexing.getGraph().fileDependencies("child.ts")).toEqual(["base/index.ts"]);
      await expectParity(app);

      writeRepo(root, { "base.ts": base });
      await app.indexing.indexSingleFile("base.ts", signal);
      expect(app.indexing.getGraph().fileDependencies("child.ts")).toEqual(["base.ts"]);
      await expectParity(app);
    });

    it("resolves a local alias when a different import uses the same exported name", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "child.ts": [
          'import { Base as Unused } from "./other";',
          'import { Parent as Base } from "./base";',
          "export interface Child extends Base {}",
        ].join("\n"),
        "other.ts": "export interface Base {}",
        "base.ts": "export interface Parent {}",
      });
      const app = makeApp();
      await app.indexing.indexWorkspace(signal);
      writeRepo(root, { "base.ts": "\nexport interface Parent {}" });
      await app.indexing.indexSingleFile("base.ts", signal);
      expect(
        app.indexing.getEntry("child.ts")!.internalRelations.filter((r) => r.kind === "extends"),
      ).toEqual([
        expect.objectContaining({
          target: "symbol:base.ts#Parent@interface:2",
          provenance: "STATIC_EXACT",
        }),
      ]);
      await expectParity(app);
    });

    it("reconciles a partial batch after a shard write fails and persists repairs on retry", async () => {
      root = makeTempDir();
      writeRepo(root, { "child.ts": child, "base.ts": base });
      const app = makeApp();
      await app.indexing.indexWorkspace(signal);
      writeRepo(root, { "base.ts": "\n" + base });

      const upsert = JsonIndexStore.prototype.upsertEntries;
      const write = vi.spyOn(JsonIndexStore.prototype, "upsertEntries");
      write.mockImplementation(function (this: JsonIndexStore, entries) {
        if (entries[0]?.meta.path === "child.ts")
          throw new Error("injected importer write failure");
        upsert.call(this, entries);
      });
      await expect(app.indexing.indexSingleFile("base.ts", signal)).rejects.toThrow(
        "injected importer write failure",
      );
      expect(app.indexing.status.state).toBe("error");
      write.mockRestore();

      // The dependency shard landed. The importer shard still has the old id.
      const shard = path.join(root, ".occ-store", entryRelativePath("child.ts"));
      expect(fs.readFileSync(shard, "utf8")).toContain("symbol:base.ts#Base@class:1");
      expect(app.indexing.getEntry("child.ts")!.internalRelations).toContainEqual(
        expect.objectContaining({
          target: "symbol:base.ts#Base@class:2",
          provenance: "STATIC_EXACT",
        }),
      );
      await expectParity(app);

      const run = await app.indexing.indexWorkspace(signal);
      expect(run.reparsed).toBe(0);
      expect(app.indexing.status.state).toBe("ready");
      expect(fs.readFileSync(shard, "utf8")).toContain("symbol:base.ts#Base@class:2");
      await expectParity(app);
    });

    it("publishes rename once after a yielded commit and sequences a queued delete", async () => {
      root = makeTempDir();
      const importers = Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [`importer${i}.ts`, child]),
      );
      writeRepo(root, {
        ...importers,
        "child.ts": child.replace("./base", "./moved"),
        "base.ts": base,
        "queued.ts": "export const queued = 1;",
      });
      const app = makeApp();
      const { indexing } = app;
      await indexing.indexWorkspace(signal);
      const before = snapshot(app);
      const publications: Array<{ upserted: string[]; removed: string[]; count: number }> = [];
      indexing.onEntriesChanged(({ upserted, removed }) => {
        publications.push({
          upserted: upserted.map((entry) => entry.meta.path),
          removed,
          count: indexing.status.fileCount,
        });
      });

      const cancel = new CancellationSource();
      const upsert = JsonIndexStore.prototype.upsertEntries;
      let observed: ReturnType<typeof snapshot> | undefined;
      let writes = 0;
      const write = vi.spyOn(JsonIndexStore.prototype, "upsertEntries");
      write.mockImplementation(function (this: JsonIndexStore, entries) {
        upsert.call(this, entries);
        if (++writes === 64) {
          setTimeout(() => {
            observed = snapshot(app);
            cancel.cancel();
          }, 0);
        }
      });
      fs.renameSync(path.join(root, "base.ts"), path.join(root, "moved.ts"));
      fs.unlinkSync(path.join(root, "queued.ts"));
      const rename = indexing.renameFile("base.ts", "moved.ts", cancel);
      const queued = indexing.removeFile("queued.ts");
      await Promise.all([rename, queued]);
      write.mockRestore();
      expect(observed).toEqual(before);
      expect(cancel.isCancellationRequested).toBe(true);
      expect(publications).toHaveLength(2);
      expect(publications[0]).toEqual({
        upserted: expect.arrayContaining(["child.ts", "importer0.ts", "moved.ts"]),
        removed: ["base.ts"],
        count: before.count,
      });
      expect(publications[1]).toEqual({
        upserted: [],
        removed: ["queued.ts"],
        count: before.count - 1,
      });
      expect(indexing.getGraph().fileDependencies("child.ts")).toEqual(["moved.ts"]);
      expect(indexing.getGraph().fileDependencies("importer0.ts")).toEqual([]);
      await expectParity(app);
    });

    it("removes an ineligible rename destination and recomputes the old importers", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "child.ts": child,
        "base.ts": base,
        "other.ts": "export const original = true;",
      });
      const app = makeApp();
      await app.indexing.indexWorkspace(signal);
      fs.unlinkSync(path.join(root, "other.ts"));
      fs.renameSync(path.join(root, "base.ts"), path.join(root, "other.ts"));
      fs.writeFileSync(path.join(root, "other.ts"), Buffer.from([0, 0, 0]));
      await app.indexing.renameFile("base.ts", "other.ts", signal);
      expect(app.indexing.status.fileCount).toBe(1);
      expect(app.indexing.getGraph().fileDependencies("child.ts")).toEqual([]);
      await expectParity(app);
    });

    it("preserves the committed index when rebuild is cancelled just before its first write", async () => {
      root = makeTempDir();
      writeRepo(root, { "child.ts": child, "base.ts": base });
      const app = makeApp();
      await app.indexing.indexWorkspace(signal);
      const before = snapshot(app);
      const bytes = storeBytes(root);
      fs.unlinkSync(path.join(root, "base.ts"));
      writeRepo(root, { "new.ts": "export const newFile = 1;" });
      const cancel = new CancellationSource();
      const changed = vi.fn();
      app.indexing.onEntriesChanged(changed);
      const run = await app.indexing.rebuild(cancel, ({ phase }) => {
        if (phase === "commit") cancel.cancel();
      });
      expect(run.cancelled).toBe(true);
      expect(changed).not.toHaveBeenCalled();
      expect(snapshot(app)).toEqual(before);
      expect(storeBytes(root)).toBe(bytes);
      const reopened = makeApp();
      reopened.initialize();
      expect(snapshot(reopened)).toEqual(before);

      await app.indexing.rebuild(signal);
      await expectParity(app);
    });

    it("rebuilds v6 shards from source and persists only sanitized heritage input", async () => {
      root = makeTempDir();
      const flagged = "AK" + "IA" + "Z9K8J7H6G5F4D3S2";
      writeRepo(root, {
        "base.ts": base,
        "child.ts": [
          child,
          `class ${flagged} extends Base {}`,
          `class SuspiciousParent extends ${flagged} {}`,
        ].join("\n"),
      });
      const app = makeApp();
      await app.indexing.indexWorkspace(signal);
      expect(storeBytes(root)).not.toContain(flagged);
      expect(
        app.indexing.getEntry("child.ts")?.heritages?.map((clause) => clause.symbolName),
      ).toEqual(["Child", "Child", "Descendant"]);
      const manifestFile = path.join(root, ".occ-store", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      manifest.schemaVersion = 6;
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      for (const file of ["base.ts", "child.ts"]) {
        const shard = path.join(root, ".occ-store", entryRelativePath(file));
        const legacy = JSON.parse(fs.readFileSync(shard, "utf8"));
        delete legacy.heritages;
        fs.writeFileSync(shard, JSON.stringify(legacy));
      }
      const migrated = makeApp();
      migrated.initialize();
      expect(migrated.indexing.status.fileCount).toBe(0);
      const result = await migrated.indexing.indexWorkspace(signal);
      expect(result.reparsed).toBe(2);
      expect(JSON.parse(fs.readFileSync(manifestFile, "utf8")).schemaVersion).toBe(
        STORE_SCHEMA_VERSION,
      );
      expect(storeBytes(root)).not.toContain(flagged);
      await expectParity(migrated);
    });
  });

  it.each(["direct update", "full incremental scan"])(
    "Stage 4: %s resolves edits and fallback changes in excluded alias configs",
    async (mode) => {
      root = makeTempDir();
      const aliases = (dir: string) =>
        JSON.stringify({
          compilerOptions: { paths: { "@lib/*": [`${dir}/*`] } },
        });
      writeRepo(root, {
        "alias-user.ts": 'import { foo } from "@lib/foo";\nexport const use = () => foo();',
        "left/foo.ts": "export function foo() { return 1; }",
        "right/foo.ts": "export function foo() { return 2; }",
        "tsconfig.json": aliases("left"),
        "jsconfig.json": aliases("left"),
      });
      const makeIndex = (store = ".occ-store") =>
        new IndexingService(root, path.join(root, store), (p) => registry.resolve(p), {
          excludePatterns: ["tsconfig.json", "jsconfig.json", ".fresh-store"],
        });
      const signal = CancellationSource.never();
      const service = makeIndex();
      await service.indexWorkspace(signal);

      function expectTarget(index: IndexingService, target: string) {
        expect(index.status.fileCount).toBe(3);
        expect(index.getGraph().allFiles()).toEqual([
          "alias-user.ts",
          "left/foo.ts",
          "right/foo.ts",
        ]);
        expect(index.getGraph().fileDependencies("alias-user.ts")).toEqual([target]);
        expect(index.getGraph().edgesFrom("file:alias-user.ts")).toContainEqual({
          source: "file:alias-user.ts",
          kind: "imports",
          target: `file:${target}`,
          provenance: "STATIC_EXACT",
        });
        expect(
          index.getEntry("alias-user.ts")?.internalRelations.filter((r) => r.kind === "calls"),
        ).toEqual([
          expect.objectContaining({
            target: `symbol:${target}#foo@function:1`,
            provenance: "STATIC_EXACT",
          }),
        ]);
      }

      async function expectParity(target: string) {
        expectTarget(service, target);
        const persisted = new JsonIndexStore(
          path.join(root, ".occ-store"),
          fingerprintForRoot(root),
        ).load().entries;
        expect(persisted.get("alias-user.ts")?.internalRelations).toEqual(
          service.getEntry("alias-user.ts")?.internalRelations,
        );
        const reopened = makeIndex();
        reopened.initialize();
        expectTarget(reopened, target);
        const fresh = makeIndex(".fresh-store");
        await fresh.indexWorkspace(signal);
        expectTarget(fresh, target);
        removeRepo(path.join(root, ".fresh-store"));
      }

      async function refresh(config: string) {
        service.resetParseCounter();
        if (mode === "direct update") {
          expect(await service.indexSingleFile(config, signal)).toBe("ignored");
        } else {
          const run = await service.indexWorkspace(signal);
          expect(run.reused).toBe(3);
          expect(run.reparsed).toBe(0);
        }
        expect(service.parsedFileCount()).toBe(0);
      }

      expectTarget(service, "left/foo.ts");
      writeRepo(root, { "tsconfig.json": aliases("right") });
      if (mode === "full incremental scan") {
        const bytes = storeBytes(root);
        const cancellation = new CancellationSource();
        const run = await service.indexWorkspace(cancellation, ({ phase }) => {
          if (phase === "commit") cancellation.cancel();
        });
        expect(run.cancelled).toBe(true);
        expectTarget(service, "left/foo.ts");
        expect(storeBytes(root)).toBe(bytes);
      }
      await refresh("tsconfig.json");
      await expectParity("right/foo.ts");

      fs.unlinkSync(path.join(root, "tsconfig.json"));
      await refresh("tsconfig.json");
      await expectParity("left/foo.ts");

      writeRepo(root, { "jsconfig.json": aliases("right") });
      await refresh("jsconfig.json");
      await expectParity("right/foo.ts");

      writeRepo(root, { "tsconfig.json": aliases("left") });
      await refresh("tsconfig.json");
      await expectParity("left/foo.ts");

      const bytes = storeBytes(root);
      const publish = vi.fn();
      service.onEntriesChanged(publish);
      // A shadowed configuration has no effect while tsconfig.json takes precedence.
      writeRepo(root, {
        "jsconfig.json": aliases("left"),
        "tsconfig.json": "// Same effective mapping\n" + aliases("left"),
      });
      await refresh("jsconfig.json");
      await refresh("tsconfig.json");
      expect(publish).not.toHaveBeenCalled();
      expect(storeBytes(root)).toBe(bytes);
    },
  );

  it("detects the naming-convention test relationship", async () => {
    root = makeTempDir();
    writeRepo(root, {
      "src/auth.service.ts": "export class AuthService {}\n",
      "src/auth.service.test.ts":
        'import { AuthService } from "./auth.service";\nexport const t = AuthService;\n',
    });
    const service = makeService(root);
    await service.indexWorkspace(CancellationSource.never());
    const testEntry = service.getEntry("src/auth.service.test.ts")!;
    const testsEdge = testEntry.internalRelations.find((r) => r.kind === "tests");
    expect(testsEdge?.target).toBe("file:src/auth.service.ts");
    expect(testsEdge?.provenance).toBe("STATIC_HEURISTIC");
  });

  it("ignores excluded files completely (never silent, inspectable)", async () => {
    root = makeTempDir();
    writeRepo(root, {
      "src/a.ts": "export const a = 1;\n",
      ".env": "SHOULD_NOT_BE_INDEXED=yes\n",
      "secrets.pem": "not indexed\n",
    });
    const service = makeService(root);
    const run = await service.indexWorkspace(CancellationSource.never());
    expect(run.scan.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(service.getEntries().size).toBe(1);
  });

  describe("secret token filtering (v3 store)", () => {
    // Generate fixture secrets at runtime via fragment concatenation
    function createSecretFixtures(): Array<{ family: string; secret: string; key?: string }> {
      return [
        { family: "aws-access-key", secret: "AK" + "IA" + "IOSFODNN7EXAMPLE" },
        { family: "private-key-block", secret: "-----" + "BEGIN RSA PRIVATE " + "KEY-----" },
        { family: "github-token", secret: "gh" + "p_" + "0123456789abcdefghijklmnopqrstuvwxyzAB" },
        { family: "slack-token", secret: "xo" + "xb-123456789012-" + "abcdef" },
        { family: "google-api-key", secret: "AI" + "zaSyD-1a2b3c4d5e6f7g8h9i0jK_" + "lmnopqrstuv" },
        { family: "stripe-live-key", secret: "sk_" + "live_" + "a1b2c3d4e5f6g7h8" },
        { family: "openai-style-key", secret: "sk-" + "proj-a1b2c3d4e5f6g7h8i9j0" },
        {
          family: "jwt",
          secret:
            "ey" +
            "JhbGciOiJIUzI1NiIsInR5cCI6eyJ9." +
            "eyJzdWIiOiIxIn0." +
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        },
        {
          family: "basic-auth-url",
          secret: "postgres" + "://admin:" + "S3cr3tValue" + "@db.internal:5432/app",
        },
        { family: "bearer-token", secret: "Bearer " + "abc123def456ghi789jkl012" },
        {
          family: "generic-credential",
          key: "api_" + "key",
          secret: "J8s2kLq" + "9zX1pQw7vR3mNtYu5",
        },
        { family: "env-credential", key: "AUTH_" + "TOKEN", secret: "mK9vP2x" + "L5nQ8wR1tY3" },
      ];
    }

    function buildSecretRepoFiles(
      fixtures: ReturnType<typeof createSecretFixtures>,
    ): Record<string, string> {
      // 1. String literals
      const stringLit = [
        'export const dummy = "test";',
        ...fixtures.map((f) =>
          f.key
            ? `export const ${f.key} = "${f.secret}";`
            : `export const lit_${f.family.replace(/-/g, "_")} = "${f.secret}";`,
        ),
      ].join("\n");

      // 2. Comments (inline + JSDoc docblock)
      const comments = [
        "/**",
        " * File leading comment.",
        ...fixtures.map((f) =>
          f.key ? ` * JSDoc: ${f.key} = "${f.secret}"` : ` * JSDoc: ${f.secret}`,
        ),
        " */",
        'export const dummyComment = "test";',
        ...fixtures.map((f) => (f.key ? `// ${f.key} = "${f.secret}"` : `// Comment: ${f.secret}`)),
      ].join("\n");

      // 3. Object properties
      const objProps = [
        "export const cfg = {",
        ...fixtures.map(
          (f) => `  ${f.key ?? `prop_${f.family.replace(/-/g, "_")}`}: "${f.secret}",`,
        ),
        "};",
      ].join("\n");

      // 4. Template strings
      const templateStrings = [
        'export const dummyTpl = "test";',
        ...fixtures.map((f) =>
          f.key
            ? `export const tpl_${f.family.replace(/-/g, "_")} = \`${f.key} = "${f.secret}"\`;`
            : `export const tpl_${f.family.replace(/-/g, "_")} = \`prefix "${f.secret}" suffix\`;`,
        ),
      ].join("\n");

      // 5. JSON values
      const jsonValues: Record<string, string> = {};
      for (const f of fixtures) jsonValues[f.key ?? `sec_${f.family}`] = f.secret;

      // 6. Markdown code block
      const mdGuide = [
        "# Guide",
        "",
        "```typescript",
        ...fixtures.map((f) =>
          f.key ? `const ${f.key} = "${f.secret}";` : `const sec = "${f.secret}";`,
        ),
        "```",
        "",
      ].join("\n");

      return {
        "src/stringLiterals.ts": stringLit,
        "src/comments.ts": comments,
        "src/objectProperties.ts": objProps,
        "src/templateStrings.ts": templateStrings,
        "data/secrets.json": JSON.stringify(jsonValues, null, 2),
        "docs/guide.md": mdGuide,
      };
    }

    it("filters secret tokens across all pattern families and positions (whole-store clean)", async () => {
      root = makeTempDir();
      const fixtures = createSecretFixtures();
      writeRepo(root, buildSecretRepoFiles(fixtures));

      const service = makeService(root);
      const run = await service.indexWorkspace(CancellationSource.never());
      expect(run.totalFiles).toBe(6);

      const scanner = new SecretScanner();
      const storeRoot = path.join(root, ".occ-store");
      const entriesDir = path.join(storeRoot, "entries");

      // 1. Whole-store scan: scan every JSON file in the store
      const walkShards = (dir: string): string[] => {
        const files: string[] = [];
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, d.name);
          if (d.isDirectory()) files.push(...walkShards(full));
          else files.push(full);
        }
        return files;
      };

      const shardFiles = walkShards(entriesDir);
      expect(shardFiles.length).toBe(6);

      for (const shard of shardFiles) {
        const content = fs.readFileSync(shard, "utf8");
        const entry = JSON.parse(content);

        // Check identifiers
        const idText = (entry.identifiers ?? []).join("\n");
        const idFindings = scanner.scan(`${entry.meta.path}#identifiers`, idText);
        expect(idFindings).toHaveLength(0);

        // Check bodyTokens
        const bodyText = (entry.bodyTokens ?? []).map((t: { term: string }) => t.term).join("\n");
        const bodyFindings = scanner.scan(`${entry.meta.path}#bodyTokens`, bodyText);
        expect(bodyFindings).toHaveLength(0);

        // Check summary
        const summaryText = entry.fileSummary ?? "";
        const sumFindings = scanner.scan(`${entry.meta.path}#summary`, summaryText);
        expect(sumFindings).toHaveLength(0);

        // Check signatures & docComments
        for (const s of entry.symbols ?? []) {
          if (s.docComment) {
            expect(scanner.scan(`${entry.meta.path}#docComment`, s.docComment)).toHaveLength(0);
          }
          if (s.signature) {
            expect(scanner.scan(`${entry.meta.path}#signature`, s.signature)).toHaveLength(0);
          }
        }
      }

      // 2. In-memory entries verification: assert no fixture secret survived in tokens
      for (const entry of service.getEntries().values()) {
        const idSet = new Set(entry.identifiers ?? []);
        const bodyTerms = new Set((entry.bodyTokens ?? []).map((t) => t.term));
        for (const f of fixtures) {
          expect(idSet.has(f.secret)).toBe(false);
          expect(bodyTerms.has(f.secret.toLowerCase())).toBe(false);
          if (entry.fileSummary) {
            expect(entry.fileSummary.includes(f.secret)).toBe(false);
          }
        }
      }
    });

    it("produces byte-identical store builds across repeated runs", async () => {
      root = makeTempDir();
      const fixtures = createSecretFixtures();
      writeRepo(root, buildSecretRepoFiles(fixtures));

      const service1 = makeService(root);
      await service1.indexWorkspace(CancellationSource.never());
      const bytes1 = storeBytes(root);

      // Rebuild in place
      await service1.rebuild(CancellationSource.never());
      const bytes2 = storeBytes(root);
      expect(bytes2).toBe(bytes1);
    });

    it("incremental reindex is idempotent when secret tokens are filtered", async () => {
      root = makeTempDir();
      const fixtures = createSecretFixtures();
      writeRepo(root, buildSecretRepoFiles(fixtures));

      const service = makeService(root);
      const run1 = await service.indexWorkspace(CancellationSource.never());
      expect(run1.reparsed).toBe(6);
      expect(run1.reused).toBe(0);

      const bytes1 = storeBytes(root);
      service.resetParseCounter();

      const run2 = await service.indexWorkspace(CancellationSource.never());
      expect(run2.reparsed).toBe(0);
      expect(run2.reused).toBe(6);

      const bytes2 = storeBytes(root);
      expect(bytes2).toBe(bytes1);
    });
  });
  describe("F01: detected credentials never persist in metadata", () => {
    // Fake tokens assembled from fragments so this test file is not itself
    // a secret-shaped fixture.
    const NL = "\n";
    const Q = '"';
    const SK = "sk_" + "live_" + "QW8Z7XP6M5L4K3J2ABCDEF";
    const AWS = "AKIA" + "QW8Z7XP6M5L4K3J2";
    const FIXTURE: Record<string, string> = {
      "README.md": "# " + SK + NL + "summary " + SK + NL,
      "config.json": '{ "' + SK + '": "safe value" }' + NL,
      "module.ts":
        "export const " +
        SK.replace(/-/g, "_") +
        " = 1;" +
        NL +
        "import { x } from " +
        Q +
        "./other" +
        Q +
        ";" +
        NL +
        "/** doc " +
        SK +
        " */" +
        NL +
        "export function f(sig" +
        SK.replace(/[^A-Za-z0-9]/g, "") +
        ": number) { " +
        SK.replace(/-/g, "_") +
        "(1); }" +
        NL,
      "other.ts": "export const helper = 1;" + NL,
      "key.md":
        "-----BEGIN RSA PRIVATE KEY-----" + NL + SK + NL + "-----END RSA PRIVATE KEY-----" + NL,
    };

    function expectNoCredentialMaterial(bytes: string): void {
      expect(bytes).not.toContain(SK);
      expect(bytes).not.toContain(AWS);
      expect(bytes).not.toContain("BEGIN RSA PRIVATE KEY");
    }

    it("blanked structural names/exports/imports never reach serialized shards", async () => {
      root = makeTempDir();
      writeRepo(root, FIXTURE);
      const service = makeService(root);
      await service.indexWorkspace(CancellationSource.never());
      expectNoCredentialMaterial(storeBytes(root));
      // analysis survives: sanitized entries still exist and reference each other
      const entries = [...service.getEntries().values()];
      expect(entries.length).toBe(Object.keys(FIXTURE).length);
      const mod = entries.find((e) => e.meta.path === "module.ts")!;
      expect(mod.symbols.length).toBeGreaterThan(0);
      for (const s of mod.symbols) {
        expect(s.id).toBe("module.ts#" + s.name + "@" + s.kind + ":" + s.startLine);
      }
    });

    it("is deterministic and applies under every secret policy", async () => {
      root = makeTempDir();
      writeRepo(root, FIXTURE);
      const service = makeService(root);
      await service.indexWorkspace(CancellationSource.never());
      const first = storeBytes(root);
      expectNoCredentialMaterial(first);
      // Re-run: deterministic serialization of the same inputs.
      const service2 = makeService(root);
      await service2.indexWorkspace(CancellationSource.never());
      expect(storeBytes(root)).toBe(first);
    });

    // Review finding 2: the FU4 aliasedNames bindings were copied through
    // sanitization untouched — a safe exported name bound to a
    // credential-shaped LOCAL alias (or imported under a flagged name)
    // persisted the raw token in the shard, reopening F01.
    it("sanitizes aliased import bindings in memory and in serialized shards", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "src/b.ts": "export const util = 1;" + NL,
        // First import: safe alias (survives). Second: the AWS-shaped local
        // identifier alias (fully flagged → pair dropped). Call sites use both.
        "src/a.ts":
          'import { util as u } from "./b";' +
          NL +
          "import { util as " +
          AWS +
          ' } from "./b";' +
          NL +
          "export const go = (): number => u() + " +
          AWS +
          "();" +
          NL,
      });
      const service = makeService(root);
      await service.indexWorkspace(CancellationSource.never());
      const imports = service.getEntries().get("src/a.ts")!.imports;
      expect(JSON.stringify(imports)).not.toContain(AWS);
      expectNoCredentialMaterial(storeBytes(root));
      // The safe binding stays resolvable: local alias → imported name.
      const safe = imports.find((i) => i.aliasedNames !== undefined);
      expect(safe?.aliasedNames).toEqual([{ local: "u", imported: "util" }]);
      // The flagged pair is dropped entirely; its import keeps no alias map.
      const flagged = imports.find((i) => i.aliasedNames === undefined);
      expect(flagged).toBeDefined();
    });

    it("restart reloads sanitized bindings (schema migration clears v4 stores)", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "src/b.ts": "export const util = 1;" + NL,
        "src/a.ts":
          "import { util as " +
          AWS +
          ' } from "./b";' +
          NL +
          "export const go = () => " +
          AWS +
          "();" +
          NL,
      });
      const service = makeService(root);
      await service.indexWorkspace(CancellationSource.never());
      const restarted = makeService(root);
      restarted.initialize();
      const imp = restarted.getEntries().get("src/a.ts")!.imports[0];
      expect(JSON.stringify(imp)).not.toContain(AWS);
      expectNoCredentialMaterial(storeBytes(root));
    });
  });
  describe("F07: nested ignore rules are directory-scoped and shared", () => {
    const NL = "\n";
    function nestedFixture(): Record<string, string> {
      return {
        "a/.gitignore": "hidden.ts" + NL,
        "a/hidden.ts": "export const hidden = 1;" + NL,
        "a/visible.ts": "export const visible = 1;" + NL,
        "b/hidden.ts": "export const sibling = 1;" + NL,
      };
    }

    it("full scan and direct updates agree on sibling isolation", async () => {
      root = makeTempDir();
      writeRepo(root, nestedFixture());
      const service = makeService(root);
      await service.indexWorkspace(CancellationSource.never());
      const paths = [...service.getEntries().keys()].sort();
      expect(paths).toContain("a/.gitignore");
      expect(paths).toContain("a/visible.ts");
      expect(paths).toContain("b/hidden.ts"); // sibling NOT excluded by a/.gitignore
      expect(paths).not.toContain("a/hidden.ts"); // scoped pattern applies

      // direct update agrees with the full scan
      fs.writeFileSync(path.join(root, "a/hidden.ts"), "export const hidden = 2;" + NL);
      expect(await service.indexSingleFile("a/hidden.ts", CancellationSource.never())).toBe(
        "ignored",
      );
      expect(service.getEntries().has("a/hidden.ts")).toBe(false);
    });

    it("ignore-file edits take effect on the next direct update", async () => {
      root = makeTempDir();
      writeRepo(root, { "a/visible.ts": "export const v = 1;" + NL });
      const service = makeService(root);
      await service.indexSingleFile("a/visible.ts", CancellationSource.never());
      expect(service.getEntries().has("a/visible.ts")).toBe(true);
      fs.writeFileSync(path.join(root, "a/.gitignore"), "visible.ts" + NL);
      fs.writeFileSync(path.join(root, "a/visible.ts"), "export const v = 2;" + NL);
      expect(await service.indexSingleFile("a/visible.ts", CancellationSource.never())).toBe(
        "ignored",
      );
      expect(service.getEntries().has("a/visible.ts")).toBe(false);
    });
  });

  describe("F06: direct updates share scan eligibility", () => {
    const NL = "\n";
    function smallLimitService(root2: string): IndexingService {
      return new IndexingService(
        root2,
        path.join(root2, ".occ-store"),
        (p2) => registry.resolve(p2),
        {
          maxFileSizeBytes: 100,
        },
      );
    }

    it("skips oversized and binary files the direct path previously indexed", async () => {
      root = makeTempDir();
      const service = smallLimitService(root);
      fs.writeFileSync(
        path.join(root, "large.ts"),
        "/** " + "x".repeat(200) + " */" + NL + "export const big = 1;" + NL,
      );
      fs.writeFileSync(
        path.join(root, "binary.dat"),
        Buffer.from([0x4f, 0x63, 0x74, 0x00, 0x01, 0x02]),
      );
      // The direct path previously indexed BOTH despite the shared limits.
      expect(await service.indexSingleFile("large.ts", CancellationSource.never())).toBe("ignored");
      expect(await service.indexSingleFile("binary.dat", CancellationSource.never())).toBe(
        "ignored",
      );
      expect(service.getEntries().size).toBe(0);
    });

    // Review finding (F07 parity): Git cannot re-include a file below an
    // EXCLUDED parent directory. Traversal prunes `ignored/` and never
    // reaches `!ignored/keep.ts`; direct indexing must agree.
    it("direct paths respect git parent-directory exclusion (no negation escape)", async () => {
      root = makeTempDir();
      writeRepo(root, {
        ".gitignore": "ignored/\n!ignored/keep.ts\n",
        "ignored/keep.ts": "export const keep = 1;\n",
        "src/ok.ts": "export const ok = 1;\n",
      });
      const service = makeService(root);
      expect(await service.indexSingleFile("ignored/keep.ts", CancellationSource.never())).toBe(
        "ignored",
      );
      expect(service.getEntries().has("ignored/keep.ts")).toBe(false);
      // A full scan agrees.
      const run = await service.indexWorkspace(CancellationSource.never());
      expect(run.scan.files.some((f) => f.path === "ignored/keep.ts")).toBe(false);
    });

    // Review finding (F06): rename destinations bypassed the shared
    // eligibility rules — with a 100-byte limit, renaming a tracked file to a
    // 523-byte destination indexed the oversized file and desynced
    // status.fileCount from the entries map.
    it("rename destinations go through the shared eligibility rules", async () => {
      root = makeTempDir();
      writeRepo(root, { "src/old.ts": "export const old = 1;\n" });
      const service = new IndexingService(
        root,
        path.join(root, ".occ-store"),
        (p) => registry.resolve(p),
        { maxFileSizeBytes: 100 },
      );
      await service.indexWorkspace(CancellationSource.never());
      expect(service.getEntries().size).toBe(1);

      fs.writeFileSync(path.join(root, "src", "big.ts"), "x".repeat(523) + "\n");
      await service.renameFile("src/old.ts", "src/big.ts", CancellationSource.never());
      // The oversized destination is NOT indexed; the old path is removed.
      expect(service.getEntries().has("src/big.ts")).toBe(false);
      expect(service.getEntries().has("src/old.ts")).toBe(false);
      expect(service.getEntries().size).toBe(0);
      expect(service.status.fileCount).toBe(0);

      // A real rename: the destination exists on disk (the watcher fires
      // after the filesystem already moved the file).
      writeRepo(root, { "src/old2.ts": "export const old2 = 1;\n" });
      fs.renameSync(path.join(root, "src", "old2.ts"), path.join(root, "src", "renamed.ts"));
      await service.indexWorkspace(CancellationSource.never());
      await service.renameFile("src/old2.ts", "src/renamed.ts", CancellationSource.never());
      expect(service.getEntries().has("src/renamed.ts")).toBe(true);
      expect(service.getEntries().has("src/old2.ts")).toBe(false);
      expect(service.status.fileCount).toBe(service.getEntries().size);
    });

    it("a legal name beginning with two dots is not treated as traversal", async () => {
      root = makeTempDir();
      writeRepo(root, { "src/..notes.ts": "export const notes = 1;\n" });
      const service = makeService(root);
      expect(await service.indexSingleFile("src/..notes.ts", CancellationSource.never())).toBe(
        "indexed",
      );
      expect(service.getEntries().has("src/..notes.ts")).toBe(true);
    });

    it("direct eligibility does not follow symlinks (traversal parity)", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "src/real.ts": "export const real = 1;\n",
        "outside/target.ts": "export const target = 1;\n",
      });
      const fixture = createLinkFixture(
        path.join(root, "outside", "target.ts"),
        path.join(root, "src", "link.ts"),
        "file",
      );
      try {
        const service = makeService(root);
        // Traversal never indexes the symlink...
        await service.indexWorkspace(CancellationSource.never());
        expect(service.getEntries().has("src/link.ts")).toBe(false);
        // ...and the direct path agrees instead of following it.
        expect(await service.indexSingleFile("src/link.ts", CancellationSource.never())).toBe(
          "ignored",
        );
        expect(service.getEntries().has("src/link.ts")).toBe(false);
      } finally {
        fixture.cleanup();
      }
    });

    it("outside-root paths are ignored without touching entries", async () => {
      root = makeTempDir();
      const service = makeService(root);
      const outside = path.join(path.dirname(root), "outside.ts");
      fs.writeFileSync(outside, "export const o = 1;\n");
      try {
        expect(await service.indexSingleFile(outside, CancellationSource.never())).toBe("ignored");
        expect(service.getEntries().size).toBe(0);
      } finally {
        fs.rmSync(outside, { force: true });
      }
    });
  });

  // FU4: aliased imports (`import { util as u }`) recorded only the original
  // name, while call sites record the LOCAL alias — so findImportedDefinition
  // never matched and CALL edges through aliases fell back to heuristic
  // provenance instead of the import's STATIC_EXACT resolution.
  it("FU4: calls through aliased imports keep STATIC_EXACT provenance", async () => {
    root = makeTempDir();
    writeRepo(root, {
      "src/b.ts": "export function util() { return 2; }\n",
      "src/a.ts": 'import { util as u } from "./b";\nexport const go = () => u();\n',
    });
    const service = makeService(root);
    await service.indexWorkspace(CancellationSource.never());
    const rels = service.getEntries().get("src/a.ts")!.internalRelations;
    const call = rels.find((r) => r.kind === "calls");
    expect(call).toBeDefined();
    expect(call!.provenance).toBe("STATIC_EXACT");
    expect(call!.target).toContain("src/b.ts");
  });

  // FU1: the parse loop ran fully synchronously — no await anywhere — so on
  // large workspaces the extension host was blocked for seconds and progress
  // UI, watcher events and cancellation signals could not fire mid-index.
  it("FU1: the parse loop yields to the host event loop during long batches", async () => {
    root = makeTempDir();
    const files: Record<string, string> = {};
    for (let i = 0; i < 100; i++) files[`src/f${i}.ts`] = `export const v${i} = ${i};\n`;
    writeRepo(root, files);
    const service = makeService(root);
    // A macrotask queued BEFORE indexing starts must run while indexing is in
    // flight. On the original implementation the whole loop executed inside
    // one synchronous macrotask, so this flag was still false afterwards.
    let macrotaskRan = false;
    setTimeout(() => (macrotaskRan = true), 0);
    await service.indexWorkspace(CancellationSource.never());
    expect(macrotaskRan).toBe(true);
  });

  // F14: parser diagnostics were dropped before persistence — meta was built
  // with a hard-coded PARSED status and `parsed.parseError` (partial-analysis
  // diagnostics from the parsers) never reached the persisted FileMeta.
  describe("F14: parser outcomes map into file metadata", () => {
    it("lenient JSON fallback records PARTIAL status with the diagnostic and persists it", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "config/settings.json": '{\n  // deployment toggle\n  "a": 1,\n}\n',
      });
      const service = makeService(root);
      await service.indexWorkspace(CancellationSource.never());
      const entry = service.getEntries().get("config/settings.json");
      expect(entry).toBeDefined();
      expect(entry!.meta.parseStatus).toBe("PARTIAL");
      expect(entry!.meta.parseError).toContain("leniently");
      // partial analysis retained, not discarded
      expect(entry!.symbols.length).toBeGreaterThan(0);
      // the diagnostic survives persistence, not just memory
      const raw = storeBytes(root);
      expect(raw).toContain('"PARTIAL"');
      expect(raw).toContain("leniently");
    });

    it("TypeScript syntax errors record PARTIAL with recovered symbols", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "src/broken.ts": "export const ok = 1;\nexport function broken( { return 2;\n",
      });
      const service = makeService(root);
      await service.indexWorkspace(CancellationSource.never());
      const entry = service.getEntries().get("src/broken.ts");
      expect(entry).toBeDefined();
      expect(entry!.meta.parseStatus).toBe("PARTIAL");
      expect(entry!.meta.parseError).toBeDefined();
      expect(entry!.meta.parseError!.length).toBeGreaterThan(0);
      // useful partial analysis is retained alongside the diagnostic
      expect(entry!.symbols.some((s) => s.name === "ok")).toBe(true);
    });

    it("clean files keep PARSED with no diagnostic", async () => {
      root = makeTempDir();
      writeRepo(root, { "src/clean.ts": "export const clean = 1;\n" });
      const service = makeService(root);
      await service.indexWorkspace(CancellationSource.never());
      const entry = service.getEntries().get("src/clean.ts");
      expect(entry!.meta.parseStatus).toBe("PARSED");
      expect(entry!.meta.parseError).toBeUndefined();
    });

    // Review fix: the generic metadata-only fallback was labeled PARSED.
    // Explicit outcome semantics: successful parse → PARSED, generic
    // fallback → GENERIC, diagnostics → PARTIAL, thrown → FAILED.
    it("labels generic-fallback files GENERIC, not PARSED", async () => {
      root = makeTempDir();
      writeRepo(root, { "data.xyz": "some arbitrary payload\n" });
      const service = makeService(root);
      await service.indexWorkspace(CancellationSource.never());
      const entry = service.getEntries().get("data.xyz");
      expect(entry).toBeDefined();
      expect(entry!.meta.language).toBe("generic");
      expect(entry!.meta.parseStatus).toBe("GENERIC");
    });

    it("the single-file path maps the outcome the same way", async () => {
      root = makeTempDir();
      writeRepo(root, { "config/late.json": '{ "a": 1,, }\n' });
      const service = makeService(root);
      expect(await service.indexSingleFile("config/late.json", CancellationSource.never())).toBe(
        "indexed",
      );
      const entry = service.getEntries().get("config/late.json");
      expect(entry).toBeDefined();
      expect(entry!.meta.parseStatus).toBe("PARTIAL");
      expect(entry!.meta.parseError).toBeDefined();
    });
  });

  describe("Stage 3 corrections: metadata containment, scan status, and retryability", () => {
    it("uses original root binding for every direct-index metadata read and never opens replacement .gitignore", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "src/app.ts": "export const app = 1;\n",
        ".gitignore": "ignored-root.ts\n",
        "nested/.gitignore": "ignored-nested.ts\n",
        "ignored-root.ts": "export const a = 1;\n",
        "nested/ignored-nested.ts": "export const b = 1;\n",
        "nested/ok.ts": "export const c = 1;\n",
      });
      const service = makeService(root);

      // Positive control: ordinary in-root ignore rules still apply for root and nested .gitignore
      expect(await service.indexSingleFile("ignored-root.ts", CancellationSource.never())).toBe(
        "ignored",
      );
      expect(
        await service.indexSingleFile("nested/ignored-nested.ts", CancellationSource.never()),
      ).toBe("ignored");
      expect(await service.indexSingleFile("nested/ok.ts", CancellationSource.never())).toBe(
        "indexed",
      );

      // Move root aside and create a replacement directory at the original path
      const aside = root + "-aside";
      fs.renameSync(root, aside);
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/app.ts"), "export const app = 999;\n");
      fs.writeFileSync(path.join(root, ".gitignore"), "src/app.ts\n# REPLACEMENT\n");

      let replacementIgnoreOpened = false;
      setCustomOpenSync((p, flags, mode) => {
        const norm = String(p).replace(/\\/g, "/");
        if (norm.endsWith(".gitignore")) {
          try {
            const content = fs.readFileSync(p, "utf8");
            if (content.includes("# REPLACEMENT")) {
              replacementIgnoreOpened = true;
            }
          } catch {
            // ignore
          }
        }
        return fs.openSync(p, flags, mode);
      });

      try {
        // Direct indexing on the replaced root: must NOT open the replacement .gitignore
        await service.indexSingleFile("src/app.ts", CancellationSource.never());
        expect(replacementIgnoreOpened).toBe(false);
      } finally {
        setCustomOpenSync(null);
        removeRepo(root);
        fs.renameSync(aside, root);
      }
    });

    it("distinguishes rejected or incomplete scan from successfully scanned empty workspace", async () => {
      root = makeTempDir();
      const storeDir = makeTempDir();
      writeRepo(root, {
        "src/sample.ts": 'export const sample = "original";\n',
      });
      const app = new OccApplication(root, storeDir, DEFAULT_CONFIG);
      await app.indexing.indexWorkspace(CancellationSource.never());
      expect(app.indexing.status.fileCount).toBe(1);
      expect(app.indexing.getEntries().has("src/sample.ts")).toBe(true);
      const shardPath = path.join(storeDir, entryRelativePath("src/sample.ts"));
      expect(fs.existsSync(shardPath)).toBe(true);

      // Move workspace directory aside and place replacement directory with marker
      const aside = root + "-aside";
      fs.renameSync(root, aside);
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "src/sample.ts"),
        'export const sample = "REPLACEMENT_MARKER";\n',
      );

      try {
        // indexWorkspace on rejected root: rejects explicitly, does not wipe entries
        await expect(app.indexing.indexWorkspace(CancellationSource.never())).rejects.toThrow();

        // Preserves last committed index and shards
        expect(app.indexing.status.state).toBe("error");
        expect(app.indexing.status.fileCount).toBe(1);
        expect(app.indexing.getEntries().has("src/sample.ts")).toBe(true);
        expect(fs.existsSync(shardPath)).toBe(true);

        // Live export continues to withhold source from the invalid root
        const exported = app.buildContext("file", { activeFile: "src/sample.ts" });
        expect(exported.payload).not.toContain("REPLACEMENT_MARKER");
      } finally {
        removeRepo(root);
        removeRepo(storeDir);
        fs.renameSync(aside, root);
      }

      // Positive control: genuinely empty, successfully scanned workspace
      const emptyRoot = makeTempDir();
      const emptyStore = makeTempDir();
      try {
        const emptyApp = new OccApplication(emptyRoot, emptyStore, DEFAULT_CONFIG);
        const emptyRun = await emptyApp.indexing.indexWorkspace(CancellationSource.never());
        expect(emptyRun.totalFiles).toBe(0);
        expect(emptyRun.reparsed).toBe(0);
        expect(emptyRun.removed).toBe(0);
        expect(emptyApp.indexing.status.state).toBe("ready");
        expect(emptyApp.indexing.status.fileCount).toBe(0);
      } finally {
        removeRepo(emptyRoot);
        removeRepo(emptyStore);
      }
    });

    it("makes transient containment and read failures retryable without reusing FAILED entry", async () => {
      root = makeTempDir();
      writeRepo(root, {
        "src/flakyBatch.ts": 'export const flakyBatch = "hello";\n',
        "src/flakyDirect.ts": 'export const flakyDirect = "world";\n',
        "src/ok.ts": "export const ok = 1;\n",
      });
      const service = makeService(root);

      let failParseContainment = false;
      const realLstatSync = fs.lstatSync;
      setCustomLstatSync((p, opts) => {
        const norm = String(p).replace(/\\/g, "/");
        if (
          failParseContainment &&
          (norm.endsWith("src/flakyBatch.ts") || norm.endsWith("src/flakyDirect.ts"))
        ) {
          const err = new Error("ENOENT: simulated transient containment failure");
          (err as NodeJS.ErrnoException).code = "ENOENT";
          throw err;
        }
        return realLstatSync(p, opts);
      });

      // 1. Initial scan: discovery succeeds with failParseContainment false,
      // but parse phase experiences transient containment failure triggered by progress hook.
      const run1 = await service.indexWorkspace(CancellationSource.never(), (p) => {
        if (p.phase === "parse") {
          failParseContainment = true;
        }
      });
      expect(run1.totalFiles).toBe(3);
      const batchEntry = service.getEntries().get("src/flakyBatch.ts");
      expect(batchEntry?.meta.parseStatus).toBe("FAILED");
      expect(batchEntry?.meta.parseError).toContain("containment check failed");
      expect(batchEntry?.meta.contentHash).toBeDefined();

      const directEntry = service.getEntries().get("src/flakyDirect.ts");
      expect(directEntry?.meta.parseStatus).toBe("FAILED");

      // 2. Full indexing retry: files are unchanged on disk, transient failure is cleared.
      failParseContainment = false;
      const run2 = await service.indexWorkspace(CancellationSource.never());
      // The unchanged-file shortcut must NOT be satisfied for transient failures.
      expect(run2.reparsed).toBe(2);
      const recoveredBatch = service.getEntries().get("src/flakyBatch.ts");
      expect(recoveredBatch?.meta.parseStatus).toBe("PARSED");
      expect(recoveredBatch?.meta.parseError).toBeUndefined();

      // 3. Direct indexing retry:
      // Transiently fail direct file again
      const failedDirectEntry = {
        ...directEntry!,
        meta: {
          ...directEntry!.meta,
          parseStatus: "FAILED" as const,
          parseError: "containment check failed: CONTAINMENT_VIOLATION",
        },
      };
      await service["commitEntries"]([failedDirectEntry], ["src/flakyDirect.ts"]);
      service["entries"].set("src/flakyDirect.ts", failedDirectEntry);
      expect(service.getEntries().get("src/flakyDirect.ts")?.meta.parseStatus).toBe("FAILED");

      // Direct index call with unchanged bytes: must NOT return "unchanged", must re-parse and succeed
      const directResult = await service.indexSingleFile(
        "src/flakyDirect.ts",
        CancellationSource.never(),
      );
      expect(directResult).toBe("indexed"); // NOT "unchanged"
      expect(service.getEntries().get("src/flakyDirect.ts")?.meta.parseStatus).toBe("PARSED");

      // 4. Retry after restart when failed record is persisted in store:
      const persistedFailed = {
        ...recoveredBatch!,
        meta: {
          ...recoveredBatch!.meta,
          parseStatus: "FAILED" as const,
          parseError: "containment check failed: CONTAINMENT_VIOLATION",
        },
      };
      await service["commitEntries"]([persistedFailed], ["src/flakyBatch.ts"]);
      const restarted = makeService(root);
      restarted.initialize();
      expect(restarted.getEntries().get("src/flakyBatch.ts")?.meta.parseStatus).toBe("FAILED");

      const runRestart = await restarted.indexWorkspace(CancellationSource.never());
      expect(runRestart.reparsed).toBe(1);
      expect(restarted.getEntries().get("src/flakyBatch.ts")?.meta.parseStatus).toBe("PARSED");
    });

    it("flat workspace: root replacement immediately after directory enumeration propagates SCAN_INCOMPLETE and preserves existing entry and shard", async () => {
      root = makeTempDir();
      const storeDir = makeTempDir();
      // Flat workspace: files directly in the root directory, no subdirectories
      writeRepo(root, {
        "flat.ts": 'export const flat = "original";\n',
      });
      const app = new OccApplication(root, storeDir, DEFAULT_CONFIG);
      await app.indexing.indexWorkspace(CancellationSource.never());
      expect(app.indexing.status.fileCount).toBe(1);
      expect(app.indexing.getEntries().has("flat.ts")).toBe(true);
      const shardPath = path.join(storeDir, entryRelativePath("flat.ts"));
      expect(fs.existsSync(shardPath)).toBe(true);

      // ReaddirSync hook: immediately after the root directory is enumerated,
      // replace the root directory aside and create a new directory at the same path.
      let replacedDuringScan = false;
      let aside = "";
      const realReaddirSync = fs.readdirSync;
      setCustomReaddirSync((dirPath, opts) => {
        const dirents = realReaddirSync(dirPath, opts);
        if (!replacedDuringScan && path.resolve(String(dirPath)) === path.resolve(root)) {
          replacedDuringScan = true;
          aside = root + "-aside";
          fs.renameSync(root, aside);
          fs.mkdirSync(root, { recursive: true });
          fs.writeFileSync(
            path.join(root, "flat.ts"),
            'export const flat = "REPLACEMENT_MARKER";\n',
          );
        }
        return dirents;
      });

      try {
        // Incremental index: root enumerated, but file read detects replaced root
        await expect(app.indexing.indexWorkspace(CancellationSource.never())).rejects.toThrow(
          expect.objectContaining({ code: "SCAN_INCOMPLETE" }),
        );

        // Verify that the existing entry and shard survive
        expect(app.indexing.status.state).toBe("error");
        expect(app.indexing.status.fileCount).toBe(1);
        expect(app.indexing.getEntries().has("flat.ts")).toBe(true);
        expect(fs.existsSync(shardPath)).toBe(true);

        // Live export continues to withhold source from the replacement directory
        const exported = app.buildContext("file", { activeFile: "flat.ts" });
        expect(exported.payload).not.toContain("REPLACEMENT_MARKER");
      } finally {
        setCustomReaddirSync(null);
        removeRepo(root);
        removeRepo(storeDir);
        if (aside && fs.existsSync(aside)) {
          removeRepo(aside);
        }
      }
    });

    it("interrupted rebuild preserves prior entries, retrieval state, and persisted shards", async () => {
      root = makeTempDir();
      const storeDir = makeTempDir();
      writeRepo(root, {
        "src/a.ts": "export const alpha = 100;\n",
        "src/b.ts": 'import { alpha } from "./a";\nexport const beta = alpha + 1;\n',
      });
      const app = new OccApplication(root, storeDir, DEFAULT_CONFIG);
      await app.indexing.indexWorkspace(CancellationSource.never());
      expect(app.indexing.status.fileCount).toBe(2);
      expect(app.indexing.getEntries().has("src/a.ts")).toBe(true);
      expect(app.indexing.getEntries().has("src/b.ts")).toBe(true);
      const shardA = path.join(storeDir, entryRelativePath("src/a.ts"));
      const shardB = path.join(storeDir, entryRelativePath("src/b.ts"));
      expect(fs.existsSync(shardA)).toBe(true);
      expect(fs.existsSync(shardB)).toBe(true);

      // Verify initial retrieval state
      const initialRetrieval = app.retriever.retrieve("alpha", { limit: 10 });
      expect(initialRetrieval.ranked.map((r) => r.path)).toContain("src/a.ts");
      expect(app.retriever.searchSymbols("alpha").map((s) => s.path)).toContain("src/a.ts");

      // Replace root during rebuild discovery (after rebuild's initial check)
      let replacedDuringDiscovery = false;
      let aside = "";
      const realReaddirSync = fs.readdirSync;
      setCustomReaddirSync((dirPath, opts) => {
        const dirents = realReaddirSync(dirPath, opts);
        if (!replacedDuringDiscovery && String(dirPath).replace(/\\/g, "/").includes("src")) {
          replacedDuringDiscovery = true;
          aside = root + "-aside";
          fs.renameSync(root, aside);
          fs.mkdirSync(root, { recursive: true });
        }
        return dirents;
      });

      try {
        await expect(app.indexing.rebuild(CancellationSource.never())).rejects.toThrow(
          expect.objectContaining({ code: "SCAN_INCOMPLETE" }),
        );

        // Prior entries must be preserved
        expect(app.indexing.status.state).toBe("error");
        expect(app.indexing.status.fileCount).toBe(2);
        expect(app.indexing.getEntries().has("src/a.ts")).toBe(true);
        expect(app.indexing.getEntries().has("src/b.ts")).toBe(true);

        // Persisted shards must be preserved
        expect(fs.existsSync(shardA)).toBe(true);
        expect(fs.existsSync(shardB)).toBe(true);

        // Retrieval state must be preserved
        const afterRetrieval = app.retriever.retrieve("alpha", { limit: 10 });
        expect(afterRetrieval.ranked.map((r) => r.path)).toContain("src/a.ts");
        expect(app.retriever.searchSymbols("alpha").map((s) => s.path)).toContain("src/a.ts");
      } finally {
        setCustomReaddirSync(null);
        removeRepo(root);
        removeRepo(storeDir);
        if (aside && fs.existsSync(aside)) {
          removeRepo(aside);
        }
      }

      // Positive control: successful rebuild on valid root
      const validRoot = makeTempDir();
      const validStore = makeTempDir();
      try {
        writeRepo(validRoot, {
          "src/valid.ts": "export const valid = 1;\n",
        });
        const validApp = new OccApplication(validRoot, validStore, DEFAULT_CONFIG);
        await validApp.indexing.indexWorkspace(CancellationSource.never());
        expect(validApp.indexing.status.fileCount).toBe(1);

        const rebuildResult = await validApp.indexing.rebuild(CancellationSource.never());
        expect(rebuildResult.totalFiles).toBe(1);
        expect(rebuildResult.reparsed).toBe(1);
        expect(validApp.indexing.status.state).toBe("ready");
        expect(validApp.indexing.status.fileCount).toBe(1);
        expect(validApp.indexing.getEntries().has("src/valid.ts")).toBe(true);
      } finally {
        removeRepo(validRoot);
        removeRepo(validStore);
      }

      // Positive control: genuinely empty workspace rebuild
      const emptyRoot = makeTempDir();
      const emptyStore = makeTempDir();
      try {
        const emptyApp = new OccApplication(emptyRoot, emptyStore, DEFAULT_CONFIG);
        const emptyRebuild = await emptyApp.indexing.rebuild(CancellationSource.never());
        expect(emptyRebuild.totalFiles).toBe(0);
        expect(emptyRebuild.reparsed).toBe(0);
        expect(emptyApp.indexing.status.state).toBe("ready");
        expect(emptyApp.indexing.status.fileCount).toBe(0);
      } finally {
        removeRepo(emptyRoot);
        removeRepo(emptyStore);
      }
    });
  });
});
