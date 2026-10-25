# Technical Limitations

This document lists the technical boundaries and known limitations of Offline Code Context Compiler (OCC) as of version 0.3.1.

## Language and Analysis Depth

1. TypeScript and JavaScript Focus: Full AST parsing and symbol relationship extraction are implemented exclusively for TypeScript and JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cjs`), plus structural parsing for JSON (`.json`, `.jsonc`) and Markdown (`.md`).
2. Other Languages Metadata-Only: Files in Python, Go, Rust, C/C++, Java, and other languages are indexed with metadata only (file path, line count, file size, content SHA-256 hash). Call graphs, symbol declarations, and imports are not extracted for these formats.
3. Static Analysis Scope: Analysis does not evaluate runtime reflection, dynamic imports (`import(variable)`), dependency injection containers, or monkey-patching. Dynamic imports are recorded with unresolved status.
4. Call Graph Heuristics: Call relationships are resolved to local symbols or verified imports (`STATIC_EXACT`). Unique global export name matches are categorized as `STATIC_HEURISTIC`. Overloaded signatures, indirect invocations via `apply`/`call`, and duck typing are unmodeled.
5. Test File Association: Test relationships are derived from file naming conventions (such as `<name>.test.<ext>` or `tests/<name>.<ext>`) with `STATIC_HEURISTIC` provenance.

## Retrieval and Ranking

1. Lexical and Structural Only: Retrieval relies on tokenized lexical matches and structural dependency graph expansion. Semantic vector embeddings and neural search models are not included. Queries expressing abstract goals without matching domain vocabulary may fail to retrieve distant implementation files.
2. Coordinate and Prefix Matches: Prefix matching (length >= 4 characters) can return files sharing common prefixes with query terms. Term frequency damping and IDF scaling mitigate but do not eliminate this behavior.
3. Git Recency Dependency: Git recency scoring requires local git history. In untrusted workspaces or environments without git, recency scoring is automatically disabled.
4. Startup Load on Large Repositories: On a 5,000-entry index store on the reference machine (AMD Ryzen 7 4800H, Windows 11, Node 24), startup load reads 5,001 separate JSON shard files. We removed a quadratic step that accounted for about 24% of the load profile; over three runs on one machine, median startup changed from 8,163 ms to 5,465 ms (before: 5,472 to 10,279 ms; after: 4,592 to 9,213 ms). Because before and after ranges overlap, this is not a claimed speedup. Shard batching is designed as a draft option (ADR-005) but is not implemented.

## Context Packaging and Token Estimation

1. Token Count Estimates: Token counts are estimated using the ratio of 4 characters per token (`chars / 4`). Actual tokenizer counts (such as OpenAI cl100k_base or Anthropic Claude tokenizers) typically vary by 10 to 25 percent depending on code indentation and syntax density.
2. Truncation Ladder: When budgets are tight, files degrade along the truncation ladder (full file, symbol blocks, declarations, metadata only). Metadata-only entries indicate the file was considered by the retriever but could not fit within budget limits.

## Security and Git Boundaries

1. Heuristic Secret Detection: Secret scanning relies on regex patterns and Shannon entropy heuristics. Novel credential formats, short passwords, split tokens, and custom authentication headers can pass undetected. Developers must inspect the context preview before pasting packages into external services.
2. Secret Filtering Scope in Index: Token filtering blanks credentials flagged by the secret scanner before extracting index tokens. Unflagged strings (such as low-entropy credentials) remain tokenized, and word-like fragments such as key-type prefixes (`AKIA`, `sk_live`) remain in index shards.
3. Git Ignore Subset: OCC supports a deterministic subset of `.gitignore` syntax (wildcards, directory anchoring, negation). Exotic gitignore patterns may not evaluate identically to native git.

## Environment and Platform

1. Single-Root Workspaces Only: OCC operates on single-root workspaces. In multi-root configurations, only the primary root directory is indexed.
2. Virtual Workspaces Unsupported: OCC requires direct local filesystem access (`vscode.workspace.fs` with file schemes). Virtual filesystems and remote virtual file providers are unsupported.
3. Windows Antivirus Interference: On Windows, atomic file replacement uses temporary files and rename calls. In rare instances where antivirus scanners lock newly written temporary files, file replacement falls back to verified in-place writes.
