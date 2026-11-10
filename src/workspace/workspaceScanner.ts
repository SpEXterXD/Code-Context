import * as fs from "node:fs";
import * as path from "node:path";

import { sha256Hex, toPosixPath } from "../shared/ids";
import { compareStrings } from "../shared/text";
import { OccError } from "../shared/errors";
import type { CancellationSignal } from "../shared/cancellation";
import { checkCancelled } from "../shared/cancellation";
import { IgnoreRules } from "./ignoreRules";
import { DEFAULT_EXCLUDES } from "./ignoreRules";
import { detectLanguage, isTestFile, looksBinary } from "./languageDetection";
import {
  readBoundedFile,
  readBoundedFileResult,
  activeReaddirSync,
  bindWorkspaceRoot,
  isBoundWorkspaceRoot,
  verifyRootIdentity,
  type BoundWorkspaceRoot,
} from "./containment";

export interface DiscoveredFile {
  path: string; // POSIX relative
  absolutePath: string;
  sizeBytes: number;
  lineCount: number;
  contentHash: string;
  language: string;
  isTest: boolean;
  status: "OK" | "SKIPPED_BINARY" | "SKIPPED_TOO_LARGE";
}

export interface ScanResult {
  rootPath: string;
  files: DiscoveredFile[]; // sorted by path
  excludedPaths: string[]; // first N excluded paths (for inspectability)
  truncatedExclusionList: boolean;
  durationMs: number;
  complete: boolean;
}

export interface ScanOptions {
  excludePatterns?: string[];
  respectGitignore?: boolean;
  maxFileSizeBytes?: number;
  /** Maximum number of excluded paths to record for inspectability. */
  maxRecordedExclusions?: number;
}

/** Builds the effective ignore rule set for a root (defaults + config + .gitignore). */
export function buildIgnoreRules(
  root: string | BoundWorkspaceRoot,
  options: ScanOptions = {},
): IgnoreRules {
  const rules = new IgnoreRules(options.excludePatterns ?? []);
  // Built-in security/store excludes carry the builtin flag so repository
  // negations cannot re-include them (F07 acceptance).
  for (const glob of DEFAULT_EXCLUDES) rules.addPattern(glob, undefined, true);
  if (options.respectGitignore !== false) {
    const maxBytes = options.maxFileSizeBytes ?? 1024 * 1024;
    const content = readBoundedFile(root, ".gitignore", maxBytes);
    if (content !== null) {
      rules.addGitignoreContent(content);
    }
  }
  return rules;
}

/**
 * Recursive workspace discovery. Deterministic: identical trees produce
 * byte-identical scan results (sorted paths, stable hashes).
 * Routes discovery reads through the shared contained, bounded read path.
 */
export class WorkspaceScanner {
  constructor(private readonly options: ScanOptions = {}) {}

