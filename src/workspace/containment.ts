import * as fs from "node:fs";
import * as path from "node:path";
import { OccError } from "../shared/errors";

/**
 * Stage 3: the ONE shared workspace path/read policy. Every consumer of
 * workspace-relative paths — full discovery, direct/watch indexing, renames,
 * nested ignore handling, and live source export — routes through here so
 * containment decisions cannot drift between them.
 *
 * Two layers:
 *
 * 1. LEXICAL (cheap, no I/O): a relative path is inside the root only when no
 *    segment is exactly "..". A legal file named `..notes.ts` (or any name
 *    beginning with two dots) passes; a real parent segment, absolute paths,
 *    and sibling roots sharing a prefix fail. Platform-native semantics:
 *    Windows compares case-insensitively (path.relative), POSIX does not.
 *
 * 2. PHYSICAL (lstat walk & root binding): discovery never follows links
 *    (readdirSync with withFileTypes reports symlinks/junctions without
 *    following them), so a path containing a link component ANYWHERE between
 *    root and leaf is outside the policy even when its lexical form looks safe —
 *    a linked ancestor directory can point outside the workspace.
 *
 * Root binding:
 *   The workspace root is bound at application/service initialization. Every
 *   physical walk explicitly verifies `rootPath` itself via lstatSync before
 *   walking children: it must exist, be an actual directory, and not be a
 *   symbolic link or Windows junction. Furthermore, root identity (device +
 *   inode / file ID) and canonical realpath are verified so that replacing the
 *   root directory or redirecting ancestor links fails closed before child paths
 *   or file contents are accessed.
 *
 * Platform limits & race semantics (TOCTOU):
 *   Node.js does not expose kernel-level directory-descriptor containment
 *   (e.g., Linux `openat2(2)` with `RESOLVE_BENEATH`, or transactional file
 *   handles on Windows) in its standard `fs` API. Consequently, userland
 *   cannot guarantee atomic immunity against concurrent filesystem mutation
 *   by other local processes between `lstat` checks and `openSync`.
 *   OCC mitigates this through defense-in-depth:
 *   a) Component-by-component `lstatSync` immediately before every read;
 *   b) File descriptor verification (`fstatSync` on the opened fd ensures
 *      regular file status and size bounds);
 *   c) Bounded reads with byte-length checks to detect growth or truncation.
 *   We do not claim stronger atomic race immunity than Node.js and the OS
 *   filesystem provide.
 */

let activeLstatSync: typeof fs.lstatSync = fs.lstatSync;
let activeReaddirSync: typeof fs.readdirSync = fs.readdirSync;
let activeFstatSync: typeof fs.fstatSync = fs.fstatSync;
let activeOpenSync: typeof fs.openSync = fs.openSync;

/** Test seam: override lstatSync when testing environments cannot create physical symlinks. */
export function setCustomLstatSync(fn: typeof fs.lstatSync | null): void {
  activeLstatSync = fn ?? fs.lstatSync;
}

/** Test seam: override readdirSync when testing environments cannot create physical symlinks. */
export function setCustomReaddirSync(fn: typeof fs.readdirSync | null): void {
  activeReaddirSync = fn ?? fs.readdirSync;
}

/** Test seam: override fstatSync to simulate concurrent modifications like file growth between stat and read. */
export function setCustomFstatSync(fn: typeof fs.fstatSync | null): void {
  activeFstatSync = fn ?? fs.fstatSync;
}

/** Test seam: override openSync to observe file opens without mutating Node internals. */
export function setCustomOpenSync(fn: typeof fs.openSync | null): void {
  activeOpenSync = fn ?? fs.openSync;
}

export { activeReaddirSync, activeLstatSync, activeFstatSync, activeOpenSync };

export interface BoundWorkspaceRoot {
  readonly rootPath: string;
  readonly canonicalPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly ancestors: ReadonlyArray<{ path: string; dev: number; ino: number; isLink: boolean }>;
}

export function isBoundWorkspaceRoot(root: unknown): root is BoundWorkspaceRoot {
  return (
    typeof root === "object" &&
    root !== null &&
    "rootPath" in root &&
    "canonicalPath" in root &&
    "dev" in root &&
    "ino" in root
  );
}

/**
 * Binds a workspace root at service/application startup. Records its device,
 * inode, realpath, and ancestor directory identities so subsequent operations can
 * prove they are still accessing the same physical directory structure.
 */
