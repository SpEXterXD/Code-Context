# Architecture

Layered design. Dependencies point downward only.

```
VS Code UI (commands, panels, preview, status)     src/extension/
        |
Application services                               src/application/
  IndexingService, OccApplication facade
        |
Repository discovery | Analysis | Retrieval | Context
  src/workspace/      src/parser/  src/retrieval/  src/context/
  src/git/            src/analysis/                src/security/
        |
Local index -> Security filter -> Clipboard        src/index/, src/clipboard/
        |
Domain model and shared utilities                  src/domain/, src/shared/
```

## Dependency rule

Lower layers never import `vscode` or higher layers. `domain/` and
`shared/` import only each other and Node built-ins. `parser/`, `analysis/`,
`index/`, `retrieval/`, `context/`, `security/`, `clipboard/`, `git/`, and
`workspace/` sit at the same tier and may import `domain/` and `shared/`.
`application/` may import any tier below it. `extension/` is the only layer
allowed to import `vscode`.

Enforcement: `eslint-plugin-boundaries` (the `boundaries/dependencies`
rule in `eslint.config.mjs`) fails lint on any import that crosses layers
against the allow list encoded there; importing `vscode` outside
`extension/` fails via `no-restricted-imports`. Test files are exempt
(they exercise several layers by design). The allow list must be extended
explicitly when a layer legitimately gains a new dependency.

Domain logic runs without VS Code, which is what makes the 16 Vitest suites
run headless (see [TESTING.md](TESTING.md)).

## Scanning (`workspace/`)

`WorkspaceScanner` walks the tree with sorted dirents: language
classification by extension, SHA-256 content hashing, line counts, binary
sniffing (NUL bytes, non-printable ratio), oversized-file skip with recorded
status. `IgnoreRules` implements a documented `.gitignore` subset
(negation, directory-only, anchoring, `*`, `**`, `?`) plus configurable
excludes. Excluded paths are recorded for inspection; exclusion is never
silent.

## Parsing (`parser/`)

`ParserRegistry` dispatches on `SourceParser.supports()` and returns a
normalized `ParsedFile` (symbols, imports, exports, calls, heritage,
identifiers, fileSummary, parseError). TypeScript and JavaScript use the
TypeScript Compiler API; JSON and Markdown have purpose-built parsers;
everything else falls through to a metadata-only parser (ADR-003). Parsing
is error-tolerant: failures become `parseStatus: FAILED` records, never
crashes and never silently dropped files.

## Analysis (`analysis/`)

`ImportResolver` resolves relative imports, extension omission, `/index`
files, `.js` to `.ts` mapping, and tsconfig `paths` aliases against the set
of known files. Unresolvable specifiers become `unresolved:<specifier>`
nodes; bare packages become `external:<pkg>` nodes; nothing is guessed.
`AnalysisEngine` computes each file's outgoing edges (imports, symbol
references, calls, extends/implements, tests) with explicit provenance
(`STATIC_EXACT`, `STATIC_HEURISTIC`, `UNRESOLVED`). Incoming edges are
derived by the graph on upsert, so re-analyzing one file never mutates
other entries (ADR-008).

## Graph (`domain/graph.ts`)

Nodes: `file:`, `dir:`, `symbol:`, `external:`, `unresolved:`. Edge kinds:
contains, imports, exports, references, calls, extends, implements, tests,
depends_on. Adjacency lists are sorted; `traverse` and
`traverseBidirectional` enforce a hard depth limit and terminate on cycles
(tested). Retrieval counts only edges that cross a file boundary, so depth
measures file hops.

## Index (`index/`, `application/indexingService.ts`)

Sharded atomic JSON store (ADR-002): one file per indexed entry, written via
temp-file-plus-rename; entries are the source of truth and the manifest is a
derived cache that reconciles on load. The service orchestrates scan, hash
diff, parse of changed files only, staged analysis for cross-file edges,
atomic commit, and in-memory graph updates. All mutations serialize through
a single promise queue; watcher events are debounced and coalesced per path.

## Retrieval (`retrieval/`)

`QueryAnalyzer` (words, identifier candidates, file hints, quoted phrases)
feeds an `InvertedIndex` (field weights: symbol 3.0, path 2.0,
imports/exports 2.0, summary 1.2, identifiers 0.8; sublinear tf; prefix
matching of four or more characters at 0.7 weight). `HybridRetriever`
combines exact symbol match, file-name match, lexical score, capped
structural expansion (dependency 0.6, dependent 0.5, call 0.5, test 0.7,
inheritance 0.6, same-directory 0.2, per-file total capped at 1.0), and
optional git recency. Full formula and constants: ADR-004. Explanations are
derived only from fired signals.

## Context generation (`context/`)

`ContextBuilder` handles the four modes: retrieve, assign tiers
(`contextSelector.ts`, the documented priority policy), security screen,
budgeted truncation ladder (`contextBudget.ts`, ADR-005), and format
(`contextFormatter.ts`, fixed section order, line-numbered excerpts,
versioned header). A degrade loop demotes the lowest-priority file until the
rendered payload fits every budget. `computeIndexVersion` derives
INDEX_VERSION from the sorted path-to-hash map. Scopes (`folder`, `file`)
constrain the candidate set at the retrieval boundary only.

## Security (`security/`)

Sensitive-path check, secret scan (patterns plus Shannon entropy), policy
enforcement (BLOCK default, WARN with deterministic redaction, ALLOW), and
a fail-closed payload verification before preview and copy (ADR-006).

## Extension layer (`extension/`)

`main.ts` (activation and wiring), `commands.ts` (15 commands; VS Code
adaptation only), `statusBar.ts`, `indexStatusView.ts`,
`previewProvider.ts` (byte-exact payload document), `watcherService.ts`
(debounced watcher), `config.ts` (settings to `OccConfig`).

## Determinism rules

- No wall-clock time in output; no `Date` in the payload path.
- All sorts stable and total (score descending, then path ascending).
- No `Map` or `Set` iteration reaches output unsorted.
- IDs and INDEX_VERSION derive from content, not array positions.
- Same repository state plus same config plus same request yields a
  byte-identical payload (test-asserted in `contextBuilder.test.ts`,
  `contextService.test.ts`, and `indexingService.test.ts`).
