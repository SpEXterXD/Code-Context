# ADR 005: Startup Load Shard Batching

Status: Draft (Design Only, Not Implemented)
Date: 2026-10-25

## Context

During startup `initialize()` on a persisted 5,001-entry store:
The external-packages fix (M3 hardening) removed a quadratic step that accounted for about 24% of the load profile; over three runs on the reference test machine (AMD Ryzen 7 4800H, Node 24, Windows 11), median startup changed from 8,163 ms to 5,465 ms (before: 5,472 to 10,279 ms; after: 4,592 to 9,213 ms). Because before and after ranges overlap, this is not a claimed speedup.

The CPU profile is dominated by `readFileUtf8` (approximately 78% of startup time): ADR-002 persists one JSON file per entry (atomic per-entry writes), so startup performs 5,001 `fs.readFileSync` calls. Per-file open syscall overhead dominates on Windows, not JSON parsing.

## Decision (Design Options)

This ADR designs but does not implement batched read shards. Persisting entries in read shards (for example, groups of approximately 64 entries per shard file, yielding approximately 80 shards for 5,001 entries) while preserving per-entry write semantics was evaluated under two sub-designs:

1. Read-optimized shard with per-entry write journal: Writes remain per-entry by appending a line to a journal and upserting into the active shard lazily. Startup reads only the 80 shard files. A compaction step rewrites shards from the journal when needed.
2. Pure shards with whole-shard rewrite on change: Any entry change rewrites its corresponding shard. This is simpler to implement, but editing a hot file repeatedly rewrites up to 63 unrelated entries, increasing write amplification.

Recommendation: If startup latency requires optimization in the future, implement Design 1 behind the existing `IndexStore` interface.

## Consequences

- If implemented, startup latency on 5,001 files is estimated to drop from approximately 5.5 seconds to under 1 second.
- Design 1 preserves record-level atomicity: the append-only journal ensures every commit is atomic, and torn records are detectable. Shard files serve as a derived cache recoverable by replaying the journal.
- Design 2 weakens atomicity to shard-level atomicity, widening the crash window during hot-file writes.
- Either design requires bumping `STORE_SCHEMA_VERSION` and rebuilding existing index stores.
- Current Status: This design is not implemented. Startup runs in the background and 5.5 seconds is amortized. The stability risk of a dual-format persistence format currently outweighs the latency improvement.
