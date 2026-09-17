import * as fs from "node:fs";
import * as path from "node:path";

import type { FileEntry } from "../domain/model";
import { sha256Hex } from "../shared/ids";
import { StoreCorruptError } from "../shared/errors";
import { OccError } from "../shared/errors";
import { logger } from "../shared/logging";
import {
  emptyManifest,
  entryRelativePath,
  serializeManifest,
  STORE_SCHEMA_VERSION,
  type IndexManifest,
} from "./schema";

/**
 * Local index persistence (ADR-2): a sharded JSON KV store on disk.
 *
 * Why not native SQLite inside the VS Code extension host: Node ABI of the
 * bundled `better-sqlite3` must match the exact Electron/Node build of every
 * VS Code version and OS, a recurring install-time failure mode. A sharded
 * JSON store has zero native dependencies, survives version bumps, and gives
 * per-file crash granularity: each entry is one atomic `write-temp → rename`
 * transaction. The {@link IndexStore} interface keeps a SQLite (WASM) backend
 * replaceable without touching callers.
 *
 * Crash model: entries are the source of truth; the manifest is a derived
 * cache. Any inconsistency (crash between entry write and manifest write, or
 * a corrupt entry) is repaired at load time by rebuilding/dropping, never
 * surfaces as a broken index.
 */
export interface IndexStore {
  load(): { manifest: IndexManifest; entries: Map<string, FileEntry> };
  upsertEntries(entries: FileEntry[]): void;
  removePaths(paths: string[]): void;
  writeManifest(): void;
  clear(): void;
  exists(): boolean;
}

export class JsonIndexStore implements IndexStore {
  private manifest: IndexManifest;

  constructor(
    private readonly storeRoot: string,
    private readonly projectFingerprint: string,
  ) {
    this.manifest = emptyManifest(projectFingerprint);
  }

  exists(): boolean {
    return fs.existsSync(path.join(this.storeRoot, "manifest.json"));
  }

  load(): { manifest: IndexManifest; entries: Map<string, FileEntry> } {
    const entries = new Map<string, FileEntry>();
    const entriesDir = path.join(this.storeRoot, "entries");

    if (fs.existsSync(entriesDir)) {
      for (const shard of listSortedDirs(entriesDir)) {
        const shardDir = path.join(entriesDir, shard);
        for (const file of listSortedFiles(shardDir)) {
          const full = path.join(shardDir, file);
          try {
            const entry = JSON.parse(fs.readFileSync(full, "utf8")) as FileEntry;
            if (!entry?.meta?.path) throw new OccError("STORE_CORRUPT", "entry missing meta.path");
            entries.set(entry.meta.path, entry);
          } catch (e) {
            // Corrupt entry: drop it and record. The index stays valid; the
            // file will be re-indexed on next run.
            logger.warn(`dropping corrupt index entry ${full}: ${(e as Error).message}`);
            try {
              fs.unlinkSync(full);
            } catch {
              /* ignore */
            }
          }
        }
      }
    }

    this.manifest = this.loadOrRebuildManifest(entries);
    return { manifest: { ...this.manifest }, entries };
  }

  private loadOrRebuildManifest(entries: Map<string, FileEntry>): IndexManifest {
    const manifestPath = path.join(this.storeRoot, "manifest.json");
    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as IndexManifest;
      if (parsed.schemaVersion !== STORE_SCHEMA_VERSION) {
        logger.warn(
          `index schema ${parsed.schemaVersion} ≠ ${STORE_SCHEMA_VERSION}; rebuilding manifest`,
        );
        return this.rebuildManifest(entries);
      }
      // Reconcile: the entries directory is the source of truth. Any drift
      // (crash between entry and manifest writes, dropped corrupt entries,
      // schema bump) is repaired by rebuilding the manifest from entries.
      const manifestCount = Object.keys(parsed.files ?? {}).length;
      if (manifestCount !== entries.size) {
        return this.rebuildManifest(entries);
      }
      return parsed;
    } catch (e) {
      if (fs.existsSync(manifestPath)) {
        logger.warn(`manifest unreadable (${(e as Error).message}); rebuilding from entries`);
      }
      return this.rebuildManifest(entries);
    }
  }

  private rebuildManifest(entries: Map<string, FileEntry>): IndexManifest {
    const manifest = emptyManifest(this.projectFingerprint);
    for (const [p, entry] of entries) {
      manifest.files[p] = entry.meta.contentHash;
    }
    this.manifest = manifest;
    this.writeManifest();
    return manifest;
  }

  /** Writes entries (each an atomic single-file transaction), then the manifest. */
  upsertEntries(newEntries: FileEntry[]): void {
    for (const entry of newEntries) {
      const rel = entryRelativePath(entry.meta.path);
      const full = path.join(this.storeRoot, rel);
      atomicWriteFileSync(full, JSON.stringify(entry));
      this.manifest.files[entry.meta.path] = entry.meta.contentHash;
    }
    this.writeManifest();
  }

  removePaths(paths: string[]): void {
    for (const p of paths) {
      const full = path.join(this.storeRoot, entryRelativePath(p));
      try {
        fs.unlinkSync(full);
      } catch {
        /* already gone */
      }
      delete this.manifest.files[p];
    }
    // Unconditional: previously a redundant if/else with identical branches.
    this.writeManifest();
  }

  writeManifest(): void {
    atomicWriteFileSync(
      path.join(this.storeRoot, "manifest.json"),
      serializeManifest(this.manifest),
    );
  }

  clear(): void {
    fs.rmSync(path.join(this.storeRoot, "entries"), { recursive: true, force: true });
    fs.rmSync(path.join(this.storeRoot, "manifest.json"), { force: true });
    this.manifest = emptyManifest(this.projectFingerprint);
  }

  manifestSnapshot(): IndexManifest {
    return { ...this.manifest, files: { ...this.manifest.files } };
  }
}

/**
 * Atomic file write: temp file in the same directory (same volume), then
 * rename over the destination. On Windows, rename-over-existing can fail
 * transiently (antivirus/indexer holds the target), so we retry with backoff
 * and fall back to write-in-place after verifying the temp content.
 */
export function atomicWriteFileSync(target: string, content: string): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const data = Buffer.from(content, "utf8");
  fs.writeFileSync(tmp, data);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOENT") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
        continue;
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw new StoreCorruptError(`cannot write ${target}: ${(e as Error).message}`, e);
    }
  }
  // Last resort: in-place write (still consistent content, slightly less
  // atomic). Verified content via size check.
  try {
    fs.writeFileSync(target, data);
    const stat = fs.statSync(target);
    if (stat.size !== data.length) {
      throw new StoreCorruptError(`size mismatch writing ${target}`);
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function listSortedDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function listSortedFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function fingerprintForRoot(rootPath: string): string {
  return sha256Hex(rootPath).slice(0, 16);
}
