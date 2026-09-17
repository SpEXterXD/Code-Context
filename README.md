# Offline Code Context Compiler (OCC)

A VS Code extension that indexes your workspace locally and compiles structured, token-budgeted, and explainable context packages for external Large Language Models (LLMs). The compiled package is copied to the system clipboard for pasting directly into any LLM chat interface.

The extension is **100% offline**: it contains no embedded AI models, executes zero network requests, and collects zero telemetry. Indexing, ranking, and formatting are strictly deterministic: identical repository state and configuration settings produce byte-identical context packages on every run.

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐     ┌───────────┐
│ Local Workspace │ ──> │ AST & Dependency │ ──> │ Deterministic    │ ──> │ Clipboard │
│ Files           │     │ Graph Indexing   │     │ Hybrid Retrieval │     │ Export    │
└─────────────────┘     └──────────────────┘     └──────────────────┘     └───────────┘
```

---

## Core Principles

- **Zero-Network Guarantee**: All indexing, lexical search, graph traversal, and formatting execute on your local CPU. No data ever leaves your machine.
- **Byte-Level Determinism**: Given the same files and settings, the output context package is reproducible down to the exact byte.
- **Fail-Closed Security**: Integrated secret detection automatically blocks or redacts sensitive keys, tokens, and certificates before clipboard transfer.
- **Explainable Selection**: Every included file specifies why it was chosen (e.g., exact symbol query match, direct dependency, test relation).
- **Enforced Budgets**: Strict token, character, line, and file budgets prevent LLM context window overflow through an automated degradation ladder.

---

## Installation

### From Pre-built VSIX

Using the VS Code CLI:

```bash
code --install-extension offline-code-context-compiler-0.2.0.vsix
```

Or within VS Code:
1. Open the **Extensions** view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
2. Click the `...` menu in the top-right corner of the Extensions view.
3. Select **Install from VSIX...** and choose `offline-code-context-compiler-0.2.0.vsix`.
4. Reload VS Code when prompted.

### From Source

```bash
# Clone the repository
git clone https://github.com/SpEXterXD/Code-Context.git
cd Code-Context

# Install dependencies and compile
npm install
npm run compile

# Package the extension
npm run package
# Produces offline-code-context-compiler-0.2.0.vsix
```

**Requirements**: VS Code `^1.85.0` and Node.js `>=18`.

---

## Quick Start

1. **Automatic Indexing**: Open any folder in VS Code. OCC automatically indexes the repository in the background on startup. The status bar displays `OCC: indexing...` followed by `OCC: <n> files`.
2. **Generate Task Context**: Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`), run **OCC: Generate Task Context**, and enter your prompt (e.g., `Add rate limiting to the login endpoint`).
3. **Inspect Selection**: OCC calculates relevance scores, traverses import/call graphs, enforces budgets, and opens a read-only preview showing the exact payload and file selection rationales.
4. **Copy & Paste**: Run **OCC: Copy Context to Clipboard** (or use the context menu shortcut), then paste directly into your LLM chat.

---

## Command Reference

| Command ID | Title | Palette | Context Menu Access |
|---|---|---|---|
| `offlineCodeContext.indexWorkspace` | OCC: Index Workspace | Yes | — |
| `offlineCodeContext.rebuildIndex` | OCC: Rebuild Index | Yes | — |
| `offlineCodeContext.indexCurrentFile` | OCC: Index Current File | Yes | — |
| `offlineCodeContext.showIndexStatus` | OCC: Show Index Status | Yes | Status Bar click |
| `offlineCodeContext.searchCodebase` | OCC: Search Codebase | Yes | — |
| `offlineCodeContext.generateProjectContext` | OCC: Generate Project Context | Yes | Explorer folder right-click |
| `offlineCodeContext.copyProjectContextToClipboard` | OCC: Copy Project Context to Clipboard | Yes | Explorer folder right-click |
| `offlineCodeContext.generateFileContext` | OCC: Generate File Context | Yes | Editor & Editor Tab right-click |
| `offlineCodeContext.copyFileContextToClipboard` | OCC: Copy File Context to Clipboard | Yes | Editor & Editor Tab right-click |
| `offlineCodeContext.generateTaskContext` | OCC: Generate Task Context | Yes | — |
| `offlineCodeContext.generateSelectionContext` | OCC: Generate Selection Context | Yes | — |
| `offlineCodeContext.previewContext` | OCC: Preview Context | Yes | — |
| `offlineCodeContext.copyContext` | OCC: Copy Context to Clipboard | Yes | — |
| `offlineCodeContext.securityScan` | OCC: Security Scan | Yes | — |
| `offlineCodeContext.clearIndex` | OCC: Clear Local Index | Yes | — |

*Note*: Commands prefixed with `Generate` open the read-only preview editor. Commands prefixed with `Copy` write the payload directly to the clipboard and display a summary notification.

---

## Configuration Reference

Settings are configured under the `offlineCodeContext.*` namespace:

