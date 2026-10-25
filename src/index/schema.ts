import { sha256Hex, toPosixPath } from "../shared/ids";

/** Bump on incompatible changes; see docs/adr/002-local-index-storage.md. */
// v2 (M3/E1): entries gained optional bodyTokens/bodyLength for the body
// lexical field; older stores rebuild so every entry carries body terms.
// v3: secret token filtering in index entries (identifiers, bodyTokens, summary);
// older stores rebuild once so no secret tokens survive in stored shards.
export const STORE_SCHEMA_VERSION = 3;

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
