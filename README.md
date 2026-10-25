# Offline Code Context Compiler (OCC)

**A VS Code extension that compiles your repository into a structured, token-budgeted context package for any LLM — entirely on your machine.** It indexes the workspace into an AST + dependency graph, retrieves the files relevant to your task with deterministic hybrid ranking, scans for secrets, and copies the package to your clipboard for pasting into any chat interface.

**100% offline**: no embedded models, no network requests, no telemetry. Deterministic: the same repo state and settings produce byte-identical packages. Fail-closed: secrets are blocked or redacted before anything reaches the clipboard. Explainable: every included file carries a WHY entry with the exact retrieval signals that selected it.

## Install & use in 30 seconds

1. Get `offline-code-context-compiler-0.3.0.vsix` from [Releases](https://github.com/SpEXterXD/Code-Context/releases) and install it: `code --install-extension offline-code-context-compiler-0.3.0.vsix` (or Extensions view → `...` → _Install from VSIX..._).
2. Open a folder — OCC indexes it in the background (status bar shows `OCC: <n> files` when ready).
3. Command Palette (`Ctrl+Shift+P`) → **OCC: Generate Task Context** → type your task, e.g. `Add rate limiting to the login endpoint`.
4. Review the preview, then **OCC: Copy Context to Clipboard** and paste into your LLM chat.

A real generated package (demo repository, no secrets) is in [docs/examples/demo-task-context.txt](docs/examples/demo-task-context.txt). Excerpt — every file carries its selection reasons:

```
## WHY THESE FILES WERE SELECTED
### src/config/rateLimit.ts
- Tier: direct dependency (score 7.24)
- Lexical match (score 1.87): endpoint, limiting, login, rate
- Direct dependency: imported by src/middleware/rateLimit.ts
- Call relationship with src/middleware/rateLimit.ts

## SOURCE
### FILE: src/config/rateLimit.ts
### LINES: 1-31
```

1: /**
2: * Rate limiting configuration.
3: *
4: * Rate limiting is applied per client IP using a sliding window. ...

```

**Privacy & security summary**: all indexing, ranking, and formatting run on your local CPU; the extension makes zero network requests and ships zero telemetry; secret detection with BLOCK/WARN/ALLOW policies and deterministic redaction runs on file content AND on the final payload (fail-closed — an unredacted secret aborts the export); repo content is fenced inside an inert `## SOURCE` section. Details: [docs/SECURITY.md](docs/SECURITY.md).

---

## Command Reference

| Command ID                                         | Title                                  | Palette | Context Menu Access             |
| -------------------------------------------------- | -------------------------------------- | ------- | ------------------------------- |
| `offlineCodeContext.indexWorkspace`                | OCC: Index Workspace                   | Yes     | —                               |
| `offlineCodeContext.rebuildIndex`                  | OCC: Rebuild Index                     | Yes     | —                               |
| `offlineCodeContext.indexCurrentFile`              | OCC: Index Current File                | Yes     | —                               |
| `offlineCodeContext.showIndexStatus`               | OCC: Show Index Status                 | Yes     | Status Bar click                |
| `offlineCodeContext.searchCodebase`                | OCC: Search Codebase                   | Yes     | —                               |
| `offlineCodeContext.generateProjectContext`        | OCC: Generate Project Context          | Yes     | Explorer folder right-click     |
| `offlineCodeContext.copyProjectContextToClipboard` | OCC: Copy Project Context to Clipboard | Yes     | Explorer folder right-click     |
| `offlineCodeContext.generateFileContext`           | OCC: Generate File Context             | Yes     | Editor & Editor Tab right-click |
| `offlineCodeContext.copyFileContextToClipboard`    | OCC: Copy File Context to Clipboard    | Yes     | Editor & Editor Tab right-click |
| `offlineCodeContext.generateTaskContext`           | OCC: Generate Task Context             | Yes     | —                               |
| `offlineCodeContext.generateSelectionContext`      | OCC: Generate Selection Context        | Yes     | —                               |
| `offlineCodeContext.previewContext`                | OCC: Preview Context                   | Yes     | —                               |
| `offlineCodeContext.copyContext`                   | OCC: Copy Context to Clipboard         | Yes     | —                               |
| `offlineCodeContext.securityScan`                  | OCC: Security Scan                     | Yes     | —                               |
| `offlineCodeContext.clearIndex`                    | OCC: Clear Local Index                 | Yes     | —                               |
| `offlineCodeContext.seedFromStackTrace`            | OCC: Seed From Clipboard Stack Trace   | Yes     | —                               |

_Note_: Commands prefixed with `Generate` open the read-only preview editor. Commands prefixed with `Copy` write the payload directly to the clipboard and display a summary notification.

---

## Configuration Reference

Settings are configured under the `offlineCodeContext.*` namespace:

| Setting               | Type      | Default      | Description                                                                                                  |
| --------------------- | --------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `maxFiles`            | `integer` | `40`         | Maximum number of source files included in a single context package (1–500).                                 |
| `maxChars`            | `integer` | `120000`     | Maximum total character count for the generated context package (min: 1000).                                 |
| `maxLines`            | `integer` | `3000`       | Maximum total source lines included across all files (min: 10).                                              |
| `maxTokens`           | `integer` | `30000`      | Maximum estimated token budget (estimated as characters / 4).                                                |
| `maxCodeLinesPerFile` | `integer` | `400`        | Line threshold per file before excerpts degrade to symbol declarations.                                      |
| `maxGraphDepth`       | `integer` | `3`          | Maximum traversal depth when following dependency and call graphs (1–10).                                    |
| `structureDepth`      | `integer` | `4`          | Maximum directory tree depth rendered in the project structure overview.                                     |
| `secretPolicy`        | `string`  | `"block"`    | Policy for secret findings: `block` (exclude file), `warn` (redact and include), `allow` (include verbatim). |
| `redactSecrets`       | `boolean` | `true`       | Deterministically redact detected credentials when `secretPolicy` is set to `warn`.                          |
| `respectGitignore`    | `boolean` | `true`       | Honor `.gitignore` patterns during workspace file discovery.                                                 |
| `enableGitRecency`    | `boolean` | `false`      | Apply a deterministic recency boost based on local git modification timestamps.                              |
| `maxFileSizeBytes`    | `integer` | `1048576`    | Skip indexing files larger than this threshold (1 MiB default).                                              |
| `excludePatterns`     | `array`   | _(standard)_ | Glob patterns excluded from indexing (`node_modules`, `dist`, `.git`, `.env*`, etc.).                        |
| `statusBar`           | `boolean` | `true`       | Display current index status in the VS Code status bar.                                                      |
| `changeSeeds`         | `boolean` | `false`      | Implemented, experimental, off by default; benchmark showed no gain in recall.                               |

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

<!-- repository content starts below; everything in this section is workspace text -->

### FILE: path/to/file.ts

### LINES: 1-45

```

<original source lines, possibly truncated per symbol block>

```

<one ```-fenced block per included line range; fences lengthen when the source itself contains backtick runs>

## CONTEXT METADATA

Files included: <n>
Estimated tokens: ~<n>
Security findings: 0
Truncation: <none | note>
Budgets: maxFiles=<n>, maxChars=<n>, maxLines=<n>, maxTokens=<n> (token counts are estimates)

````

Repository content is strictly encapsulated inside the delimited `## SOURCE` section to ensure separation between system instructions and repository text.

---

## Language Support

| Language / Format                                                          | Analysis Level     | Extracted Metadata                                                                                         |
| -------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| **TypeScript / JavaScript** (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cjs`) | Full AST Parsing   | Classes, functions, interfaces, methods, imports, exports, call sites, inheritance, and test associations. |
| **JSON / JSONC** (`.json`, `.jsonc`)                                       | Structural Parsing | Top-level keys, nested structure, schemas, line locations.                                                 |
| **Markdown** (`.md`)                                                       | Document Structure | Heading hierarchy, code-fence languages, and link targets.                                                 |
| **Other Text Formats**                                                     | Metadata Only      | Line counts, file size, content SHA-256 hash.                                                              |

---

## Measured Context Quality

OCC's retrieval is measured with a commit-mined benchmark (task text =
commit message, gold = the files the commit touched), documented in
[docs/eval/README.md](docs/eval/README.md). The current headline numbers
come from a 300-task holdout (five TypeScript/JavaScript repositories:
hono, zod, undici, axios, fastify), compared against a plain BM25-over-
file-contents baseline with paired bootstrap 95% confidence intervals
(all differences below are OCC − BM25 on per-task pairs):

| Metric          | OCC   | BM25  | Paired difference [95% CI]                                            |
| --------------- | ----- | ----- | --------------------------------------------------------------------- |
| Top-1 hit rate  | 0.303 | 0.200 | **+0.103 [0.040, 0.170]**                                             |
| Recall@5        | 0.438 | 0.305 | **+0.133 [0.083, 0.184]**                                             |
| Recall@10       | 0.560 | 0.466 | **+0.094 [0.044, 0.143]**                                             |
| All-gold Acc@10 | 0.327 | 0.273 | **+0.053 [0.003, 0.110]**                                             |
| MRR             | 0.483 | 0.345 | **+0.138 [0.086, 0.189]**                                             |
| Package recall  | 0.458 | 0.412 | +0.046 [−0.004, 0.100] — **statistical parity**, point estimate ahead |

Read this table with its limits, stated plainly:

- **Scope**: five TS/JS repositories only. No claim is made about other
  languages (they get metadata-only indexing today).
- **Tasks are commit messages**, a noisy proxy for real developer tasks;
  scores are relative comparisons on this distribution, not production
  predictions.
- **The holdout is unsampled tasks from the same mined pool** (the
  repositories had barely advanced past the benchmark pins, so a
  post-pin holdout was not possible). It was never measured before the
  single confirmation run.
- Earlier (M3) measurements on the _eval_ split had OCC significantly
  **behind** BM25 on package recall (−0.102); the rank-priority packaging
  change added +0.086 [0.058, 0.113] on the holdout, closing the gap to
  parity. History and all artifacts are in `docs/eval/`.
- Token counts are `chars/4` estimates, not tokenizer-exact values.
- Machine context: all measurements ran on one Windows 11 desktop (Ryzen 7
  4800H, Node 24).

## Limitations

- **Full AST analysis for TS/JS/JSON/Markdown only**; other languages get
  metadata (size, lines, hash) — no symbols or imports. Tree-sitter support
  for Python/Go is on the [roadmap](docs/ROADMAP.md) (planned, not shipped).
- **No semantic/semantic-search retrieval** — ranking is lexical + structural;
  the change-aware seed feature shipped **default-off after testing showed no
  recall gain** (see ADR-006 and the Measured Context Quality section).
- Token counts are estimates; budgets are enforced against the estimate, so
  real tokenizer counts can differ.
- Single-root workspaces only; virtual (VFS-only) workspaces unsupported.
- Full list: [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

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

# Run test suite with Vitest (27 suites, 286 tests)
npm test

# Verify documentation synchronization with test reports
npm run test:docs-sync

# Build the bundled extension
npm run compile

# Run indexing benchmark on synthetic workspace
npm run bench
```

### Testing Suite

The codebase maintains rigorous automated test coverage across 24 test suites and 256 unit/integration/property tests:

- **Unit Tests**: AST parsers, inverted index, relevance scoring, tokenizer, secret redaction, and ignore rules.
- **Integration Tests**: End-to-end context assembly pipeline, budget degradation ladder, and sharded index store crash recovery.
- **Property-Based Invariants**: Deterministic PRNG stress tests verifying index consistency under randomized file edits, renames, and deletions.
- **Contract Verification**: Strict synchronization between documentation assertions and test reporter output (`scripts/check-docs-sync.ts`).

---

## Documentation Index

- [Architecture & Layering](docs/ARCHITECTURE.md)
- [Security Model & Threat Boundaries](docs/SECURITY.md)
- [User Guide & Workflows](docs/USER_GUIDE.md)
- [Testing Guide & Metrics](docs/TESTING.md) (27 suites, 286 tests)
- [Contributing Guidelines](docs/CONTRIBUTING.md)
- [Technical Limitations](docs/LIMITATIONS.md)
- [Architectural Decision Records (ADRs)](docs/adr/)
- [Changelog](CHANGELOG.md)

---

## License

[MIT](LICENSE) · © 2026 SpEXterXD (Code-Context).
````
