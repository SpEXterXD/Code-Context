# ADR-008: Incremental Indexing Strategy

Date: 2026-09-11 · Status: Accepted

## Context

A single file change must trigger only incremental re-analysis; a full
re-index is reserved for unavoidable cases (schema migration, explicit
rebuild). Concurrency and crash-safety must hold under watcher bursts.

## Decision

- **Content-hash gating**: the scanner hashes every file (SHA-256); a file
  whose hash equals the persisted one is reused, never re-parsed (parser
  invocation count asserted = 0 by tests).
- **Local relationships, derived graph**: each `FileEntry` stores its
  *outgoing* edges only; incoming edges are derived by the in-memory graph on
  upsert. Re-analyzing one file never requires touching other entries.
- **Batch staging**: a full scan parses all changed files first, then stages
  their entries so cross-file edges resolve against the fresh state (two
  files changed together resolve each other), then commits.
- **Single-writer queue**: all mutations (commands + watcher events) funnel
  through one promise chain, so no interleaved half-updates occur.
- **Watcher coalescing**: file events are debounced (600 ms) and coalesced
  per path; rename = sequenced remove + index.
- **Startup**: persisted entries load into memory (graph + inverted index +
  symbol index rebuilt incrementally thereafter via change events).

## Alternatives

- Full re-index on change: O(repo) per save; rejected.
- File-system database triggers: tied to a SQLite backend (see ADR-002).

## Consequences

- After a crash mid-run the on-disk index is the previously committed state;
  the next run reconciles with the scan (extra files removed, changed files
  re-parsed).
