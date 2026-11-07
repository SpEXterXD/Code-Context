import * as path from "node:path";

/**
 * FU7: workspace-relative path resolution for the extension layer. The
 * original code sliced `uri.fsPath` after a case-SENSITIVE `startsWith` on
 * the raw fsPath strings — on Windows a drive-letter or path-casing mismatch
 * between the editor URI and the workspace folder (`C:\repo` vs `c:\repo`,
 * mixed-case directory names from different API surfaces) silently produced
 * "no active file", "outside the workspace", or dropped watcher events.
 *
 * `path.relative` compares case-insensitively per platform (win32 semantics),
 * and a `..` result unambiguously means "outside the root". Returns a
 * POSIX-relative path, or null when the path is outside the workspace root.
 */
export function relativeToRoot(rootFsPath: string, fsPath: string): string | null {
  const rel = path.relative(rootFsPath, fsPath);
  // Outside the root: traversal result, absolute result, or empty (root itself).
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel.length === 0) return null;
  return rel.replace(/\\/g, "/");
}

/** True when fsPath is inside rootFsPath (case-tolerant on Windows). */
export function isInsideRoot(rootFsPath: string, fsPath: string): boolean {
  return relativeToRoot(rootFsPath, fsPath) !== null;
}
