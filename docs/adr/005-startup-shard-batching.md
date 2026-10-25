# ADR 005 (DRAFT — not implemented): Startup load shard batching

Status: draft, design only. The M3-hardening milestone removed the O(N²)
external-package re-derivation from startup; what remains is the cost this
ADR would address. **It is not implemented** — this note exists so the
option is designed before anyone reaches for it.

## Problem

`initialize()` on a persisted 5,001-entry store: the external-packages fix
(M3 hardening) removed a quadratic step that accounted for ~24% of the load
profile; median startup on the test machine (Ryzen 7 4800H / Node 24 /
Windows) changed from 8,163 ms to 5,465 ms over 3 runs (before:
5,472-10,279 ms; after: 4,592-9,213 ms; measured 2026-10-25). The CPU profile is dominated by `readFileUtf8`
(≈78%): ADR-002 persists **one JSON file per entry** (atomic per-entry
writes), so startup performs 5,001 `fs.readFileSync` calls — per-file open
syscall overhead dominates on Windows, not JSON parsing.

## Option: batched read shards

Persist entries in **read shards** — e.g. groups of ~64 entries per shard
file (~80 shards for 5,001 entries) — while KEEPING per-entry semantics at
the write path. Two sub-designs:

1. **Read-optimized shard + per-entry write journal.** Writes stay
   per-entry (append a line to a journal + upsert into the current shard
   lazily); startup reads only the shards. A compaction step (rare) rewrites
   shards from the journal. Startup opens ~80 files instead of 5,001.
2. **Pure shards with whole-shard rewrite on change.** Any entry change
   rewrites its shard. Simpler, but a hot file edit rewrites up to 63 other
   entries' JSON each time; write amplification grows with shard size.

Expected effect: startup ≈5.5 s → well under 1 s (23 MB of JSON parses in
~300–500 ms; the rest is per-open overhead). Indexing write cost unchanged
under (1), mildly regressed under (2) for hot files.

## Effect on ADR-002 guarantees (crash safety, atomicity)

ADR-002 today: "one entry = one atomic transaction unit; an entry file is
either fully written or not replaced at all." Consequences per design:

- **Design 1 keeps the guarantee** at the record level: the append-only
  journal makes every commit atomic (a torn final line is detectable and
  dropped, exactly like the eval harness's checkpoint resume). Shard files
  become a **cache** of the journal; corruption of a shard is recoverable by
  replaying the journal (same rebuild path as today's manifest-drift
  rebuild). Cost: two files to reason about, plus a compaction trigger.
- **Design 2 weakens the guarantee** from "entry atomic" to "shard atomic":
  a crash mid-rewrite loses the whole shard's latest state and must fall
  back to the previous shard version (write-to-temp + rename keeps it
  atomic, but a hot-spotted shard is rewritten far more often, widening the
  crash window for co-sharded entries).

Either way `STORE_SCHEMA_VERSION` must bump and old stores rebuild once.

## Recommendation

If startup time matters for adoption, implement **Design 1** (journal +
read shards + compaction) behind the existing `IndexStore` interface, so
`IndexingService` and every test see no API change. Measure with the same
3-run `initialize()` protocol and the fuzzed store tests. Do not implement
before there is a user-visible complaint: the extension indexes in the
background, and 5.5 s is amortized; the correctness risk of a second
persistence format is real and the M2 startup profile already drove one
cheap fix (external packages) worth more than the remaining tail.
