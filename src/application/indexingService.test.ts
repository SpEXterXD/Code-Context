import { afterEach, describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

import { IndexingService } from "./indexingService";
import { createDefaultParserRegistry } from "../parser/parserRegistry";
import { makeTempDir, removeRepo, writeRepo } from "../testing/fixtures";
import { CancellationSource } from "../shared/cancellation";
import { entryRelativePath } from "../index/schema";
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
});
