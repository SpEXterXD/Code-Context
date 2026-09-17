import * as fs from "node:fs";
import * as path from "node:path";

import type { FileEntry, FileMeta } from "../domain/model";
import { RelationshipGraph } from "../domain/graph";
import {
  WorkspaceScanner,
  buildIgnoreRules,
  countLines,
  type ScanResult,
} from "../workspace/workspaceScanner";
import { Sha256FileHasher, type FileHasher } from "../workspace/fileHasher";
import { detectLanguage, isTestFile } from "../workspace/languageDetection";
import type { ParsedFile, SourceParser } from "../parser/parser";
import { AnalysisEngine } from "../analysis/analysisEngine";
import { JsonIndexStore, fingerprintForRoot, type IndexStore } from "../index/indexStore";
import { toPosixPath } from "../shared/ids";
import { logger } from "../shared/logging";
import type { CancellationSignal } from "../shared/cancellation";
import { checkCancelled } from "../shared/cancellation";
import { CancelledError } from "../shared/errors";
import { OccError } from "../shared/errors";
import type { IndexingOptions } from "./indexingOptions";

export interface IndexProgress {
  phase: "scan" | "parse" | "commit" | "done" | "cancelled";
  processed: number;
  total: number;
  currentPath?: string;
  reparsed: number;
  reused: number;
}

export interface IndexRunResult {
  totalFiles: number;
  reparsed: number;
  reused: number;
  removed: number;
  scan: ScanResult;
  durationMs: number;
  cancelled: boolean;
}

export interface IndexStatus {
  state: "empty" | "ready" | "indexing" | "error";
  fileCount: number;
  lastResult?: IndexRunResult;
  lastError?: string;
}

/**
 * Application service orchestrating the indexing pipeline:
 * scan → diff by content hash → parse only changed files → resolve
 * relationships → persist atomically → update the in-memory graph.
 *
 * Guarantees (all covered by tests):
 * - unchanged content hash ⇒ reuse previous analysis, zero re-parses
 * - each file entry is one atomic persistence transaction; a crash or
 *   cancellation mid-run leaves the previously committed state valid
 * - all mutations serialize through an internal queue; concurrent triggers
 *   (watcher events + commands) never interleave half-updates
 */
export class IndexingService {
  private readonly store: IndexStore;
  private readonly graph = new RelationshipGraph();
  private readonly entries = new Map<string, FileEntry>();
  private readonly parserFor: (path: string) => SourceParser;
  private readonly hasher: FileHasher = new Sha256FileHasher();
  private readonly options: IndexingOptions;
  private readonly rootPath: string;

  private queue: Promise<unknown> = Promise.resolve();
  private _status: IndexStatus = { state: "empty", fileCount: 0 };
  private readonly statusListeners: Array<(s: IndexStatus) => void> = [];
  private readonly entryListeners: Array<
    (changes: { upserted: FileEntry[]; removed: string[] }) => void
  > = [];
  private parseCounter = 0;

  constructor(
    rootPath: string,
    storeRoot: string,
    parserFor: (path: string) => SourceParser,
    options: IndexingOptions = {},
    storeOverride?: IndexStore,
  ) {
    this.rootPath = rootPath;
    this.store = storeOverride ?? new JsonIndexStore(storeRoot, fingerprintForRoot(rootPath));
    this.parserFor = parserFor;
    this.options = { ...options };
    // Never index our own store: if it lives inside the workspace root,
    // exclude it explicitly (inspection list shows the exclusion).
    const relStore = toPosixPath(path.relative(rootPath, storeRoot));
    if (relStore && !relStore.startsWith("..")) {
      this.options.excludePatterns = [...(this.options.excludePatterns ?? []), relStore];
    }
  }

  get status(): IndexStatus {
    return this._status;
  }

  onStatusChange(listener: (s: IndexStatus) => void): void {
    this.statusListeners.push(listener);
  }

  /** Fired after every committed change batch (watcher increments rely on this). */
  onEntriesChanged(
    listener: (changes: { upserted: FileEntry[]; removed: string[] }) => void,
  ): void {
    this.entryListeners.push(listener);
  }

