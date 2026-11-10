import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

// Fault-injection seam: the fs module namespace cannot be patched at runtime,
// so writeFileSync is routed through an override slot that individual tests
// set (delegating to the real implementation when unset).
const fsState = vi.hoisted(() => ({
  writeOverride: null as null | ((file: string, data: Buffer) => void),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (
      file: Parameters<typeof actual.writeFileSync>[0],
      data: Parameters<typeof actual.writeFileSync>[1],
      options?: Parameters<typeof actual.writeFileSync>[2],
    ) => {
      if (fsState.writeOverride) {
        return fsState.writeOverride(String(file), Buffer.from(data as never));
      }
      return actual.writeFileSync(file, data, options);
    },
  };
});

import { JsonIndexStore, atomicWriteFileSync } from "./indexStore";
import { entryRelativePath, serializeManifest, STORE_SCHEMA_VERSION } from "./schema";
import type { FileEntry } from "../domain/model";
import { sha256Hex } from "../shared/ids";
import { makeTempDir, removeRepo } from "../testing/fixtures";

function fakeEntry(path: string): FileEntry {
  return {
    meta: {
      path,
      language: "typescript",
      sizeBytes: 4,
      lineCount: 1,
      contentHash: sha256Hex(path),
      isTest: false,
      parseStatus: "PARSED",
    },
    symbols: [],
    imports: [],
    exports: [],
    calls: [],
    internalRelations: [],
  };
}