export function bindWorkspaceRoot(rootPath: string): BoundWorkspaceRoot {
  const absRoot = path.resolve(rootPath);
  let rootStat: fs.Stats;
  try {
    rootStat = activeLstatSync(absRoot);
  } catch {
    throw new OccError("CONTAINMENT_VIOLATION", `Workspace root does not exist: ${rootPath}`);
  }
  if (rootStat.isSymbolicLink()) {
    throw new OccError(
      "CONTAINMENT_VIOLATION",
      `Workspace root cannot be a symlink or junction: ${rootPath}`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new OccError("CONTAINMENT_VIOLATION", `Workspace root must be a directory: ${rootPath}`);
  }

  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync.native(absRoot);
  } catch {
    throw new OccError(
      "CONTAINMENT_VIOLATION",
      `Cannot resolve workspace root realpath: ${rootPath}`,
    );
  }

  const ancestors: Array<{ path: string; dev: number; ino: number; isLink: boolean }> = [];
  let curr = path.dirname(absRoot);
  while (true) {
    try {
      const aStat = activeLstatSync(curr);
      ancestors.push({
        path: curr,
        dev: aStat.dev,
        ino: aStat.ino,
        isLink: aStat.isSymbolicLink(),
      });
    } catch {
      throw new OccError("CONTAINMENT_VIOLATION", `Cannot inspect ancestor directory: ${curr}`);
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  return {
    rootPath: absRoot,
    canonicalPath,
    dev: rootStat.dev,
    ino: rootStat.ino,
    ancestors,
  };
}

/**
 * Verifies that the workspace root directory and its ancestors remain identical
 * to the original directory bound at startup. Fails closed on any replacement or link redirection.
 */
export function verifyRootIdentity(root: BoundWorkspaceRoot): boolean {
  try {
    const currentStat = activeLstatSync(root.rootPath);
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      return false;
    }
    if (currentStat.dev !== root.dev || currentStat.ino !== root.ino) {
      return false;
    }

    const currentCanonical = fs.realpathSync.native(root.rootPath);
    const canonicalMatches =
      process.platform === "win32"
        ? currentCanonical.toLowerCase() === root.canonicalPath.toLowerCase()
        : currentCanonical === root.canonicalPath;
    if (!canonicalMatches) {
      return false;
    }

    for (const ancestor of root.ancestors) {
      const aStat = activeLstatSync(ancestor.path);
      if (aStat.isSymbolicLink() !== ancestor.isLink) {
        return false;
      }
      if (aStat.dev !== ancestor.dev || aStat.ino !== ancestor.ino) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

export type ContainmentResult =
  | { ok: true; validatedPath: string }
  | {
      ok: false;
      reason:
        | "traversal"
        | "symlink-component"
        | "missing"
        | "not-regular-file"
        | "root-identity-violation";
    };

/** LEXICAL check: only an actual ".." segment is traversal (..notes.ts is a legal name). */
export function hasTraversalSegment(rel: string): boolean {
  return rel.split(/[\\/]/).includes("..");
}

/** LEXICAL check for user/caller-supplied paths before any filesystem use. */
export function isLexicallyInsideRoot(rootPath: string, candidatePath: string): boolean {
  const rel = path.relative(rootPath, candidatePath);
  if (rel.length === 0) return false; // the root itself is not a file
  if (path.isAbsolute(rel)) return false;
  return !hasTraversalSegment(rel);
}

/**
 * PHYSICAL check: validates relative input, verifies root binding, and
 * lstat-walks every component of `rel` under `rootPath`.
 *
 * - `requireLeafFile`: the leaf must exist and be a regular file (reads).
 *   Without it, a missing leaf is acceptable (eligibility probes), and an
 *   empty relative path `""` or `"."` represents a valid root-folder scope.
 *
 * Uses native path representation:
 * - On Windows, `/` and `\` are both recognized as separators.
 * - On POSIX, only `/` is a separator; `\` is treated as a literal character in the name.
 *
 * Returns `{ ok: true, validatedPath }` so that the EXACT same path validated
 * during the component walk is opened by reader functions.
 */
export function checkComponentLinks(
  root: string | BoundWorkspaceRoot,
  rel: string,
  options: { requireLeafFile?: boolean; pathImpl?: typeof path } = {},
): ContainmentResult {
  const rootPath = isBoundWorkspaceRoot(root) ? root.rootPath : root;
  const p = options.pathImpl ?? path;
  const isWin32 = p.sep === "\\";

  // 1. Validate relative input before walking.
  if (p.isAbsolute(rel)) return { ok: false, reason: "traversal" };

  // Segment splitting according to platform path rules:
  const segments = isWin32
    ? rel.split(/[\\/]/).filter((s) => s.length > 0 && s !== ".")
    : rel.split("/").filter((s) => s.length > 0 && s !== ".");

  if (segments.includes("..")) return { ok: false, reason: "traversal" };

  const validatedPath = p.join(rootPath, ...segments);

  const fromRoot = p.relative(rootPath, validatedPath);
  if (p.isAbsolute(fromRoot) || hasTraversalSegment(fromRoot)) {
    return { ok: false, reason: "traversal" };
  }

  // 2. Verify root binding:
  if (isBoundWorkspaceRoot(root)) {
    if (!verifyRootIdentity(root)) {
      return { ok: false, reason: "root-identity-violation" };
    }
  } else {
    let rootStat: fs.Stats;
    try {
      rootStat = activeLstatSync(rootPath);
    } catch {
      return { ok: false, reason: "missing" };
    }
    if (rootStat.isSymbolicLink()) return { ok: false, reason: "symlink-component" };
    if (!rootStat.isDirectory()) return { ok: false, reason: "missing" };
  }

  // Root folder scope: "" or "."
  if (segments.length === 0) {
    if (options.requireLeafFile) return { ok: false, reason: "not-regular-file" };
    return { ok: true, validatedPath };
  }

  // 3. Walk each component from root down.
  let current = rootPath;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    current = p.join(current, seg);
    let stat: fs.Stats;
    try {
      stat = activeLstatSync(current);
    } catch {
      if (options.requireLeafFile || i < segments.length - 1) {
        return { ok: false, reason: "missing" };
      }
      return { ok: true, validatedPath };
    }
    if (stat.isSymbolicLink()) return { ok: false, reason: "symlink-component" };
    if (i === segments.length - 1 && options.requireLeafFile && !stat.isFile()) {
      return { ok: false, reason: "not-regular-file" };
    }
  }

  return { ok: true, validatedPath };
}

export interface BoundedReadResult {
  ok: true;
  buffer: Buffer;
  sizeBytes: number;
}

export type BoundedReadFailure =
  | { ok: false; reason: "too-large"; sizeBytes: number }
  | {
      ok: false;
      reason:
        | "missing"
        | "containment-violation"
        | "not-regular-file"
        | "root-identity-violation"
        | "io-error";
    };

/**
 * Reads a workspace-relative file after enforcing containment, root binding,
 * and size bounds. Uses the exact native path validated by checkComponentLinks.
 * Bounded read detects growth beyond maxBytes and derives size/hash from the same buffer.
 */
export function readBoundedFileResult(
  root: string | BoundWorkspaceRoot,
  relPath: string,
  maxBytes: number = 1024 * 1024,
  options?: { pathImpl?: typeof path },
): BoundedReadResult | BoundedReadFailure {
  const containment = checkComponentLinks(root, relPath, {
    requireLeafFile: true,
    pathImpl: options?.pathImpl,
  });
  if (!containment.ok) {
    if (containment.reason === "missing") return { ok: false, reason: "missing" };
    if (containment.reason === "root-identity-violation")
      return { ok: false, reason: "root-identity-violation" };
    if (containment.reason === "not-regular-file") return { ok: false, reason: "not-regular-file" };
    return { ok: false, reason: "containment-violation" };
  }

  const fullPath = containment.validatedPath;
  let fd: number;
  try {
    fd = activeOpenSync(fullPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return { ok: false, reason: "io-error" };
  }

  try {
    const stat = activeFstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: "not-regular-file" };
    if (stat.size > maxBytes) {
      return { ok: false, reason: "too-large", sizeBytes: stat.size };
    }

    const buf = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buf.length) {
      const chunk = fs.readSync(fd, buf, bytes, buf.length - bytes, bytes);
      if (chunk === 0) break;
      bytes += chunk;
    }

    if (bytes > maxBytes) {
      return { ok: false, reason: "too-large", sizeBytes: bytes };
    }

    return {
      ok: true,
      buffer: buf.subarray(0, bytes),
      sizeBytes: bytes,
    };
  } catch {
    return { ok: false, reason: "io-error" };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore close errors */
    }
  }
}

/**
 * Reads a workspace-relative file within `rootPath` after enforcing containment
 * and size bounds. Returns null on any failure.
 */
export function readBoundedBuffer(
  root: string | BoundWorkspaceRoot,
  relPath: string,
  maxBytes: number = 1024 * 1024,
  options?: { pathImpl?: typeof path },
): Buffer | null {
  const result = readBoundedFileResult(root, relPath, maxBytes, options);
  return result.ok ? result.buffer : null;
}

/**
 * UTF-8 wrapper around `readBoundedBuffer`. Returns null if reading fails
 * or violates containment.
 */
export function readBoundedFile(
  root: string | BoundWorkspaceRoot,
  relPath: string,
  maxBytes: number = 1024 * 1024,
  options?: { pathImpl?: typeof path },
): string | null {
  const buf = readBoundedBuffer(root, relPath, maxBytes, options);
  return buf ? buf.toString("utf8") : null;
}