  /** Loads persisted state into memory; safe to call repeatedly. */
  initialize(): void {
    const { entries } = this.store.load();
    this.entries.clear();
    this.graph.clear();
    for (const p of [...entries.keys()].sort()) {
      const entry = entries.get(p);
      if (entry) {
        this.entries.set(p, entry);
        this.graph.upsertEntry(entry);
      }
    }
    this.setStatus({
      state: this.entries.size > 0 ? "ready" : "empty",
      fileCount: this.entries.size,
    });
  }

  /** Full incremental pass: scan, diff by hash, re-parse only changed files. */
  async indexWorkspace(
    cancellation: CancellationSignal,
    progress?: (p: IndexProgress) => void,
  ): Promise<IndexRunResult> {
    return this.enqueue(() => this.runIncremental(cancellation, progress, false));
  }

  /** Drops all local state and re-indexes from scratch. */
  async rebuild(
    cancellation: CancellationSignal,
    progress?: (p: IndexProgress) => void,
  ): Promise<IndexRunResult> {
    return this.enqueue(() => {
      this.store.clear();
      this.entries.clear();
      this.graph.clear();
      return this.runIncremental(cancellation, progress, true);
    });
  }

  /** Incrementally re-indexes one file ("unchanged" when hash matches). */
  async indexSingleFile(
    relativePath: string,
    cancellation: CancellationSignal,
  ): Promise<"indexed" | "unchanged" | "removed" | "ignored"> {
    return this.enqueue(async () => {
      const rel = toPosixPath(
        path.relative(this.rootPath, path.resolve(this.rootPath, relativePath)),
      );
      if (this.isIgnored(rel)) {
        this.removeEntry(rel);
        return "ignored";
      }
      const absolute = path.join(this.rootPath, rel);
      let content: string;
      try {
        content = fs.readFileSync(absolute, "utf8");
      } catch {
        this.removeEntry(rel);
        return "removed";
      }
      const hash = this.hasher.hash(content);
      const existing = this.entries.get(rel);
      if (existing && existing.meta.contentHash === hash) return "unchanged";
      const entry = this.analyzeFile(rel, content, cancellation);
      if (!entry) return "ignored";
      this.commitEntries([entry]);
      return "indexed";
    });
  }

  /** Removes a file's records (watcher delete / rename source). */
  async removeFile(relativePath: string): Promise<void> {
    return this.enqueue(async () => {
      this.removeEntry(toPosixPath(relativePath));
    });
  }

  /** Rename = remove old path + index new path, atomically sequenced. */
  async renameFile(
    oldRelativePath: string,
    newRelativePath: string,
    cancellation: CancellationSignal,
  ): Promise<void> {
    return this.enqueue(async () => {
      const oldRel = toPosixPath(oldRelativePath);
      const newRel = toPosixPath(newRelativePath);
      this.removeEntry(oldRel);
      if (this.isIgnored(newRel)) return;
      try {
        const content = fs.readFileSync(path.join(this.rootPath, newRel), "utf8");
        const entry = this.analyzeFile(newRel, content, cancellation);
        if (entry) this.commitEntries([entry]);
      } catch {
        /* new path unreadable: nothing to add */
      }
    });
  }

  async clearIndex(): Promise<void> {
    return this.enqueue(async () => {
      this.store.clear();
      this.entries.clear();
      this.graph.clear();
      this.setStatus({ state: "empty", fileCount: 0 });
    });
  }

  getGraph(): RelationshipGraph {
    return this.graph;
  }

  getEntries(): Map<string, FileEntry> {
    return this.entries;
  }

  getEntry(p: string): FileEntry | undefined {
    return this.entries.get(p);
  }

  /** Test instrumentation: number of parser invocations since construction/reset. */
  parsedFileCount(): number {
    return this.parseCounter;
  }

  resetParseCounter(): void {
    this.parseCounter = 0;
  }

  private isIgnored(rel: string): boolean {
    return buildIgnoreRules(this.rootPath, this.options).isIgnored(rel, false);
  }

  private enqueue<T>(job: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(() => job());
    this.queue = run.catch((e: unknown) => {
      logger.error(`indexing job failed: ${(e as Error)?.message ?? String(e)}`);
      return undefined;
    });
    return run;
  }

