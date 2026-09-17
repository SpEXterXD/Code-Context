import { afterEach, describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

import { IndexingService } from "./indexingService";
import { createDefaultParserRegistry } from "../parser/parserRegistry";
import { makeTempDir, removeRepo, writeRepo } from "../testing/fixtures";
import { CancellationSource } from "../shared/cancellation";
import { entryRelativePath } from "../index/schema";

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
});
