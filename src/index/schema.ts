import { sha256Hex, toPosixPath } from "../shared/ids";

/** Bump on incompatible changes; see docs/adr/002-local-index-storage.md. */
export const STORE_SCHEMA_VERSION = 1;

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