  private async runIncremental(
    cancellation: CancellationSignal,
    progress: ((p: IndexProgress) => void) | undefined,
    force: boolean,
  ): Promise<IndexRunResult> {
    const started = Date.now();
    this.setStatus({ state: "indexing", fileCount: this.entries.size });
    try {
      const scanner = new WorkspaceScanner(this.options);
      const scan = scanner.scan(this.rootPath, cancellation);
      progress?.({ phase: "scan", processed: 0, total: scan.files.length, reparsed: 0, reused: 0 });

      let reused = 0;
      const toParse: typeof scan.files = [];
      for (const file of scan.files) {
        const existing = this.entries.get(file.path);
        if (
          !force &&
          file.status === "OK" &&
          existing &&
          existing.meta.contentHash === file.contentHash
        ) {
          reused++;
          continue;
        }
        if (file.status !== "OK") {
          if (existing) this.removeEntry(file.path); // binary/oversized: no stale records
          continue;
        }
        toParse.push(file);
      }

      // Parse phase (pure): read + parse every changed file.
      const fresh: Array<{ meta: FileMeta; parsed: ParsedFile }> = [];
      let processed = 0;
      const analysis = new AnalysisEngine(
        this.rootPath,
        new Set(scan.files.map((f) => f.path)),
        this.entries,
      );
      for (const file of toParse) {
        checkCancelled(cancellation, 8, processed);
        progress?.({
          phase: "parse",
          processed,
          total: toParse.length,
          currentPath: file.path,
          reparsed: fresh.length,
          reused,
        });
        try {
          const content = fs.readFileSync(file.absolutePath, "utf8");
          const meta: FileMeta = {
            path: file.path,
            language: detectLanguage(file.path),
            sizeBytes: file.sizeBytes,
            lineCount: countLines(content),
            contentHash: file.contentHash,
            isTest: file.isTest,
            parseStatus: "PARSED",
          };
          fresh.push({ meta, parsed: this.parserFor(file.path).parse(file.path, content) });
          this.parseCounter++;
        } catch (e) {
          logger.warn(`parse failed for ${file.path}: ${(e as Error).message}`);
          fresh.push({
            meta: {
              path: file.path,
              language: detectLanguage(file.path),
              sizeBytes: file.sizeBytes,
              lineCount: 0,
              contentHash: file.contentHash,
              isTest: file.isTest,
              parseStatus: "FAILED",
              parseError: (e as Error).message.slice(0, 200),
            },
            parsed: emptyParsed(file.path),
          });
          this.parseCounter++;
        }
        processed++;
      }

      // Analysis phase: stage all fresh entries so cross-file edges between
      // simultaneously-changed files resolve against the fresh state.
      const staged = new Map(this.entries);
      const provisional: FileEntry[] = fresh.map(({ meta, parsed }) => ({
        meta,
        symbols: parsed.symbols,
        imports: parsed.imports,
        exports: parsed.exports,
        calls: parsed.calls,
        fileSummary: parsed.fileSummary,
        identifiers: parsed.identifiers,
        internalRelations: [],
      }));
      provisional.forEach((e) => staged.set(e.meta.path, e));
      analysis.setEntriesView(staged);

      const committed = provisional.map((provisionalEntry, index) => {
        const source = fresh[index];
        if (!source) throw new OccError("INVALID_STATE", "provisional/fresh length mismatch");
        return analysis.buildFileEntry(provisionalEntry.meta, source.parsed);
      });

      // Commit phase: persist atomically per entry, then update memory.
      if (committed.length > 0) {
        this.store.upsertEntries(committed); // persist first (atomic per entry)
        for (const entry of committed) {
          this.entries.set(entry.meta.path, entry);
          this.graph.upsertEntry(entry);
        }
        this.fireEntriesChanged({ upserted: committed, removed: [] });
      }

      // Removals: indexed files that disappeared from the scan.
      const scanned = new Set(scan.files.map((f) => f.path));
      const removed = [...this.entries.keys()].filter((p) => !scanned.has(p));
      for (const p of removed) this.removeEntry(p);

      const result: IndexRunResult = {
        totalFiles: scan.files.length,
        reparsed: committed.length,
        reused,
        removed: removed.length,
        scan,
        durationMs: Date.now() - started,
        cancelled: false,
      };
      this.setStatus({ state: "ready", fileCount: this.entries.size, lastResult: result });
      progress?.({
        phase: "done",
        processed,
        total: toParse.length,
        reparsed: committed.length,
        reused,
      });
      return result;
    } catch (e) {
      if (e instanceof CancelledError) {
        // Previously committed state remains intact and in memory stays valid.
        this.setStatus({ state: "ready", fileCount: this.entries.size });
        progress?.({ phase: "cancelled", processed: 0, total: 0, reparsed: 0, reused: 0 });
        return {
          totalFiles: 0,
          reparsed: 0,
          reused: 0,
          removed: 0,
          scan: {
            rootPath: this.rootPath,
            files: [],
            excludedPaths: [],
            truncatedExclusionList: false,
            durationMs: 0,
          },
          durationMs: Date.now() - started,
          cancelled: true,
        };
      }
      this.setStatus({
        state: "error",
        fileCount: this.entries.size,
        lastError: (e as Error).message,
      });
      throw e;
    }
  }

