import { sha256Hex, toPosixPath } from "../shared/ids";

import type { FileEntry } from "../domain/model";

/** Bump on incompatible changes; see docs/adr/002-local-index-storage.md. */
// v2 (M3/E1): entries gained optional bodyTokens/bodyLength for the body
// lexical field; older stores rebuild so every entry carries body terms.
// v3: secret token filtering in index entries (identifiers, bodyTokens, summary);
// older stores rebuild once so no secret tokens survive in stored shards.
// v4 (F01): structural strings (symbol names/ids, exports, imports, calls,
// parse errors) are sanitized at parse time; older stores rebuild once so
// previously persisted credential-bearing names never survive on disk.
export const STORE_SCHEMA_VERSION = 4;

export interface IndexManifest {
  schemaVersion: number;
  /** Repo fingerprint: workspace root path hash; detects workspace moves. */
  projectFingerprint: string;
  entryCount: number;
  /** path -> content hash, keys sorted at serialization time. */
  files: Record<string, string>;
}

export function emptyManifest(projectFingerprint: string): IndexManifest {
  return { schemaVersion: STORE_SCHEMA_VERSION, projectFingerprint, entryCount: 0, files: {} };
}

/** Deterministic shard (2 hex chars) + unique file name for a repo-relative path. */
export function entryRelativePath(path: string): string {
  const hash = sha256Hex(toPosixPath(path));
  return `entries/${hash.slice(0, 2)}/${hash}.json`;
}

/** Serializes the manifest with sorted file keys for byte-stable output. */
export function serializeManifest(manifest: IndexManifest): string {
  const sortedFiles: Record<string, string> = {};
  for (const key of Object.keys(manifest.files).sort()) {
    sortedFiles[key] = manifest.files[key];
  }
  return `${JSON.stringify(
    { ...manifest, files: sortedFiles, entryCount: Object.keys(sortedFiles).length },
    null,
    2,
  )}\n`;
}

const LANGUAGES = new Set(["typescript", "javascript", "json", "markdown", "generic"]);
const PARSE_STATUSES = new Set([
  "PARSED",
  "PARTIAL",
  "GENERIC",
  "SKIPPED_BINARY",
  "SKIPPED_TOO_LARGE",
  "FAILED",
]);

const isStr = (v: unknown): v is string => typeof v === "string";
const isObjArr = (v: unknown): v is Array<Record<string, unknown>> =>
  Array.isArray(v) && v.every((x) => typeof x === "object" && x !== null);

/**
 * FU5: fail-closed structural validation for entries read from disk. The
 * original load only checked `meta.path` presence, so a hand-edited,
 * partially-corrupt, or foreign entry (bogus parseStatus, non-array
 * collections, absolute or traversal paths) loaded into memory unchecked and
 * flowed into retrieval and context building. Invalid entries are dropped as
 * corrupt — the file re-indexes on the next run.
 */
export function isValidStoredFileEntry(entry: unknown): entry is FileEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  const meta = e.meta as Record<string, unknown> | undefined;
  if (typeof meta !== "object" || meta === null) return false;
  if (!isStr(meta.path) || meta.path.length === 0) return false;
  // Workspace-relative POSIX path only: no absolute, no traversal, no separators.
  if (meta.path.includes("\\") || meta.path.startsWith("/") || /^[a-zA-Z]:/.test(meta.path)) {
    return false;
  }
  if (meta.path.split("/").includes("..")) return false;
  if (!isStr(meta.language) || !LANGUAGES.has(meta.language)) return false;
  if (!isStr(meta.parseStatus) || !PARSE_STATUSES.has(meta.parseStatus)) return false;
  if (!isStr(meta.contentHash) || meta.contentHash.length === 0) return false;
  if (typeof meta.sizeBytes !== "number" || meta.sizeBytes < 0) return false;
  if (typeof meta.lineCount !== "number" || meta.lineCount < 0) return false;
  if (typeof meta.isTest !== "boolean") return false;
  if (meta.parseError !== undefined && !isStr(meta.parseError)) return false;
  // Collections must be present and shaped (empty is valid for FAILED entries).
  if (!isObjArr(e.symbols) || !e.symbols.every((s) => isStr(s.id) && isStr(s.name))) return false;
  if (!isObjArr(e.imports)) return false;
  if (!isObjArr(e.exports)) return false;
  if (!isObjArr(e.calls)) return false;
  if (!isObjArr(e.internalRelations)) return false;
  if (e.fileSummary !== undefined && !isStr(e.fileSummary)) return false;
  if (e.identifiers !== undefined && !Array.isArray(e.identifiers)) return false;
  if (e.identifiers !== undefined && !(e.identifiers as unknown[]).every((t) => isStr(t))) {
    return false;
  }
  if (e.bodyTokens !== undefined) {
    if (!isObjArr(e.bodyTokens)) return false;
    if (!e.bodyTokens.every((t) => isStr(t.term) && typeof t.tf === "number")) return false;
  }
  if (e.bodyLength !== undefined && typeof e.bodyLength !== "number") return false;
  return true;
}