describe("JsonIndexStore", () => {
  let root: string;

  afterEach(() => {
    if (root) removeRepo(root);
  });

  it("persists entries atomically and reloads them byte-identically", () => {
    root = makeTempDir();
    const store = new JsonIndexStore(root, "fp");
    store.upsertEntries([fakeEntry("a.ts"), fakeEntry("src/b.ts")]);
    expect(store.exists()).toBe(true);

    const store2 = new JsonIndexStore(root, "fp");
    const { entries } = store2.load();
    expect(entries.size).toBe(2);
    expect(entries.get("a.ts")?.meta.contentHash).toBe(sha256Hex("a.ts"));
    expect(entries.get("src/b.ts")).toBeDefined();
  });

  it("writes a byte-stable manifest with sorted keys", () => {
    root = makeTempDir();
    const store = new JsonIndexStore(root, "fp");
    store.upsertEntries([fakeEntry("z.ts"), fakeEntry("a.ts"), fakeEntry("m.ts")]);
    const raw = fs.readFileSync(path.join(root, "manifest.json"), "utf8");
    expect(raw).toBe(serializeManifest(store.manifestSnapshot()));
    const keys = Object.keys(JSON.parse(raw).files);
    expect(keys).toEqual([...keys].sort());
  });

  it("reconciles a missing/corrupt manifest by rebuilding from entries", () => {
    root = makeTempDir();
    const store = new JsonIndexStore(root, "fp");
    store.upsertEntries([fakeEntry("a.ts")]);
    fs.writeFileSync(path.join(root, "manifest.json"), "{ not json !!!");
    const store2 = new JsonIndexStore(root, "fp");
    const { manifest, entries } = store2.load();
    expect(entries.size).toBe(1);
    expect(manifest.files["a.ts"]).toBeDefined();
    // After repair, a fresh store loads cleanly with no warnings needed.
    const store3 = new JsonIndexStore(root, "fp");
    expect(store3.load().entries.size).toBe(1);
  });

  it("drops a corrupt entry file and keeps a valid index", () => {
    root = makeTempDir();
    const store = new JsonIndexStore(root, "fp");
    store.upsertEntries([fakeEntry("a.ts"), fakeEntry("b.ts")]);
    const corrupt = path.join(root, entryRelativePath("a.ts"));
    fs.writeFileSync(corrupt, "{corrupted");
    const store2 = new JsonIndexStore(root, "fp");
    const { entries } = store2.load();
    expect(entries.has("b.ts")).toBe(true);
    expect(entries.has("a.ts")).toBe(false);
  });

  // FU5: the load path only checked meta.path presence — structurally invalid
  // entries (bogus parseStatus, non-array collections, traversal/absolute
  // paths) loaded unchecked into retrieval and context building.
  describe("FU5: structural validation of loaded entries", () => {
    /** Writes a syntactically valid JSON entry that violates the schema. */
    function tamper(
      rootDir: string,
      rel: string,
      mutate: (entry: Record<string, unknown>) => void,
    ): void {
      const file = path.join(rootDir, entryRelativePath(rel));
      const entry = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      mutate(entry);
      fs.writeFileSync(file, JSON.stringify(entry));
    }

    function loadPaths(rootDir: string): string[] {
      return [...new JsonIndexStore(rootDir, "fp").load().entries.keys()].sort();
    }

    it("drops entries with an unknown parseStatus", () => {
      root = makeTempDir();
      const store = new JsonIndexStore(root, "fp");
      store.upsertEntries([fakeEntry("a.ts"), fakeEntry("b.ts")]);
      tamper(root, "a.ts", (e) => {
        (e.meta as Record<string, unknown>).parseStatus = "bogus";
      });
      expect(loadPaths(root)).toEqual(["b.ts"]);
    });

    it("drops entries with non-array collections", () => {
      root = makeTempDir();
      const store = new JsonIndexStore(root, "fp");
      store.upsertEntries([fakeEntry("a.ts"), fakeEntry("b.ts")]);
      tamper(root, "b.ts", (e) => {
        e.symbols = "not-an-array";
      });
      expect(loadPaths(root)).toEqual(["a.ts"]);
    });

    it("drops entries with traversal or absolute paths", () => {
      root = makeTempDir();
      const store = new JsonIndexStore(root, "fp");
      store.upsertEntries([fakeEntry("a.ts"), fakeEntry("b.ts")]);
      tamper(root, "a.ts", (e) => {
        (e.meta as Record<string, unknown>).path = "../outside.ts";
      });
      tamper(root, "b.ts", (e) => {
        (e.meta as Record<string, unknown>).path = "C:\\evil\\b.ts";
      });
      expect(loadPaths(root)).toEqual([]);
    });

    // Review finding (follow-up 5): shallow validation accepted entries that
    // crashed initialization later — imports:[{}] passed the array-of-objects
    // check and initialize() died on importedNames.join.
    it("drops entries with malformed nested records (imports/symbols/calls/relations)", () => {
      root = makeTempDir();
      const store = new JsonIndexStore(root, "fp");
      store.upsertEntries([fakeEntry("a.ts"), fakeEntry("b.ts"), fakeEntry("c.ts")]);
      tamper(root, "a.ts", (e) => {
        e.imports = [{}]; // missing sourceText/importedNames
      });
      tamper(root, "b.ts", (e) => {
        (e.symbols as unknown[]).push({ name: 42 }); // malformed symbol
      });
      tamper(root, "c.ts", (e) => {
        (e.calls as unknown[]).push({ calleeName: null });
      });
      expect(loadPaths(root)).toEqual([]);
    });

    it("drops missing or malformed heritage input even when the manifest is missing", () => {
      root = makeTempDir();
      const store = new JsonIndexStore(root, "fp");
      store.upsertEntries([fakeEntry("a.ts"), fakeEntry("b.ts"), fakeEntry("c.ts")]);
      tamper(root, "a.ts", (e) => {
        delete e.heritages;
      });
      tamper(root, "b.ts", (e) => {
        e.heritages = [{ kind: "extends", symbolName: "B", parents: [null], startLine: 1 }];
      });
      fs.unlinkSync(path.join(root, "manifest.json"));
      expect(loadPaths(root)).toEqual(["c.ts"]);
    });

    it("reconciles the manifest EXACTLY (equal count with wrong keys/hashes rebuilds)", () => {
      root = makeTempDir();
      const store = new JsonIndexStore(root, "fp");
      store.upsertEntries([fakeEntry("a.ts"), fakeEntry("b.ts")]);
      const manifestPath = path.join(root, "manifest.json");
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        files: Record<string, string>;
      };
      // Same count, wrong keys and wrong hash values.
      parsed.files = { "wrong/key.ts": "deadbeef", "another.ts": "0000" };
      fs.writeFileSync(manifestPath, JSON.stringify(parsed));
      const { manifest } = new JsonIndexStore(root, "fp").load();
      expect(Object.keys(manifest.files).sort()).toEqual(["a.ts", "b.ts"]);
      expect(Object.values(manifest.files).every((h) => h.length === 64)).toBe(true);
    });

    it("ignores non-canonical shard files (temp/orphan remnants)", () => {
      root = makeTempDir();
      const store = new JsonIndexStore(root, "fp");
      store.upsertEntries([fakeEntry("a.ts")]);
      const shardDir = path.join(root, "entries", entryRelativePath("a.ts").split("/")[1]);
      // A temp remnant and an entry-shaped file with a non-hash name.
      fs.writeFileSync(path.join(shardDir, "orphan.tmp"), "{}\n");
      fs.writeFileSync(path.join(shardDir, "not-a-hash.json"), "{}\n");
      expect(loadPaths(root)).toEqual(["a.ts"]);
    });

    it("atomic-write in-place fallback preserves the old destination on failure", () => {
      root = makeTempDir();
      const target = path.join(root, "entry.json");
      const OLD = '{"old":true}';
      fs.writeFileSync(target, OLD);
      // Fail the in-place write (the final fallback) once; the old content
      // must survive and no .bak/.tmp remnant may be left behind. The fs
      // module namespace cannot be patched at runtime in Node, so the fault
      // is injected through the hoisted vi.mock partial at the file top.
      fsState.writeOverride = (file) => {
        if (String(file) === target) throw new Error("simulated mid-write failure");
      };
      try {
        expect(() => atomicWriteFileSync(target, '{"new":true}')).toThrow();
      } finally {
        fsState.writeOverride = null;
      }
      expect(fs.readFileSync(target, "utf8")).toBe(OLD);
      const leftovers = fs
        .readdirSync(root)
        .filter((f) => f.includes(".bak-") || f.includes(".tmp-"));
      expect(leftovers).toEqual([]);
    });

    it("keeps valid entries with empty collections (FAILED-parse shape)", () => {
      root = makeTempDir();
      const store = new JsonIndexStore(root, "fp");
      const failed = {
        ...fakeEntry("x.ts"),
        meta: { ...fakeEntry("x.ts").meta, parseStatus: "FAILED", parseError: "boom" },
      };
      store.upsertEntries([failed]);
      expect(loadPaths(root)).toEqual(["x.ts"]);
    });
  });

  it("removes entries on removePaths", () => {
    root = makeTempDir();
    const store = new JsonIndexStore(root, "fp");
    store.upsertEntries([fakeEntry("a.ts"), fakeEntry("b.ts")]);
    store.removePaths(["a.ts"]);
    expect(fs.existsSync(path.join(root, entryRelativePath("a.ts")))).toBe(false);
    expect(new JsonIndexStore(root, "fp").load().entries.size).toBe(1);
  });

  it("clear wipes the store", () => {
    root = makeTempDir();
    const store = new JsonIndexStore(root, "fp");
    store.upsertEntries([fakeEntry("a.ts")]);
    store.clear();
    expect(store.exists()).toBe(false);
    expect(store.load().entries.size).toBe(0);
  });

  it("rejects schema drift by rebuilding", () => {
    root = makeTempDir();
    const store = new JsonIndexStore(root, "fp");
    store.upsertEntries([fakeEntry("a.ts")]);
    const manifestPath = path.join(root, "manifest.json");
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    parsed.schemaVersion = STORE_SCHEMA_VERSION + 5;
    fs.writeFileSync(manifestPath, JSON.stringify(parsed));
    const store2 = new JsonIndexStore(root, "fp");
    const { manifest, entries } = store2.load();
    expect(manifest.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(entries.size).toBe(0);
  });

  it("migrates older store versions by clearing stale entries to trigger a rebuild", () => {
    root = makeTempDir();
    const store = new JsonIndexStore(root, "fp");
    store.upsertEntries([fakeEntry("a.ts")]);
    const manifestPath = path.join(root, "manifest.json");
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    parsed.schemaVersion = 2; // older v2 store
    fs.writeFileSync(manifestPath, JSON.stringify(parsed));

    const store2 = new JsonIndexStore(root, "fp");
    const { manifest, entries } = store2.load();
    expect(manifest.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(entries.size).toBe(0);
  });

  // Stage 3 B migration: schema-v5 stores may already hold tainted FAILED
  // parseError text (raw exception messages were persisted before the safe-
  // category fix). The v6 bump must invalidate such stores wholesale.
  it("invalidates v5 stores that may contain tainted parser diagnostics", () => {
    root = makeTempDir();
    const store = new JsonIndexStore(root, "fp");
    store.upsertEntries([fakeEntry("a.ts")]);
    // Hand-taint the shard the way a pre-fix write would have.
    const shard = path.join(root, entryRelativePath("a.ts"));
    const entry = JSON.parse(fs.readFileSync(shard, "utf8")) as Record<string, unknown>;
    (entry.meta as Record<string, unknown>).parseStatus = "FAILED";
    (entry.meta as Record<string, unknown>).parseError = "parser blew up: SYNTHETIC-TOKEN123456";
    fs.writeFileSync(shard, JSON.stringify(entry));
    const manifestPath = path.join(root, "manifest.json");
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { schemaVersion: number };
    parsed.schemaVersion = 5; // pre-fix store
    fs.writeFileSync(manifestPath, JSON.stringify(parsed));

    const store2 = new JsonIndexStore(root, "fp");
    const { entries } = store2.load();
    // Wholesale rebuild: the tainted shard is gone from memory AND disk.
    expect(entries.size).toBe(0);
    expect(fs.existsSync(shard)).toBe(false);
    // Manifest + surviving shards are token-free.
    const leftovers: string[] = [];
    const walkShards = (dir: string): void => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) walkShards(full);
        else leftovers.push(fs.readFileSync(full, "utf8"));
      }
    };
    walkShards(root);
    for (const bytes of leftovers) {
      expect(bytes).not.toContain("SYNTHETIC-TOKEN123456");
    }
  });
  it("rejects a foreign project fingerprint by rebuilding the manifest (F5)", () => {
    // A manifest copied from a different workspace root must not be accepted:
    // the loaded manifest carries the constructing store's fingerprint.
    root = makeTempDir();
    const store = new JsonIndexStore(root, "fp-a");
    store.upsertEntries([fakeEntry("a.ts")]);
    const manifestPath = path.join(root, "manifest.json");
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    parsed.projectFingerprint = "fp-other-workspace";
    fs.writeFileSync(manifestPath, JSON.stringify(parsed));

    const store2 = new JsonIndexStore(root, "fp-a");
    const { manifest, entries } = store2.load();
    expect(entries.size).toBe(1); // entries stay valid
    expect(manifest.projectFingerprint).toBe("fp-a");
  });
});
