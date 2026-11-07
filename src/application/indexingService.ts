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
import { detectLanguage, isTestFile, looksBinary } from "../workspace/languageDetection";
import type { ParsedFile, SourceParser } from "../parser/parser";
import { BODY_TOKEN_TOP_N, extractBodyTokens, type BodyTokens } from "../parser/bodyTokens";
import { extractIdentifiers } from "../parser/typescriptParser";
import { AnalysisEngine } from "../analysis/analysisEngine";
import { JsonIndexStore, fingerprintForRoot, type IndexStore } from "../index/indexStore";
import { SecretScanner, blankSpans } from "../security/secretScanner";
import { toPosixPath, symbolId } from "../shared/ids";
import { logger } from "../shared/logging";
import type { CancellationSignal } from "../shared/cancellation";
import { checkCancelled, yieldToHost } from "../shared/cancellation";
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
  private options: IndexingOptions;
  private storeExclusion?: string;
  private readonly rootPath: string;
  private readonly scanner = new SecretScanner();

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
      this.storeExclusion = relStore;
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
      // F04: notify derived indexes of every removed path BEFORE clearing, so
      // the retriever's inverted/symbol indexes drop stale postings and
      // document frequencies reset; rebuild then emits only fresh upserts.
      this.fireEntriesChanged({
        upserted: [],
        removed: [...this.entries.keys()].sort(),
      });
      this.store.clear();
      this.entries.clear();
      this.graph.clear();
      return this.runIncremental(cancellation, progress, true);
    });
  }

  /**
   * F05: swaps discovery options atomically. The swap is serialized through
   * the internal queue so in-flight scans finish against the previous
   * options; the next scan/rebuild picks up the new ones.
   */
  updateOptions(next: IndexingOptions): Promise<void> {
    return this.enqueue(() => {
      // Re-apply the store exclusion preserved from construction.
      this.options = { ...next };
      if (this.storeExclusion) {
        this.options.excludePatterns = [
          ...(this.options.excludePatterns ?? []),
          this.storeExclusion,
        ];
      }
    });
  }

  /** Incrementally re-indexes one file ("unchanged" when hash matches). */
  async indexSingleFile(
    relativePath: string,
    cancellation: CancellationSignal,
  ): Promise<"indexed" | "unchanged" | "removed" | "ignored"> {
    return this.enqueue(async () => {
      const rel = this.normalizeRelative(relativePath);
      if (rel === null) return "ignored"; // outside the workspace root
      if (this.isIgnored(rel)) {
        this.removeEntry(rel);
        return "ignored";
      }
      const evaluation = this.evaluateFileEligibility(rel);
      if (evaluation.state === "removed") {
        this.removeEntry(rel);
        return "removed";
      }
      if (evaluation.state === "skipped") {
        this.removeEntry(rel); // previously eligible files become ineligible
        return "ignored";
      }
      const raw = evaluation.content!;
      const hash = this.hasher.hash(raw);
      const existing = this.entries.get(rel);
      if (existing && existing.meta.contentHash === hash) return "unchanged";
      const entry = this.analyzeFile(rel, raw.toString("utf8"), cancellation);
      if (!entry) return "ignored";
      this.commitEntries([entry]);
      this.setStatus({ state: "ready", fileCount: this.entries.size });
      return "indexed";
    });
  }

  /** POSIX-normalizes a watcher/CLI path; null when outside the root. */
  private normalizeRelative(relativePath: string): string | null {
    const resolved = path.resolve(this.rootPath, relativePath);
    const nativeRel = path.relative(this.rootPath, resolved);
    // F06/follow-up 7: check the RAW relative path BEFORE toPosixPath —
    // toPosixPath collapses `..` segments, which would silently pull
    // outside-root paths back inside the root.
    if (nativeRel.startsWith("..") || path.isAbsolute(nativeRel)) return null;
    const rel = toPosixPath(nativeRel);
    if (rel.startsWith("../")) return null; // defensive double-check
    return rel;
  }

  /**
   * F06: shared eligibility/read evaluation for direct and rename paths —
   * the same size, binary, and readability rules the full scan applies.
   * Raw bytes are returned so hashing matches the batch path exactly.
   */
  private evaluateFileEligibility(rel: string): {
    state: "ok" | "removed" | "skipped";
    content?: Buffer;
  } {
    const absolute = path.join(this.rootPath, rel);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return { state: "removed" };
    }
    if (!stat.isFile()) return { state: "removed" };
    const maxSize = this.options.maxFileSizeBytes ?? 1024 * 1024;
    if (stat.size > maxSize) return { state: "skipped" };
    let raw: Buffer;
    try {
      raw = fs.readFileSync(absolute);
    } catch {
      return { state: "removed" };
    }
    if (looksBinary(raw.toString("latin1"))) return { state: "skipped" };
    return { state: "ok", content: raw };
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
      // F04: derived retrieval indexes must reset with the authoritative
      // state — removals are emitted before clearing so the retriever drops
      // stale postings/symbol entries and IDF agrees with a fresh app.
      this.fireEntriesChanged({
        upserted: [],
        removed: [...this.entries.keys()].sort(),
      });
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

  /**
   * F07: ignore evaluation for direct/rename paths uses the SAME effective
   * rules as the full scan — root rules plus scoped nested `.gitignore`
   * files from the path's ancestor directories.
   */
  private isIgnored(rel: string): boolean {
    const rules = buildIgnoreRules(this.rootPath, this.options);
    if (this.options.respectGitignore !== false) {
      const segments = rel.split("/");
      segments.pop(); // the file itself
      let current = "";
      for (const seg of segments) {
        current = current ? `${current}/${seg}` : seg;
        try {
          const nested = fs.readFileSync(path.join(this.rootPath, current, ".gitignore"), "utf8");
          rules.addGitignoreContent(nested, current);
        } catch {
          /* no nested .gitignore in this directory */
        }
      }
    }
    return rules.isIgnored(rel, false);
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
      const fresh: Array<{ meta: FileMeta; parsed: ParsedFile; body?: BodyTokens }> = [];
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
          const spans = this.scanner.scanSpans(content);
          const sanitizedContent = spans.length > 0 ? blankSpans(content, spans) : content;
          const parsed = this.sanitizeParsed(
            this.parserFor(file.path).parse(file.path, content),
            sanitizedContent,
            spans.length > 0,
          );
          // F14: parser-reported diagnostics (partial analysis) map into the
          // persisted metadata instead of being dropped.
          if (parsed.parseError) {
            meta.parseStatus = "PARTIAL";
            meta.parseError = parsed.parseError;
          }
          fresh.push({
            meta,
            parsed,
            body: extractBodyTokens(sanitizedContent, BODY_TOKEN_TOP_N),
          });
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
        // FU1: yield the macrotask periodically so the extension host stays
        // responsive (progress UI, watcher events, cancellation) on large
        // workspaces — the loop is otherwise fully synchronous.
        if (processed % 64 === 0) await yieldToHost();
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
        const entry = analysis.buildFileEntry(provisionalEntry.meta, source.parsed);
        return source.body
          ? { ...entry, bodyTokens: source.body.terms, bodyLength: source.body.total }
          : entry;
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
      const spans = this.scanner.scanSpans(content);
      const sanitizedContent = spans.length > 0 ? blankSpans(content, spans) : content;
      const parsed = this.sanitizeParsed(
        this.parserFor(rel).parse(rel, content),
        sanitizedContent,
        spans.length > 0,
      );
      this.parseCounter++;
      // F14: parser-reported diagnostics (partial analysis) map into the
      // persisted metadata instead of being dropped.
      if (parsed.parseError) {
        meta.parseStatus = "PARTIAL";
        meta.parseError = parsed.parseError;
      }
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
      const final = analysis.buildFileEntry(meta, parsed);
      const body = extractBodyTokens(sanitizedContent, BODY_TOKEN_TOP_N);
      return { ...final, bodyTokens: body.terms, bodyLength: body.total };
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

  private sanitizeParsed(
    parsed: ParsedFile,
    sanitizedContent: string,
    hasSpans: boolean,
  ): ParsedFile {
    if (hasSpans && parsed.identifiers) {
      parsed.identifiers = extractIdentifiers(sanitizedContent);
    }
    if (parsed.fileSummary) {
      const sumSpans = this.scanner.scanSpans(parsed.fileSummary);
      if (sumSpans.length > 0) {
        parsed.fileSummary = blankSpans(parsed.fileSummary, sumSpans).replace(/\s+/g, " ").trim();
      }
    }
    for (const s of parsed.symbols) {
      if (s.docComment) {
        const docSpans = this.scanner.scanSpans(s.docComment);
        if (docSpans.length > 0) {
          s.docComment = blankSpans(s.docComment, docSpans).replace(/\s+/g, " ").trim();
        }
      }
      if (s.signature) {
        const sigSpans = this.scanner.scanSpans(s.signature);
        if (sigSpans.length > 0) {
          s.signature = blankSpans(s.signature, sigSpans).replace(/\s+/g, " ").trim();
        }
      }
    }
    this.sanitizeStructuralStrings(parsed);
    return parsed;
  }

  /**
   * F01: scanner-flagged credential material must never survive in persisted
   * metadata through structural strings — symbol names (thus ids), parent
   * references, call sites, export names, imported names, module specifiers,
   * or parse-error text. Flagged spans are blanked; a name that becomes
   * empty drops its record. Ids are rebuilt deterministically after renaming
   * and every parent/caller reference is rewritten through the id map, so
   * references stay consistent without dangling entries.
   */
  private sanitizeStructuralStrings(parsed: ParsedFile): void {
    if (parsed.parseError) {
      const errSpans = this.scanner.scanSpans(parsed.parseError);
      if (errSpans.length > 0) {
        parsed.parseError = blankSpans(parsed.parseError, errSpans)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
      }
    }

    const idMap = new Map<string, string>();
    const dropped = new Set<string>();
    const keptSymbols = [];
    for (const s of parsed.symbols) {
      const name = this.sanitizeText(s.name);
      if (name !== null && name.length === 0) {
        dropped.add(s.id);
        continue;
      }
      if (name !== null && name !== s.name) {
        const newId = symbolId(s.filePath, name, s.kind, s.startLine);
        idMap.set(s.id, newId);
        s.name = name;
        s.id = newId;
      }
      keptSymbols.push(s);
    }
    for (const s of keptSymbols) {
      if (s.parentId) {
        if (dropped.has(s.parentId)) s.parentId = undefined;
        else s.parentId = idMap.get(s.parentId) ?? s.parentId;
      }
    }
    parsed.symbols = keptSymbols;

    const remapCaller = (id: string): string | null => {
      if (dropped.has(id)) return null;
      return idMap.get(id) ?? id;
    };
    parsed.calls = parsed.calls
      .map((c) => ({ ...c, callerId: remapCaller(c.callerId) }))
      .filter((c): c is typeof c & { callerId: string } => c.callerId !== null)
      .map((c) => {
        const callee = this.sanitizeText(c.calleeName);
        return callee !== null && callee.length === 0
          ? null
          : { ...c, calleeName: callee ?? c.calleeName };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    // F01 note: sanitizeText returns null for "unchanged" — null must KEEP
    // the original value; an empty result means fully flagged and drops the
    // record. Treating null as a drop breaks import resolution.
    parsed.exports = parsed.exports
      .map((e) => {
        const name = this.sanitizeText(e.name);
        return name === null ? e : { ...e, name };
      })
      .filter((e) => e.name.length > 0);

    parsed.imports = parsed.imports
      .map((imp) => {
        const source = this.sanitizeText(imp.sourceText);
        if (source !== null && source.length === 0) return null; // specifier fully flagged
        const names: string[] = [];
        for (const n of imp.importedNames) {
          const s = this.sanitizeText(n);
          if (s === null)
            names.push(n); // unchanged
          else if (s.length > 0) names.push(s); // sanitized, still usable
          // else: fully flagged name is dropped from the list
        }
        return { ...imp, sourceText: source ?? imp.sourceText, importedNames: names };
      })
      .filter((imp): imp is NonNullable<typeof imp> => imp !== null);
  }

  /** Blanks scanner-flagged spans in a string; null when nothing flagged. */
  private sanitizeText(text: string): string | null {
    const spans = this.scanner.scanSpans(text);
    if (spans.length === 0) return null;
    return blankSpans(text, spans).replace(/\s+/g, " ").trim();
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
