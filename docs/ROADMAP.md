# Project Roadmap

This document outlines planned improvements and experimental features for Offline Code Context Compiler (OCC). Features marked experimental or off by default are explicitly identified.

## Change-Aware Context: Implemented, Experimental, Off by Default

Change-aware seeds are implemented, experimental, and off by default. Seed simulation benchmarks showed no gain in package recall on the tuning split (see [ADR-006](adr/006-change-aware-seeds.md) and [docs/eval/README.md](eval/README.md)).

When enabled by the developer (`offlineCodeContext.changeSeeds: true`), retrieval is seeded from the active working state:
- Working-tree modifications: Staged and unstaged files gathered via `safeGit`, formatted into the optional `## CURRENT CHANGES` section.
- Editor state: Files open in active editor tabs and current editor selections (`offlineCodeContext.seedEditors`).
- Diagnostics: Files displaying compiler diagnostics in the problems panel (`offlineCodeContext.seedDiagnostics`).
- Stack traces: File locations captured from clipboard stack traces (`offlineCodeContext.seedStackTraces`).

Slot Policy: The implementation uses a `signal-only` policy where seeds supply retrieval signals and graph neighbors but do not pin package content slots.

## Wire Format v2: Planned (Not Shipped)

A planned update to the context package format:
- Task repetition: Developer task restated at both opening and closing of the context payload.
- Omitted files section: Structured list of ranked candidates that could not fit within configured token budgets.
- Repository conventions: Automated extraction of package scripts, test runners, and developer instructions.
- Fine-grained symbol slicing: Emitting symbol implementations while truncating uncalled companion methods.

## Additional Language Parsers: Planned (Not Shipped)

Integration of WebAssembly Tree-sitter parsers to support full AST analysis and symbol extraction for additional languages:
- Python (`.py`)
- Go (`.go`)
- Rust (`.rs`)
- Java (`.java`)

Currently, files in these languages receive metadata-only indexing (line counts, file size, content SHA-256 hash). See [docs/LIMITATIONS.md](LIMITATIONS.md).

## Headless CLI and MCP Server: Planned (Not Shipped)

A standalone command-line interface and Model Context Protocol (MCP) stdio server wrapping the domain engine:
- Operates headlessly without requiring a running VS Code instance.
- Produces byte-identical packages for identical repository commits, settings, and task inputs.
- Preserves full offline execution and zero-network security guarantees.

---

Roadmap items are plans, not commitments.
