import * as path from "node:path";

/**
 * FU7/review: workspace-relative path resolution for the extension layer.
 * The original code sliced `uri.fsPath` after a case-SENSITIVE `startsWith`
 * on the raw fsPath strings — on Windows a drive-letter or path-casing
 * mismatch between the editor URI and the workspace folder (`C:\repo` vs
 * `c:\repo`, mixed-case directory names from different API surfaces)
 * silently produced "no active file", "outside the workspace", or dropped
 * watcher events.
 *
 * Semantics (path.relative based, so Windows comparison is case-insensitive
 * and POSIX comparison is case-sensitive — platform-native, never forced):
 * - inside the root → POSIX-relative path; the ROOT ITSELF returns ""
 *   (an explicit empty string, so the root folder is a valid folder scope —
 *   distinct from `null`, which always means "outside the root")
 * - only an actual `..` PATH SEGMENT means traversal; a legal file named
 *   `..notes.ts` is not rejected
 */
export function relativeToRoot(rootFsPath: string, fsPath: string): string | null {
  return relativeToRootWith(path, rootFsPath, fsPath);
}

/**
 * Test seam: the same semantics exercised against an explicit path
 * implementation (e.g. `path.win32` on a POSIX CI runner), so platform
 * behavior is tested on every platform instead of only where CI happens
 * to run.
 */
export function relativeToRootWith(
  pathImpl: Pick<typeof path, "relative" | "isAbsolute">,
  rootFsPath: string,
  fsPath: string,
): string | null {
  const rel = pathImpl.relative(rootFsPath, fsPath);
  // Outside the root: traversal result, absolute result, or empty (root itself).
  if (rel.length === 0) return ""; // the root itself is a valid (folder) scope
  if (pathImpl.isAbsolute(rel)) return null;
  // Only an actual '..' SEGMENT is traversal — '..notes.ts' is a legal name.
  const segments = rel.split(/[\\/]/);
  if (segments.includes("..")) return null;
  return rel.replace(/\\/g, "/");
}

/** True when fsPath is inside rootFsPath (platform-native comparison). */
export function isInsideRoot(rootFsPath: string, fsPath: string): boolean {
  return relativeToRoot(rootFsPath, fsPath) !== null;
}
