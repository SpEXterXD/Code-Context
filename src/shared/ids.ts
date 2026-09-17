import { createHash } from "node:crypto";

/** SHA-256 hex digest of a string (UTF-8) or buffer. */
export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Short deterministic id derived from an arbitrary string. */
export function shortHash(content: string, length = 12): string {
  return sha256Hex(content).slice(0, length);
}

/**
 * Normalizes any path to a POSIX-style, repo-relative form:
 * - backslashes become forward slashes
 * - leading "./" and drive-letter prefixes are stripped
 * - duplicate slashes collapse; "." segments are removed; ".." resolves
 *   lexically (never above the root)
 * Deterministic on all platforms.
 */
export function toPosixPath(p: string): string {
  let out = p.replace(/\\/g, "/");
  // Strip windows drive prefix if a caller accidentally passes an absolute path.
  out = out.replace(/^[A-Za-z]:/, "");
  out = out.replace(/^\/+/, "");
  const segments: string[] = [];
  for (const segment of out.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** File name part of a POSIX path. */
export function baseName(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/** Extension (with dot) of a path, lowercase; "" if none. */
export function extName(p: string): string {
  const base = baseName(p);
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx).toLowerCase();
}

/**
 * Deterministic id for a parsed symbol: derived from content coordinates,
 * never from array position.
 */
export function symbolId(filePath: string, name: string, kind: string, startLine: number): string {
  return `${filePath}#${name}@${kind}:${startLine}`;
}

export function fileNodeId(filePath: string): string {
  return `file:${filePath}`;
}

export function externalNodeId(pkg: string): string {
  return `external:${pkg}`;
}