| Setting | Type | Default | Description |
|---|---|---|---|
| `maxFiles` | `integer` | `40` | Maximum number of source files included in a single context package (1–500). |
| `maxChars` | `integer` | `120000` | Maximum total character count for the generated context package (min: 1000). |
| `maxLines` | `integer` | `3000` | Maximum total source lines included across all files (min: 10). |
| `maxTokens` | `integer` | `30000` | Maximum estimated token budget (estimated as characters / 4). |
| `maxCodeLinesPerFile` | `integer` | `400` | Line threshold per file before excerpts degrade to symbol declarations. |
| `maxGraphDepth` | `integer` | `3` | Maximum traversal depth when following dependency and call graphs (1–10). |
| `structureDepth` | `integer` | `4` | Maximum directory tree depth rendered in the project structure overview. |
| `secretPolicy` | `string` | `"block"` | Policy for secret findings: `block` (exclude file), `warn` (redact and include), `allow` (include verbatim). |
| `redactSecrets` | `boolean` | `true` | Deterministically redact detected credentials when `secretPolicy` is set to `warn`. |
| `respectGitignore` | `boolean` | `true` | Honor `.gitignore` patterns during workspace file discovery. |
| `enableGitRecency` | `boolean` | `false` | Apply a deterministic recency boost based on local git modification timestamps. |
| `maxFileSizeBytes` | `integer` | `1048576` | Skip indexing files larger than this threshold (1 MiB default). |
| `excludePatterns` | `array` | *(standard)* | Glob patterns excluded from indexing (`node_modules`, `dist`, `.git`, `.env*`, etc.). |
| `statusBar` | `boolean` | `true` | Display current index status in the VS Code status bar. |

---

## Context Package Wire Format

The compiled output uses a structured plaintext format (`CONTEXT_VERSION: 1`) designed for LLM consumption:

```
# PROJECT CONTEXT
CONTEXT_VERSION: 1

## DEVELOPER TASK
<User task description or active file context>

## PROJECT STRUCTURE
<Ascii tree representation of repository layout up to configured depth>

## RELEVANT ARCHITECTURE
<High-level summary of relevant modules, packages, and components>

## RELEVANT SYMBOLS
<Top matched symbols, signatures, and locations>

## WHY THESE FILES WERE SELECTED
<Tabular audit trail mapping every file to its specific retrieval signal>

## SOURCE
================================================================================
### FILE: path/to/file.ts
[ORIGINAL LINES 1-45]
<Source code or truncated symbol representation>
================================================================================

## CONTEXT METADATA
<Token estimate, file counts, budget usage, and truncation levels>
```

Repository content is strictly encapsulated inside the delimited `## SOURCE` section to ensure separation between system instructions and repository text.

---

## Language Support

| Language / Format | Analysis Level | Extracted Metadata |
|---|---|---|
| **TypeScript / JavaScript** (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cjs`) | Full AST Parsing | Classes, functions, interfaces, methods, imports, exports, call sites, inheritance, and test associations. |
| **JSON / JSONC** (`.json`, `.jsonc`) | Structural Parsing | Top-level keys, nested structure, schemas, line locations. |
| **Markdown** (`.md`) | Document Structure | Heading hierarchy, code-fence languages, and link targets. |
| **Other Text Formats** | Metadata Only | Line counts, file size, content SHA-256 hash. |

---

## Security Architecture

1. **Air-Gapped Operation**: No outbound HTTP/HTTPS sockets or child processes connecting to remote endpoints.
2. **Secret Detection Engine**: Scans file contents against high-entropy patterns and known secret formats (AWS access keys, GitHub tokens, Slack tokens, Google API keys, Stripe keys, OpenAI keys, JWTs, private key blocks).
3. **Automated Redaction**: Secret occurrences under `warn` policy are replaced with deterministic placeholder markers (`[REDACTED:<type>:<hash>]`).
4. **Fail-Closed Leak Verification**: The finalized context payload is scanned one final time before clipboard transfer; any surviving unredacted secret immediately aborts the export.

---

## Development & Verification

### Scripts

```bash
# Typecheck TypeScript sources
npm run typecheck

# Lint with ESLint
npm run lint

# Check code formatting with Prettier
npm run format:check

# Run test suite with Vitest (17 suites, 169 tests)
npm test

# Verify documentation synchronization with test reports
npm run test:docs-sync

# Build the bundled extension
npm run compile

# Run indexing benchmark on synthetic workspace
npm run bench
```

### Testing Suite

The codebase maintains rigorous automated test coverage across 17 test suites and 169 unit/integration/property tests:
- **Unit Tests**: AST parsers, inverted index, relevance scoring, tokenizer, secret redaction, and ignore rules.
- **Integration Tests**: End-to-end context assembly pipeline, budget degradation ladder, and sharded index store crash recovery.
- **Property-Based Invariants**: Deterministic PRNG stress tests verifying index consistency under randomized file edits, renames, and deletions.
- **Contract Verification**: Strict synchronization between documentation assertions and test reporter output (`scripts/check-docs-sync.ts`).

---

## Documentation Index

- [Architecture & Layering](docs/ARCHITECTURE.md)
- [Security Model & Threat Boundaries](docs/SECURITY.md)
- [User Guide & Workflows](docs/USER_GUIDE.md)
- [Testing Guide & Metrics](docs/TESTING.md) (17 suites, 169 tests)
- [Contributing Guidelines](docs/CONTRIBUTING.md)
- [Technical Limitations](docs/LIMITATIONS.md)
- [Architectural Decision Records (ADRs)](docs/adr/)
- [Changelog](CHANGELOG.md)

---

## License

UNLICENSED · Private repository for Offline Code Context Compiler.
