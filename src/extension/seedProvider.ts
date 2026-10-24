import * as vscode from "vscode";

import { collectGitSeeds } from "../seeds/seedCollector";
import { parseStackTrace, type StackFrame } from "../seeds/stackTrace";
import { emptySeedSet, normalizeSeedSet, type SeedSet } from "../seeds/seedSet";
import { sensitivePathCheck } from "../security/sensitivePathRules";

/**
 * M4 extension-layer seed collection. Builds the domain SeedSet from (a)
 * the git working tree through the hardened collector (trust-gated — never
 * invoked in untrusted workspaces), (b) editor state behind the
 * `seedEditors`/`seedDiagnostics` settings (untuned, OFF by default), and
 * (c) stack frames parsed from the user's clipboard by the
 * `OCC: Seed From Clipboard Stack Trace` command (off by default).
 * Every failure degrades to an (empty) unseeded request with a note.
 */
export interface SeedProviderConfig {
  changeSeeds: boolean;
  changeSeedsMaxPaths: number;
  seedEditors: boolean;
  seedDiagnostics: boolean;
  seedStackTraces: boolean;
  maxFileSizeBytes: number;
}

export interface SeedProviderDeps {
  rootPath: string;
  trusted: boolean;
  config: SeedProviderConfig;
  /** Injectable for tests (defaults to the real safeGit collector). */
  collector?: typeof collectGitSeeds;
  /** Paths present in the index (for stack-frame resolution). */
  indexedPaths?: () => string[];
  /** Injectable clipboard reader for tests. */
  readClipboard?: () => Promise<string>;
}

/** Module-level stack frames captured by the clipboard command (per session). */
let capturedStackFrames: StackFrame[] = [];

/** Command handler body: parse clipboard text into candidate frames. */
export function seedFromClipboardText(text: string, indexedPaths: string[]): StackFrame[] {
  const frames = parseStackTrace(text);
  const indexSet = new Set(indexedPaths);
  const resolve = (raw: string): string | null => {
    const cleaned = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (indexSet.has(cleaned)) return cleaned;
    for (const p of indexedPaths) {
      if (p.endsWith(`/${cleaned}`) || p === cleaned) return p; // relative suffix
      if (cleaned.endsWith(`/${p}`)) return p; // absolute path containing an indexed path
    }
    return null; // outside the workspace or not indexed: ignored
  };
  const out: StackFrame[] = [];
  for (const f of frames) {
    const resolved = resolve(f.path);
    if (resolved) out.push({ path: resolved, line: f.line, source: f.source });
  }
  capturedStackFrames = out;
  return out;
}

export function resetCapturedStackFrames(): void {
  capturedStackFrames = [];
}

function editorSeedSet(config: SeedProviderConfig, rootPath: string): Partial<SeedSet> {
  const rootPosix = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
  const partial: Partial<SeedSet> = {};
  if (config.seedEditors) {
    try {
      const groups = vscode.window.tabGroups?.all ?? [];
      const tabs = groups
        .flatMap((g) => g.tabs)
        .filter((t) => t.input instanceof vscode.TabInputText);
      const paths = tabs
        .map((t) => (t.input as vscode.TabInputText).uri.fsPath.replace(/\\/g, "/"))
        .filter((p) => p.startsWith(`${rootPosix}/`));
      const rel = paths.map((p) => relativeToRoot(p, rootPath));
      partial.openEditors = rel.map((p, i) => ({ path: p, active: i === 0 }));
      const active = vscode.window.activeTextEditor;
      if (active && active.selection && !active.selection.isEmpty) {
        const relPath = relativeToRoot(active.document.uri.fsPath.replace(/\\/g, "/"), rootPath);
        partial.selection = {
          path: relPath,
          startLine: active.selection.start.line + 1,
          endLine: active.selection.end.line + 1,
        };
      }
    } catch {
      /* editor APIs unavailable: degrade to absent */
    }
  }
  if (config.seedDiagnostics) {
    try {
      const all = vscode.languages.getDiagnostics();
      const items: { path: string; message: string }[] = [];
      for (const [uri, diagnostics] of all) {
        for (const d of diagnostics) {
          if (
            d.severity !== vscode.DiagnosticSeverity.Error &&
            d.severity !== vscode.DiagnosticSeverity.Warning
          )
            continue;
          items.push({
            path: relativeToRoot(uri.fsPath.replace(/\\/g, "/"), rootPath),
            message: d.message,
          });
        }
      }
      items.sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message));
      partial.diagnostics = items;
    } catch {
      /* diagnostics unavailable: degrade to absent */
    }
  }
  if (config.seedStackTraces && capturedStackFrames.length > 0) {
    partial.stackFrames = capturedStackFrames;
  }
  return partial;
}

function relativeToRoot(absPosix: string, rootPath: string): string {
  const root = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
  return absPosix.startsWith(`${root}/`) ? absPosix.slice(root.length + 1) : absPosix;
}

export async function collectChangeSeeds(deps: SeedProviderDeps): Promise<SeedSet> {
  const seedSet = emptySeedSet();
  if (!deps.trusted) {
    seedSet.notes.push("git seeds skipped: untrusted workspace");
    return seedSet;
  }
  if (deps.config.changeSeeds) {
    try {
      const collected = await (deps.collector ?? collectGitSeeds)(deps.rootPath, {
        maxPaths: deps.config.changeSeedsMaxPaths,
        maxDiffBytesPerFile: 32 * 1024,
        maxUntrackedContentBytes: deps.config.maxFileSizeBytes,
        isBlockedPath: (p) => sensitivePathCheck(p) !== null,
      });
      seedSet.changedPaths = collected.seedSet.changedPaths;
      seedSet.diffSections = collected.seedSet.diffSections;
      seedSet.notes.push(...collected.seedSet.notes);
      if (collected.unavailableReason) {
        seedSet.notes.push(`git seeds unavailable: ${collected.unavailableReason}`);
      }
    } catch (error) {
      seedSet.notes.push(`git seeds unavailable: ${(error as Error).message.slice(0, 80)}`);
    }
  }
  const editor = editorSeedSet(deps.config, deps.rootPath);
  return normalizeSeedSet({
    ...seedSet,
    ...editor,
    changedPaths: seedSet.changedPaths,
    diffSections: seedSet.diffSections,
    notes: seedSet.notes,
  });
}

/** Clipboard stack-trace command handler (async clipboard read). */
export async function seedFromClipboard(deps: {
  readClipboard: () => Promise<string>;
  indexedPaths: () => string[];
}): Promise<{ count: number }> {
  let text = "";
  try {
    text = await deps.readClipboard();
  } catch {
    return { count: 0 };
  }
  const frames = seedFromClipboardText(text, deps.indexedPaths());
  return { count: frames.length };
}
