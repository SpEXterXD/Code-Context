import * as path from "node:path";

import type { FileEntry, FileMeta, Relationship } from "../domain/model";
import { RelationshipGraph } from "../domain/graph";
import {
  WorkspaceScanner,
  buildIgnoreRules,
  countLines,
  type ScanResult,
} from "../workspace/workspaceScanner";
import { Sha256FileHasher, type FileHasher } from "../workspace/fileHasher";
import { detectLanguage, isTestFile, looksBinary } from "../workspace/languageDetection";
import {
  checkComponentLinks,
  hasTraversalSegment,
  readBoundedBuffer,
  readBoundedFile,
  readBoundedFileResult,
  bindWorkspaceRoot,
  isBoundWorkspaceRoot,
  verifyRootIdentity,
  type BoundWorkspaceRoot,
} from "../workspace/containment";
import type { ParsedFile, SourceParser } from "../parser/parser";
import { BODY_TOKEN_TOP_N, extractBodyTokens } from "../parser/bodyTokens";
import { extractIdentifiers } from "../parser/typescriptParser";
import { AnalysisEngine, buildExportIndex, buildFileEntry } from "../analysis/analysisEngine";
import { loadAliasMapping } from "../analysis/importResolver";
import { JsonIndexStore, fingerprintForRoot, type IndexStore } from "../index/indexStore";
import { SecretScanner, blankSpans } from "../security/secretScanner";
import { toPosixPath, symbolId } from "../shared/ids";
import { logger } from "../shared/logging";
import type { CancellationSignal } from "../shared/cancellation";
import { checkCancelled, NEVER_CANCELLED, yieldToHost } from "../shared/cancellation";
import { CancelledError, OccError } from "../shared/errors";
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
 * relationships → persist per entry → publish one coherent live update.
 *
 * Guarantees (all covered by tests):
 * - unchanged content hash ⇒ reuse previous analysis, zero re-parses
 * - persistence is per entry; a crash or
 *   write failure can leave a partial batch, recovered from the landed shards
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
  private readonly rootBinding: BoundWorkspaceRoot;
  private readonly rootPath: string;
  private readonly scanner = new SecretScanner();

  private queue: Promise<unknown> = Promise.resolve();
  private _status: IndexStatus = { state: "empty", fileCount: 0 };
  private readonly statusListeners: Array<(s: IndexStatus) => void> = [];
  private readonly entryListeners: Array<
    (changes: { upserted: FileEntry[]; removed: string[] }) => void
  > = [];
  private parseCounter = 0;
  private readonly pendingRelationWrites = new Set<string>();
  private manifestNeedsWrite = false;
  private aliasFingerprint?: string;

  constructor(
    root: string | BoundWorkspaceRoot,
    storeRoot: string,
    parserFor: (path: string) => SourceParser,
    options: IndexingOptions = {},
    storeOverride?: IndexStore,
  ) {
    this.rootBinding = isBoundWorkspaceRoot(root) ? root : bindWorkspaceRoot(root);
    this.rootPath = this.rootBinding.rootPath;
    this.store = storeOverride ?? new JsonIndexStore(storeRoot, fingerprintForRoot(this.rootPath));
    this.parserFor = parserFor;
    this.options = { ...options };
    // Never index our own store: if it lives inside the workspace root,
    // exclude it explicitly (inspection list shows the exclusion).
    const relStore = toPosixPath(path.relative(this.rootPath, storeRoot));
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
    this.reconcileLoadedEntries(this.store.load().entries);
    this.manifestNeedsWrite = false;
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

  /** Re-parses every eligible file before replacing the committed state. */
  async rebuild(
    cancellation: CancellationSignal,
    progress?: (p: IndexProgress) => void,
  ): Promise<IndexRunResult> {
    return this.enqueue(() => this.runIncremental(cancellation, progress, true));
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
      if (rel === null || !verifyRootIdentity(this.rootBinding)) return "ignored";
      cancellation.throwIfCancelled();
      if (this.isIgnoreFile(rel)) {
        const before = this.entries.get(rel);
        const { cancelled } = await this.runIncremental(cancellation, undefined, false);
        if (cancelled) cancellation.throwIfCancelled();
        const after = this.entries.get(rel);
        if (!after) return before ? "removed" : "ignored";
        return before === after ? "unchanged" : "indexed";
      }
      const evaluation = this.isIgnored(rel)
        ? { state: "skipped" as const }
        : this.evaluateFileEligibility(rel);
      if (evaluation.state !== "ok") {
        await this.commitEntries([], [rel], cancellation);
        return evaluation.state === "removed" ? "removed" : "ignored";
      }
      const raw = evaluation.content!;
      const existing = this.entries.get(rel);
      if (
        existing &&
        !isTransientFailure(existing) &&
        existing.meta.contentHash === this.hasher.hash(raw)
      ) {
        await this.commitEntries([], [], cancellation);
        return "unchanged";
      }
      await this.commitEntries([this.analyzeFile(rel, raw)], [], cancellation);
      return "indexed";
    });
  }

  /** POSIX-normalizes a watcher/CLI path; null when outside the root. */
  private normalizeRelative(relativePath: string): string | null {
    const resolved = path.resolve(this.rootPath, relativePath);
    const nativeRel = path.relative(this.rootPath, resolved);
    // F06/follow-up 7 + Stage 3: lexical containment via the shared policy —
    // only an actual ".." SEGMENT is traversal. The previous startsWith("..")
    // check rejected legal root-level names like `..notes.ts` on the direct
    // path while full scan accepted them. Sibling roots sharing a prefix
    // (..\root2\x) and absolute outsiders still fail via the ".." segment.
    if (hasTraversalSegment(nativeRel) || path.isAbsolute(nativeRel)) return null;
    const rel = toPosixPath(nativeRel);
    if (hasTraversalSegment(rel)) return null; // defensive double-check
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
    const maxSize = this.options.maxFileSizeBytes ?? 1024 * 1024;
    const readResult = readBoundedFileResult(this.rootBinding, rel, maxSize);
    if (!readResult.ok) {
      if (readResult.reason === "too-large") return { state: "skipped" };
      return { state: "removed" };
    }
    const raw = readResult.buffer;
    if (looksBinary(raw.toString("latin1"))) return { state: "skipped" };
    return { state: "ok", content: raw };
  }

  /** Removes a file's records (watcher delete / rename source). */
  async removeFile(relativePath: string): Promise<void> {
    return this.enqueue(async () => {
      const rel = this.normalizeRelative(relativePath);
      if (rel === null) return;
      if (this.isIgnoreFile(rel)) {
        await this.runIncremental(NEVER_CANCELLED, undefined, false);
      } else {
        await this.commitEntries([], [rel]);
      }
    });
  }

  /** Stages the source removal and eligible destination in the same writer job. */
  async renameFile(
    oldRelativePath: string,
    newRelativePath: string,
    cancellation: CancellationSignal,
  ): Promise<void> {
    return this.enqueue(async () => {
      cancellation.throwIfCancelled();
      const oldRel = this.normalizeRelative(oldRelativePath);
      const newRel = this.normalizeRelative(newRelativePath);
      if (
        (oldRel !== null && this.isIgnoreFile(oldRel)) ||
        (newRel !== null && this.isIgnoreFile(newRel))
      ) {
        const result = await this.runIncremental(cancellation, undefined, false);
        if (result.cancelled) cancellation.throwIfCancelled();
        return;
      }
      const removed = oldRel === null ? [] : [oldRel];
      const changed: FileEntry[] = [];
      if (newRel !== null) {
        const evaluation = this.isIgnored(newRel)
          ? { state: "skipped" as const }
          : this.evaluateFileEligibility(newRel);
        if (evaluation.state === "ok") {
          changed.push(this.analyzeFile(newRel, evaluation.content!));
        } else {
          removed.push(newRel);
        }
      }
      await this.commitEntries(changed, removed, cancellation);
    });
  }

  async clearIndex(): Promise<void> {
    return this.enqueue(() => {
      try {
        this.store.clear();
      } catch (error) {
        this.recoverWriteFailure(error);
        throw error;
      }
      this.pendingRelationWrites.clear();
      this.manifestNeedsWrite = false;
      this.publishEntries([], [...this.entries.keys()]);
      this.setStatus({ state: "empty", fileCount: 0, lastError: undefined });
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
  private isIgnoreFile(rel: string): boolean {
    return this.options.respectGitignore !== false && path.posix.basename(rel) === ".gitignore";
  }

  private isIgnored(rel: string): boolean {
    // Stage 3: containment FIRST — a path with a link component (or missing
    // component) is treated as ignored so nested .gitignore reads can never
    // reach outside the root through a linked ancestor. Full scan never
    // enters linked directories, so this only guards direct/rename inputs.
    if (!checkComponentLinks(this.rootBinding, rel).ok) return true;
    const rules = buildIgnoreRules(this.rootBinding, this.options);
    if (this.options.respectGitignore !== false) {
      const segments = rel.split("/");
      segments.pop(); // the file itself
      let current = "";
      for (const seg of segments) {
        current = current ? `${current}/${seg}` : seg;
        const nestedRel = `${current}/.gitignore`;
        const maxSize = this.options.maxFileSizeBytes ?? 1024 * 1024;
        const nested = readBoundedFile(this.rootBinding, nestedRel, maxSize);
        if (nested !== null) {
          rules.addGitignoreContent(nested, current);
        }
      }
      // Review fix (F07 parity): Git cannot re-include a file below an
      // EXCLUDED parent directory — traversal prunes the directory and never
      // reaches nested negations, so direct decisions must check each
      // ancestor directory the same way (`ignored/` + `!ignored/keep.ts`
      // keeps keep.ts excluded).
      let dir = "";
      for (const seg of rel.split("/").slice(0, -1)) {
        dir = dir ? `${dir}/${seg}` : seg;
        if (rules.isIgnored(dir, true)) return true;
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
      const scan = new WorkspaceScanner(this.options).scan(this.rootBinding, cancellation);
      if (!scan.complete || !verifyRootIdentity(this.rootBinding)) {
        throw new OccError("SCAN_INCOMPLETE", "workspace discovery incomplete");
      }
      progress?.({ phase: "scan", processed: 0, total: scan.files.length, reparsed: 0, reused: 0 });

      let reused = 0;
      const eligible = scan.files.filter((file) => file.status === "OK");
      const toParse = eligible.filter((file) => {
        const existing = this.entries.get(file.path);
        if (
          !force &&
          existing &&
          !isTransientFailure(existing) &&
          existing.meta.contentHash === file.contentHash
        ) {
          reused++;
          return false;
        }
        return true;
      });
      const scanned = new Set(eligible.map((f) => f.path));
      const removed = [...this.entries.keys()].filter((p) => !scanned.has(p));
      const fresh: FileEntry[] = [];
      let processed = 0;
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
          const cap = this.options.maxFileSizeBytes ?? 1024 * 1024;
          const containment = checkComponentLinks(this.rootBinding, file.path, {
            requireLeafFile: true,
          });
          if (!containment.ok) {
            throw new OccError(
              "CONTAINMENT_VIOLATION",
              `file failed containment check: ${containment.reason}`,
            );
          }
          const raw = readBoundedBuffer(this.rootBinding, file.path, cap);
          if (raw === null) {
            throw new OccError(
              "FILE_UNAVAILABLE",
              "source snapshot unavailable or changed at parse",
            );
          }
          if (looksBinary(raw.toString("latin1"))) {
            throw new OccError("BINARY_FILE", "file content is binary");
          }
          fresh.push(this.analyzeFile(file.path, raw));
        } catch (e) {
          // Stage 3: the exception message is untrusted (may echo source
          // material) - persist and log a safe category only.
          const category = safeParseFailureCategory(e);
          logger.warn(`parse failed for ${file.path}: ${category}`);
          fresh.push(
            buildFileEntry(
              {
                path: file.path,
                language: detectLanguage(file.path),
                sizeBytes: file.sizeBytes,
                lineCount: 0,
                contentHash: file.contentHash,
                isTest: file.isTest,
                parseStatus: "FAILED",
                parseError: category,
              },
              emptyParsed(file.path),
            ),
          );
          this.parseCounter++;
        }
        processed++;
        // FU1: yield the macrotask periodically so the extension host stays
        // responsive (progress UI, watcher events, cancellation) on large
        // workspaces — the loop is otherwise fully synchronous.
        if (processed % 64 === 0) await yieldToHost();
      }

      await this.commitEntries(fresh, removed, cancellation, () => {
        progress?.({
          phase: "commit",
          processed,
          total: toParse.length,
          reparsed: fresh.length,
          reused,
        });
      });

      const result: IndexRunResult = {
        totalFiles: scan.files.length,
        reparsed: fresh.length,
        reused,
        removed: removed.length,
        scan,
        durationMs: Date.now() - started,
        cancelled: false,
      };
      this.setStatus({
        state: "ready",
        fileCount: this.entries.size,
        lastResult: result,
        lastError: undefined,
      });
      progress?.({
        phase: "done",
        processed,
        total: toParse.length,
        reparsed: fresh.length,
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
            complete: false,
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

  /** Parses bounded bytes through the same sanitization for scans and watcher events. */
  private analyzeFile(rel: string, raw: Buffer): FileEntry {
    const content = raw.toString("utf8");
    const meta: FileMeta = {
      path: rel,
      language: detectLanguage(rel),
      sizeBytes: raw.length,
      lineCount: countLines(content),
      contentHash: this.hasher.hash(raw),
      isTest: isTestFile(rel),
      parseStatus: "PARSED",
    };
    this.parseCounter++;
    try {
      const spans = this.scanner.scanSpans(content);
      const sanitizedContent = spans.length > 0 ? blankSpans(content, spans) : content;
      const parser = this.parserFor(rel);
      const parsed = this.sanitizeParsed(
        parser.parse(rel, content),
        sanitizedContent,
        spans.length > 0,
      );
      if (parsed.parseError) {
        meta.parseStatus = "PARTIAL";
        meta.parseError = parsed.parseError;
      } else if (parser.language === "generic") {
        meta.parseStatus = "GENERIC";
      }
      const entry = buildFileEntry(meta, parsed);
      const body = extractBodyTokens(sanitizedContent, BODY_TOKEN_TOP_N);
      return { ...entry, bodyTokens: body.terms, bodyLength: body.total };
    } catch (e) {
      const category = safeParseFailureCategory(e);
      logger.warn(`parse failed for ${rel}: ${category}`);
      return buildFileEntry(
        { ...meta, parseStatus: "FAILED", parseError: category },
        emptyParsed(rel),
      );
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

    parsed.heritages = parsed.heritages.flatMap((clause) => {
      const symbolName = this.sanitizeText(clause.symbolName) ?? clause.symbolName;
      const parents = clause.parents
        .map((parent) => this.sanitizeText(parent) ?? parent)
        .filter(Boolean);
      return symbolName && parents.length > 0 ? [{ ...clause, symbolName, parents }] : [];
    });

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
        // Review fix: aliasedNames (local alias → imported name, FU4 field)
        // are structural strings too — both sides sanitized; a pair whose
        // either side becomes fully flagged is dropped, and an emptied list
        // omits the field entirely (never falls back to the raw original).
        const aliases: Array<{ local: string; imported: string }> = [];
        for (const pair of imp.aliasedNames ?? []) {
          const local = this.sanitizeText(pair.local);
          if (local !== null && local.length === 0) continue;
          const imported = this.sanitizeText(pair.imported);
          if (imported !== null && imported.length === 0) continue;
          aliases.push({ local: local ?? pair.local, imported: imported ?? pair.imported });
        }
        const cleaned = {
          ...imp,
          sourceText: source ?? imp.sourceText,
          importedNames: names,
        };
        if (aliases.length > 0) cleaned.aliasedNames = aliases;
        else delete cleaned.aliasedNames;
        return cleaned;
      })
      .filter((imp): imp is NonNullable<typeof imp> => imp !== null);
  }

  /** Blanks scanner-flagged spans in a string; null when nothing flagged. */
  private sanitizeText(text: string): string | null {
    const spans = this.scanner.scanSpans(text);
    if (spans.length === 0) return null;
    return blankSpans(text, spans).replace(/\s+/g, " ").trim();
  }

  /**
   * Computes the entire mutation against a staged view. Once shard writes start,
   * finish the batch despite cancellation. Readers keep the old index during
   * yields, and receive one synchronous publication after the last write.
   */
  private async commitEntries(
    changed: FileEntry[],
    removedPaths: string[],
    cancellation: CancellationSignal = NEVER_CANCELLED,
    beforeWrite?: () => void,
  ): Promise<void> {
    const freshPaths = new Set(changed.map((entry) => entry.meta.path));
    const removed = [...new Set(removedPaths)].filter(
      (p) => this.entries.has(p) && !freshPaths.has(p),
    );
    const changedPaths = new Set([...freshPaths, ...removed]);
    // Alias configs can affect relationships even when excluded from discovery
    // or when every source entry is reused.
    const aliases = loadAliasMapping(this.rootBinding, this.options.maxFileSizeBytes);
    const aliasesChanged = aliases.fingerprint !== this.aliasFingerprint;
    const upserts = new Map<string, FileEntry>();
    if (changedPaths.size > 0 || aliasesChanged) {
      const staged = new Map(this.entries);
      for (const p of removed) staged.delete(p);
      for (const entry of changed) staged.set(entry.meta.path, entry);

      // Select importers from prior outgoing edges before publishing removals.
      // New resolution also catches missing imports and higher-priority candidates.
      const oldEntries = [...this.entries].filter(([p]) => changedPaths.has(p));
      const changedNames = new Set([
        ...buildExportIndex(oldEntries).keys(),
        ...buildExportIndex(changed.map((entry) => [entry.meta.path, entry])).keys(),
      ]);
      const analysis = new AnalysisEngine(staged, aliases);
      let processed = 0;
      for (const [p, entry] of staged) {
        checkCancelled(cancellation, 64, processed);
        const isFresh = freshPaths.has(p);
        const refreshImports = aliasesChanged && entry.imports.length > 0;
        if (isFresh || refreshImports || analysis.isAffected(entry, changedPaths, changedNames)) {
          const recomputed = analysis.recomputeRelations(entry);
          if (
            isFresh ||
            !compareRelationsShallow(entry.internalRelations, recomputed.internalRelations)
          ) {
            upserts.set(p, recomputed);
          }
        }
        if (++processed % 64 === 0) await yieldToHost();
      }
    }

    // A previous write failure may have landed some shards. Flush repairs
    // even on an otherwise unchanged run once the store is writable again.
    const writes = new Map(upserts);
    const removedSet = new Set(removed);
    for (const p of this.pendingRelationWrites) {
      const entry = this.entries.get(p);
      if (entry && !removedSet.has(p) && !writes.has(p)) writes.set(p, entry);
    }
    beforeWrite?.();
    cancellation.throwIfCancelled();
    const hasWrites = writes.size > 0 || removed.length > 0 || this.manifestNeedsWrite;
    if (!hasWrites && !aliasesChanged && !beforeWrite) return;
    if (!verifyRootIdentity(this.rootBinding)) {
      throw new OccError("SCAN_INCOMPLETE", "workspace root identity invalidated before commit");
    }

    let persisted = 0;
    try {
      for (const entry of writes.values()) {
        if (persisted > 0 && persisted % 64 === 0) await yieldToHost();
        this.store.upsertEntries([entry]);
        persisted++;
      }
      for (const p of removed) {
        if (persisted > 0 && persisted % 64 === 0) await yieldToHost();
        this.store.removePaths([p]);
        persisted++;
      }
      if (this.manifestNeedsWrite && persisted === 0) this.store.writeManifest();
    } catch (error) {
      this.recoverWriteFailure(error);
      throw error;
    }
    this.pendingRelationWrites.clear();
    this.manifestNeedsWrite = false;
    this.aliasFingerprint = aliases.fingerprint;
    if (upserts.size > 0 || removed.length > 0) {
      this.publishEntries([...upserts.values()], removed);
    }
    if (hasWrites && this._status.state !== "indexing") {
      this.setStatus({ state: "ready", fileCount: this.entries.size, lastError: undefined });
    }
  }

  private recoverWriteFailure(error: unknown): void {
    // Read the authoritative shards without attempting another write against
    // the failing store. Reopening applies the same relationship repair.
    this.reconcileLoadedEntries(this.store.load(false).entries);
    this.manifestNeedsWrite = true;
    this.setStatus({
      state: "error",
      fileCount: this.entries.size,
      lastError: (error as Error).message,
    });
  }

  private reconcileLoadedEntries(loaded: Map<string, FileEntry>): void {
    this.pendingRelationWrites.clear();
    const aliases = loadAliasMapping(this.rootBinding, this.options.maxFileSizeBytes);
    const analysis = new AnalysisEngine(loaded, aliases);
    const upserted: FileEntry[] = [];
    for (const [p, entry] of loaded) {
      const resolved = analysis.recomputeRelations(entry);
      const differs = !compareRelationsShallow(entry.internalRelations, resolved.internalRelations);
      if (differs) this.pendingRelationWrites.add(p);
      upserted.push(differs ? resolved : entry);
    }
    const removed = [...this.entries.keys()].filter((p) => !loaded.has(p));
    this.aliasFingerprint = aliases.fingerprint;
    this.publishEntries(upserted, removed);
  }

  private publishEntries(upserted: FileEntry[], removed: string[]): void {
    for (const p of removed) {
      this.entries.delete(p);
      this.graph.removeFile(p);
    }
    for (const entry of upserted) {
      this.entries.set(entry.meta.path, entry);
      this.graph.upsertEntry(entry);
    }
    this._status = { ...this._status, fileCount: this.entries.size };
    this.fireEntriesChanged({ upserted, removed });
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

/**
 * Stage 3: safe parse-failure category. A thrown parser error's message is
 * UNTRUSTED (a hostile parser, or a parser that echoes source material, can
 * put scanner-flagged content into it), so it is never persisted, logged,
 * or rendered. Only trusted internal error codes survive; everything else
 * degrades to a fixed category with the message withheld.
 * Distinguishes files that could not be read or validated (transient failures)
 * from files whose bytes were actually parsed.
 */
export function safeParseFailureCategory(error: unknown): string {
  if (error instanceof OccError) {
    if (error.code === "CONTAINMENT_VIOLATION") {
      return `containment check failed: ${error.code}`;
    }
    if (error.code === "FILE_UNAVAILABLE") {
      return `read failed: ${error.code}`;
    }
    return `parser failed: ${error.code}`;
  }
  return "parser failed: unexpected error (message withheld)";
}

/**
 * Distinguishes a transient failure (a file that could not be read or validated
 * at parse time) from one whose bytes were actually parsed. Transient failures
 * must not satisfy the unchanged-file shortcut so recovery is automatic on retry.
 */
export function isTransientFailure(entry: FileEntry | FileMeta | undefined): boolean {
  if (!entry) return false;
  const meta = "meta" in entry ? entry.meta : entry;
  if (meta.parseStatus !== "FAILED") return false;
  const err = meta.parseError ?? "";
  return (
    err.startsWith("containment check failed") ||
    err.startsWith("read failed") ||
    err.includes("CONTAINMENT_VIOLATION") ||
    err.includes("FILE_UNAVAILABLE")
  );
}

/** Analysis emits relationships in a deterministic order. */
function compareRelationsShallow(a: Relationship[], b: Relationship[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => {
      const other = b[i]!;
      return (
        r.source === other.source &&
        r.target === other.target &&
        r.kind === other.kind &&
        r.provenance === other.provenance &&
        r.detail === other.detail
      );
    })
  );
}
