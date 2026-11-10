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
  isValidStoredFileEntry,
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
  load(repair?: boolean): { manifest: IndexManifest; entries: Map<string, FileEntry> };
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

  load(repair = true): { manifest: IndexManifest; entries: Map<string, FileEntry> } {
    const manifestPath = path.join(this.storeRoot, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const raw = fs.readFileSync(manifestPath, "utf8");
        const parsed = JSON.parse(raw) as IndexManifest;
        if (parsed.schemaVersion !== STORE_SCHEMA_VERSION) {
          logger.warn(
            `index schema ${parsed.schemaVersion} ≠ ${STORE_SCHEMA_VERSION}; rebuilding store`,
          );
          if (repair) this.clear();
          else this.manifest = emptyManifest(this.projectFingerprint);
          return { manifest: { ...this.manifest }, entries: new Map() };
        }
      } catch {
        /* unreadable manifest will be handled downstream */
      }
    }

    const entries = new Map<string, FileEntry>();
    const entriesDir = path.join(this.storeRoot, "entries");

    if (fs.existsSync(entriesDir)) {
      for (const shard of listSortedDirs(entriesDir).filter((d) => CANONICAL_SHARD_DIR.test(d))) {
        const shardDir = path.join(entriesDir, shard);
        for (const file of listSortedFiles(shardDir)) {
          const full = path.join(shardDir, file);
          try {
            const entry = JSON.parse(fs.readFileSync(full, "utf8")) as unknown;
            // FU5: fail-closed structural validation — invalid entries are
            // dropped as corrupt and the file re-indexes on the next run.
            if (!isValidStoredFileEntry(entry)) {
              throw new OccError("STORE_CORRUPT", "entry failed structural validation");
            }
            entries.set(entry.meta.path, entry);
          } catch (e) {
            // Corrupt entry: drop it and record. The index stays valid; the
            // file will be re-indexed on next run.
            logger.warn(`dropping corrupt index entry ${full}: ${(e as Error).message}`);
            if (repair) {
              try {
                fs.unlinkSync(full);
              } catch {
                /* ignore */
              }
            }
          }
        }
      }
    }

    this.manifest = repair
      ? this.loadOrRebuildManifest(entries)
      : this.rebuildManifest(entries, false);
    return { manifest: { ...this.manifest }, entries };
  }

  private loadOrRebuildManifest(entries: Map<string, FileEntry>): IndexManifest {
    const manifestPath = path.join(this.storeRoot, "manifest.json");
    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as IndexManifest;
      if (parsed.schemaVersion !== STORE_SCHEMA_VERSION) {
        logger.warn(
          `index schema ${parsed.schemaVersion} ≠ ${STORE_SCHEMA_VERSION}; rebuilding store`,
        );
        this.clear();
        entries.clear();
        return this.manifest;
      }
      // Reconcile: the entries directory is the source of truth. Any drift
      // (crash between entry and manifest writes, dropped corrupt entries,
      // schema bump, manifest copied from a different workspace root) is
      // repaired by rebuilding the manifest from entries. Review fix: the
      // mapping must match EXACTLY — equal counts with wrong keys or stale
      // content hashes still rebuild.
      if (parsed.projectFingerprint !== this.projectFingerprint) {
        logger.warn(
          `manifest fingerprint ${parsed.projectFingerprint} ≠ ${this.projectFingerprint}; rebuilding manifest`,
        );
        return this.rebuildManifest(entries);
      }
      const manifestFiles = parsed.files ?? {};
      if (manifestMatchesEntries(manifestFiles, entries)) {
        return parsed;
      }
      return this.rebuildManifest(entries);
    } catch (e) {
      if (fs.existsSync(manifestPath)) {
        logger.warn(`manifest unreadable (${(e as Error).message}); rebuilding from entries`);
      }
      return this.rebuildManifest(entries);
    }
  }

  private rebuildManifest(entries: Map<string, FileEntry>, persist = true): IndexManifest {
    const manifest = emptyManifest(this.projectFingerprint);
    for (const [p, entry] of entries) {
      manifest.files[p] = entry.meta.contentHash;
    }
    this.manifest = manifest;
    if (persist) this.writeManifest();
    return manifest;
  }

  /** Writes entries (each an atomic single-file transaction), then the manifest. */
  upsertEntries(newEntries: FileEntry[]): void {
    for (const entry of newEntries) {
      const rel = entryRelativePath(entry.meta.path);
      const full = path.join(this.storeRoot, rel);
      atomicWriteFileSync(full, JSON.stringify({ ...entry, heritages: entry.heritages ?? [] }));
      this.manifest.files[entry.meta.path] = entry.meta.contentHash;
    }
    this.writeManifest();
  }

  removePaths(paths: string[]): void {
    for (const p of paths) {
      const full = path.join(this.storeRoot, entryRelativePath(p));
      try {
        fs.unlinkSync(full);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
  // atomic). Review fix: the PREVIOUS destination is backed up first and
  // restored if the write fails — a mid-write failure can no longer destroy
  // previously valid state. Content verified via size check; no .bak/.tmp
  // remnants survive either outcome.
  let backup: string | null = null;
  try {
    if (fs.existsSync(target)) {
      backup = `${target}.bak-${process.pid}-${Math.floor(Math.random() * 1e9).toString(36)}`;
      fs.copyFileSync(target, backup);
    }
    fs.writeFileSync(target, data);
    const stat = fs.statSync(target);
    if (stat.size !== data.length) {
      throw new StoreCorruptError(`size mismatch writing ${target}`);
    }
    if (backup) {
      fs.unlinkSync(backup);
      backup = null;
    }
  } catch (e) {
    if (backup) {
      try {
        fs.copyFileSync(backup, target);
        fs.unlinkSync(backup);
      } catch {
        /* best-effort restore */
      }
    }
    throw e;
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

/**
 * Canonical shard filenames only: entries are stored as
 * `entries/<2 hex>/<64 hex sha256>.json` (see entryRelativePath). Temp
 * remnants, orphan files, or hand-placed JSON must never be read as records.
 */
const CANONICAL_ENTRY_FILE = /^[0-9a-f]{64}\.json$/;
const CANONICAL_SHARD_DIR = /^[0-9a-f]{2}$/;

function listSortedFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && CANONICAL_ENTRY_FILE.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Exact manifest reconciliation: identical key sets AND identical hashes. */
function manifestMatchesEntries(
  files: Record<string, string>,
  entries: Map<string, FileEntry>,
): boolean {
  const keys = Object.keys(files);
  if (keys.length !== entries.size) return false;
  for (const [p, hash] of Object.entries(files)) {
    const entry = entries.get(p);
    if (!entry || entry.meta.contentHash !== hash) return false;
  }
  return true;
}

export function fingerprintForRoot(rootPath: string): string {
  return sha256Hex(rootPath).slice(0, 16);
}
