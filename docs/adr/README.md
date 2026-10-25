# Architectural Decision Records (ADRs)

This directory documents key architectural decisions, alternatives considered, design trade-offs, and implementation statuses for Offline Code Context Compiler (OCC).

## Duplicate Numbering History

During project development, duplicate sequence numbers were assigned to two pairs of ADRs:
- ADR 005: `005-context-budgeting.md` (Context Budgeting, accepted 2026-09-11) and `005-startup-shard-batching.md` (Startup Shard Batching design, draft 2026-10-25).
- ADR 006: `006-security-boundary.md` (Security Boundary, accepted 2026-09-11) and `006-change-aware-seeds.md` (Change-Aware Seeds, implemented/experimental 2026-10-25).

Per project policy, existing filenames are preserved to maintain link integrity across documentation and commit history. Future ADRs should be numbered starting from ADR 009.

## Index of Decisions

| File | Title | Date | Status | Summary |
|---|---|---|---|---|
| [001-offline-first-architecture.md](001-offline-first-architecture.md) | Offline-First Architecture | 2026-09-11 | Accepted | Zero network sockets; all indexing and context packaging runs on local CPU |
| [002-local-index-storage.md](002-local-index-storage.md) | Local Index Storage | 2026-09-11 | Accepted | Atomic per-entry JSON shards on disk; no binary native database dependencies |
| [003-parser-abstraction.md](003-parser-abstraction.md) | Parser Abstraction & Engine Choice | 2026-09-11 | Accepted | TypeScript compiler API for TS/JS; custom JSON and Markdown parsers; metadata fallback |
| [004-deterministic-retrieval.md](004-deterministic-retrieval.md) | Deterministic Retrieval & Ranking | 2026-09-11 | Accepted | Hybrid scoring combining lexical inverted index with structural graph traversal |
| [005-context-budgeting.md](005-context-budgeting.md) | Context Budgeting & Truncation | 2026-09-11 | Accepted | Multi-budget enforcement (files, tokens, characters, lines) and degradation ladder |
| [005-startup-shard-batching.md](005-startup-shard-batching.md) | Startup Load Shard Batching | 2026-10-25 | Draft (Not Implemented) | Evaluates read-shard batching options to reduce open syscall overhead on large stores |
| [006-security-boundary.md](006-security-boundary.md) | Security Boundary | 2026-09-11 | Accepted | Secret detection patterns, entropy heuristics, redaction, and fail-closed leak gate |
| [006-change-aware-seeds.md](006-change-aware-seeds.md) | Change-Aware Seeds (M4) | 2026-10-25 | Implemented (Experimental, Off by Default) | Seeding retrieval from git diffs; default off due to negative benchmark package recall |
| [007-clipboard-export.md](007-clipboard-export.md) | Clipboard Export & Byte-Exact Preview | 2026-09-11 | Accepted | Direct export to system clipboard with byte-identical preview editor synchronization |
| [008-incremental-indexing.md](008-incremental-indexing.md) | Incremental Indexing Strategy | 2026-09-11 | Accepted | Content-hash gated incremental parsing; debounced and coalesced file watcher events |
