# ADR-002: Local Index Storage (ADR-2 of the spec)

Date: 2026-09-11 · Status: Accepted

## Context

The index (file metadata, symbols, relationships) must persist across
restarts, support atomic incremental updates, and survive crashes without
corruption inside the VS Code extension host, whose Node ABI varies by
VS Code and Electron version and by OS.

## Decision

A **sharded JSON KV store** (`JsonIndexStore`):

```
<storeRoot>/manifest.json                 derived cache: path → content hash
<storeRoot>/entries/<2-hex>/<hash>.json   one file = one FileEntry = one transaction
```

- Each entry is written via `write-temp → rename` (atomic per file, with
  Windows EPERM retry and verified in-place fallback).
- **Entries are the source of truth; the manifest is a derived cache.** Any
  inconsistency (crash between entry and manifest writes, corrupt entry,
  schema bump) is repaired at load time by rebuilding or dropping the single
  affected entry. This is a tested code path, not prose.

## Alternatives

- Native SQLite (`better-sqlite3`): the strongest query power, but the
  prebuilt binding must match the exact Electron ABI of every VS Code build,
  a recurring install-time failure mode we cannot control from a VSIX.
  Rejected for v1. The `IndexStore` interface keeps a SQLite backend
  replaceable without touching callers.
- WASM SQLite (`sql.js`): no ABI risk, but the whole database must be
  serialized to persist, which makes per-file incremental commits awkward
  and large indexes memory-heavy.
- **Single JSON file**: atomic via rename, but every single-file watcher
  update rewrites the entire index, O(index) per keystroke debounce.

## Trade-offs

- No SQL queries; aggregations happen in memory. The graph and inverted
  index rebuild from entries at startup in roughly 10 ms per 1,000 files
  (measured, see IMPLEMENTATION_REPORT.md).
- More inodes for large repos; acceptable (one small file per indexed file).

## Consequences

- A crash mid-index leaves the previously committed state valid (tested).
- A kill mid-transaction never yields partial relationship data: an entry is
  either fully replaced or not (tested).
