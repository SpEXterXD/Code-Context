import { afterEach, describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

import { JsonIndexStore } from "./indexStore";
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
    const { manifest } = store2.load();
    expect(manifest.schemaVersion).toBe(STORE_SCHEMA_VERSION);
  });
});
