import * as fs from "node:fs";
import * as path from "node:path";

import { sha256Hex, toPosixPath } from "../shared/ids";
import { compareStrings } from "../shared/text";
import type { CancellationSignal } from "../shared/cancellation";
import { checkCancelled } from "../shared/cancellation";
import { IgnoreRules } from "./ignoreRules";
import { DEFAULT_EXCLUDES } from "./ignoreRules";
import { detectLanguage, isTestFile, looksBinary } from "./languageDetection";

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
}

export interface ScanOptions {
  excludePatterns?: string[];
  respectGitignore?: boolean;
  maxFileSizeBytes?: number;
  /** Maximum number of excluded paths to record for inspectability. */
  maxRecordedExclusions?: number;
}

/** Builds the effective ignore rule set for a root (defaults + config + .gitignore). */
export function buildIgnoreRules(rootPath: string, options: ScanOptions): IgnoreRules {
  const rules = new IgnoreRules([...DEFAULT_EXCLUDES, ...(options.excludePatterns ?? [])]);
  if (options.respectGitignore !== false) {
    try {
      rules.addGitignoreContent(fs.readFileSync(path.join(rootPath, ".gitignore"), "utf8"));
    } catch {
      /* no root .gitignore: fine */
    }
  }
  return rules;
}

/**
 * Recursive workspace discovery. Deterministic: identical trees produce
 * byte-identical scan results (sorted paths, stable hashes).
 */
export class WorkspaceScanner {
  constructor(private readonly options: ScanOptions = {}) {}

  scan(rootPath: string, cancellation: CancellationSignal): ScanResult {
    const started = Date.now();
    const rules = buildIgnoreRules(rootPath, this.options);
    const files: DiscoveredFile[] = [];
    const excluded: string[] = [];
    const maxExcluded = this.options.maxRecordedExclusions ?? 200;
    const maxSize = this.options.maxFileSizeBytes ?? 1024 * 1024;
    let iteration = 0;

    const visit = (absoluteDir: string, relDir: string): void => {
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(absoluteDir, { withFileTypes: true });
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
            try {
              const nested = fs.readFileSync(path.join(absolutePath, ".gitignore"), "utf8");
              rules.addGitignoreContent(nested);
            } catch {
              /* none */
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
        let stat: fs.Stats;
        try {
          stat = fs.statSync(absolutePath);
        } catch {
          continue;
        }
        if (stat.size > maxSize) {
          files.push({
            path: toPosixPath(relPath),
            absolutePath,
            sizeBytes: stat.size,
            lineCount: 0,
            contentHash: `skipped-too-large:${stat.size}`,
            language: detectLanguage(toPosixPath(relPath)),
            isTest: isTestFile(toPosixPath(relPath)),
            status: "SKIPPED_TOO_LARGE",
          });
          continue;
        }
        let content: Buffer;
        try {
          content = fs.readFileSync(absolutePath);
        } catch {
          continue;
        }
        if (looksBinary(content.toString("latin1"))) {
          files.push({
            path: toPosixPath(relPath),
            absolutePath,
            sizeBytes: stat.size,
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
          sizeBytes: stat.size,
          lineCount: countLines(text),
          contentHash: sha256Hex(content),
          language: detectLanguage(toPosixPath(relPath)),
          isTest: isTestFile(toPosixPath(relPath)),
          status: "OK",
        });
      }
    };

    visit(rootPath, "");
    files.sort((a, b) => compareStrings(a.path, b.path));
    return {
      rootPath,
      files,
      excludedPaths: excluded.sort(compareStrings),
      truncatedExclusionList: excluded.length >= maxExcluded,
      durationMs: Date.now() - started,
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