  /** Single-file analysis used by watcher-driven incremental updates. */
  private analyzeFile(
    rel: string,
    content: string,
    cancellation: CancellationSignal,
  ): FileEntry | null {
    cancellation.throwIfCancelled();
    const meta: FileMeta = {
      path: rel,
      language: detectLanguage(rel),
      sizeBytes: Buffer.byteLength(content, "utf8"),
      lineCount: countLines(content),
      contentHash: this.hasher.hash(content),
      isTest: isTestFile(rel),
      parseStatus: "PARSED",
    };
    try {
      const parsed = this.parserFor(rel).parse(rel, content);
      this.parseCounter++;
      const knownFiles = new Set([...this.entries.keys(), rel]);
      const staged = new Map(this.entries);
      const analysis = new AnalysisEngine(this.rootPath, knownFiles, staged);
      // Intentional two-pass build (same pattern as the batch staging in
      // runIncremental, ADR-008): pass 1 builds a provisional entry so the
      // staged view can include this file, pass 2 recomputes relationships
      // with the file visible for its own cross-file resolution (e.g. a
      // re-export chain through itself). Do not "simplify" to one call.
      const entry = analysis.buildFileEntry(meta, parsed);
      staged.set(rel, { ...entry, internalRelations: [] });
      analysis.setEntriesView(staged);
      return analysis.buildFileEntry(meta, parsed);
    } catch (e) {
      logger.warn(`single-file analysis failed for ${rel}: ${(e as Error).message}`);
      return {
        meta: { ...meta, parseStatus: "FAILED", parseError: (e as Error).message.slice(0, 200) },
        symbols: [],
        imports: [],
        exports: [],
        calls: [],
        internalRelations: [],
      };
    }
  }

  private commitEntries(committed: FileEntry[]): void {
    if (committed.length === 0) return;
    this.store.upsertEntries(committed); // persist first (atomic per entry)
    for (const entry of committed) {
      this.entries.set(entry.meta.path, entry);
      this.graph.upsertEntry(entry);
    }
    this.fireEntriesChanged({ upserted: committed, removed: [] });
  }

  private removeEntry(rel: string): void {
    if (!this.entries.has(rel)) return;
    this.store.removePaths([rel]);
    this.entries.delete(rel);
    this.graph.removeFile(rel);
    this.fireEntriesChanged({ upserted: [], removed: [rel] });
    this.setStatus({ state: "ready", fileCount: this.entries.size });
  }

  private fireEntriesChanged(changes: { upserted: FileEntry[]; removed: string[] }): void {
    for (const listener of this.entryListeners) listener(changes);
  }

  private setStatus(patch: Partial<IndexStatus> & { state: IndexStatus["state"] }): void {
    this._status = { ...this._status, ...patch };
    for (const listener of this.statusListeners) listener(this._status);
  }
}

function emptyParsed(path: string): ParsedFile {
  return {
    path,
    language: "generic",
    symbols: [],
    imports: [],
    exports: [],
    calls: [],
    heritages: [],
  };
}