  scan(root: string | BoundWorkspaceRoot, cancellation: CancellationSignal): ScanResult {
    const started = Date.now();
    const boundRoot = isBoundWorkspaceRoot(root) ? root : bindWorkspaceRoot(root);
    const rootPath = boundRoot.rootPath;

    // Fail closed if root identity cannot be verified
    if (!verifyRootIdentity(boundRoot)) {
      throw new OccError(
        "CONTAINMENT_VIOLATION",
        "workspace root identity verification failed: root-identity-violation",
      );
    }

    const rules = buildIgnoreRules(boundRoot, this.options);
    const files: DiscoveredFile[] = [];
    const excluded: string[] = [];
    const maxExcluded = this.options.maxRecordedExclusions ?? 200;
    const maxSize = this.options.maxFileSizeBytes ?? 1024 * 1024;
    let iteration = 0;

    const visit = (absoluteDir: string, relDir: string): void => {
      if (!verifyRootIdentity(boundRoot)) {
        throw new OccError(
          "SCAN_INCOMPLETE",
          "scan incomplete: workspace root identity invalidated during discovery",
        );
      }

      let dirents: fs.Dirent[];
      try {
        dirents = activeReaddirSync(absoluteDir, { withFileTypes: true }) as fs.Dirent[];
      } catch {
        return; // unreadable dir: skip silently but consistently
      }
      dirents.sort((a, b) => compareStrings(a.name, b.name));
      for (const dirent of dirents) {
        checkCancelled(cancellation, 64, iteration++);
        const relPath = relDir ? `${relDir}/${dirent.name}` : dirent.name;
        const absolutePath = path.join(absoluteDir, dirent.name);
        if (dirent.isDirectory()) {
          if (rules.isIgnored(relPath, true)) {
            if (excluded.length < maxExcluded) excluded.push(`${relPath}/ (directory)`);
            continue;
          }
          // Nested .gitignore files contribute patterns (treated as root-relative).
          if (this.options.respectGitignore !== false) {
            const nestedRel = relPath ? `${relPath}/.gitignore` : ".gitignore";
            const nested = readBoundedFile(boundRoot, nestedRel, maxSize);
            if (nested !== null) {
              rules.addGitignoreContent(nested, relPath);
            }
          }
          visit(absolutePath, relPath);
          continue;
        }
        if (!dirent.isFile()) continue;
        if (rules.isIgnored(relPath, false)) {
          if (excluded.length < maxExcluded) excluded.push(relPath);
          continue;
        }

        // Bounded, contained read: enforces component links, bounds bytes read,
        // detects growth past maxSize between stat and read, and derives size/hash from same bytes.
        const readResult = readBoundedFileResult(boundRoot, relPath, maxSize);
        if (!readResult.ok) {
          if (readResult.reason === "root-identity-violation") {
            throw new OccError(
              "SCAN_INCOMPLETE",
              "scan incomplete: workspace root identity invalidated during discovery",
            );
          }
          if (readResult.reason === "too-large") {
            files.push({
              path: toPosixPath(relPath),
              absolutePath,
              sizeBytes: readResult.sizeBytes,
              lineCount: 0,
              contentHash: `skipped-too-large:${readResult.sizeBytes}`,
              language: detectLanguage(toPosixPath(relPath)),
              isTest: isTestFile(toPosixPath(relPath)),
              status: "SKIPPED_TOO_LARGE",
            });
          }
          continue;
        }

        const content = readResult.buffer;
        const sizeBytes = readResult.sizeBytes;
        if (looksBinary(content.toString("latin1"))) {
          files.push({
            path: toPosixPath(relPath),
            absolutePath,
            sizeBytes,
            lineCount: 0,
            contentHash: `skipped-binary:${sha256Hex(content.toString("latin1").slice(0, 4096))}`,
            language: detectLanguage(toPosixPath(relPath)),
            isTest: isTestFile(toPosixPath(relPath)),
            status: "SKIPPED_BINARY",
          });
          continue;
        }

        const text = content.toString("utf8");
        files.push({
          path: toPosixPath(relPath),
          absolutePath,
          sizeBytes,
          lineCount: countLines(text),
          contentHash: sha256Hex(content),
          language: detectLanguage(toPosixPath(relPath)),
          isTest: isTestFile(toPosixPath(relPath)),
          status: "OK",
        });
      }
    };

    visit(rootPath, "");
    if (!verifyRootIdentity(boundRoot)) {
      throw new OccError(
        "SCAN_INCOMPLETE",
        "scan incomplete: workspace root identity invalidated during discovery",
      );
    }
    files.sort((a, b) => compareStrings(a.path, b.path));
    return {
      rootPath,
      files,
      excludedPaths: excluded.sort(compareStrings),
      truncatedExclusionList: excluded.length >= maxExcluded,
      durationMs: Date.now() - started,
      complete: true,
    };
  }
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  if (text.charCodeAt(text.length - 1) !== 10) count++;
  return count;
}
