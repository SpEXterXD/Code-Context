# Testing

Run everything with `npm test` (Vitest, no VS Code required). Run one suite
with `npx vitest run src/path/to/suite.test.ts`. `npm run ci` adds
typecheck, lint, format check, compile, and packaging.

Current counts: **17 suites, 169 tests**, all passing. Counts in this file
were captured from a full run; update them together with the suite table
when adding tests. `scripts/check-docs-sync.ts` verifies these numbers
against a real `vitest run` and fails CI on drift.

## Suite matrix

| Suite (tests) | Module | Conditions exercised |
|---|---|---|
| `shared/text.test.ts` (11) | Identifier normalization | camelCase, PascalCase, snake_case, kebab-case, dotted identifiers; consecutive capitals (`parseHTMLString`); canonical-form equivalence (`RateLimiter` = `rateLimiter`); stopword filtering; total-order comparator |
| `workspace/ignoreRules.test.ts` (11) | Gitignore subset | exact names, directory-only patterns, `*`, `**`, `?`, negation, anchoring, comments, last-match-wins, sensitive defaults (`.env`, `*.pem`, `*.key`), regex metacharacter escaping |
| `workspace/workspaceScanner.test.ts` (7) | Discovery | recursive order, metadata + SHA-256 hashes, NUL-byte binary sniffing, oversized skip, `.gitignore` plus config excludes, test-file naming detection, determinism (identical trees, identical hashes/order) |
| `parser/parsers.test.ts` (15) | TS/JS/JSON/MD parsers | functions, classes with members, interfaces, type aliases, enums; named/default/namespace imports; re-exports; dynamic `import()` literal and non-literal; CJS `require()`; call sites with enclosing symbol; extends/implements; syntax errors recorded without throwing; code-looking comments and strings; duplicate names; 1-based line numbers; JSONC leniency; invalid JSON; Markdown fences hiding headings; registry fallback for unknown extensions |
| `analysis/importResolver.test.ts` (6) | Import resolution | extension omission, `/index` directory files, `.js` to `.ts` mapping, tsconfig `paths` aliases, bare specifiers as external (scoped packages included), UNRESOLVED with reason instead of a guess |
| `domain/graph.test.ts` (7) | Relationship graph | dependents derived from imports, duplicate-edge suppression on re-upsert, stale-edge removal on delete, `dir contains file` edges, hard depth limit on a 10-file chain, termination on cyclic fixtures, deterministic neighbor order, edge filters |
| `index/indexStore.test.ts` (7) | Index store | atomic persist + reload, byte-stable sorted manifest, corrupt manifest rebuilt from entries, corrupt entry dropped without invalidating the index, removal, clear, schema-drift rebuild |
| `application/indexingService.test.ts` (11) | Indexing pipeline | fresh index; second run reuses everything with zero parser invocations and byte-identical store; restart from persisted state; create/edit/rename/delete; stale-record removal after full scan; parser failure tolerance; cancel mid-run leaves committed state; concurrent single-file jobs serialize; A→B→C exact import and call edges; UNRESOLVED import edges; naming-convention test edges; excluded files never indexed |
| `retrieval/retrieval.test.ts` (9) | Retrieval | query analysis (terms, identifier candidates, file hints, quoted phrases); inverted index apply/remove; exact symbol above lexical; graph-derived signals with real reasons; test-of signal; determinism; pinned files survive zero-signal queries; traversal bounded by `maxGraphDepth` |
| `retrieval/retrievalEval.test.ts` (4) | Evaluation set | documented Top-1 for all six eval queries against `demo-project/`; every expected file in Top-5; determinism across repeated evaluation; every explanation verified against a real symbol or graph edge |
| `security/security.test.ts` (15) | Secret scanning, policy, redaction | AWS keys, private key blocks, GitHub/Slack/Google/Stripe/OpenAI-style tokens, JWTs, credentialed URLs (http and database schemes), bearer headers, entropy heuristic, `.env`-style credentials, placeholder filtering, sensitive-path rules, BLOCK/WARN/ALLOW policies, deterministic non-reversible redaction, payload leak gate |
| `context/contextBuilder.test.ts` (12) | Context assembly | byte-identical determinism; budgets never exceeded on a fixture larger than the budget (asserted against the rendered payload); pinned files kept under deprioritization; selection mode with and without expansion; irrelevant files excluded; original line numbers correct in excerpts; adversarial text confined to the REPOSITORY CONTENT section; BLOCK withholds source; WARN redacts values; file and project modes; metadata section contents |
| `application/contextService.test.ts` (6) | Scopes | folder scope restricts source files to the subtree; cross-boundary relationships stay explainable; scope determinism; file scope normalizes onto file mode; stats and security policy hold in scope; empty folder scope equals unscoped output |
| `extension/commands.test.ts` (10) | Command wiring | registration of all commands; right-click Uri vs. active-editor fallback; folder scoping through the UI layer; copy without preview; generate with preview; confirmation toast contents; outside-workspace abort; clipboard failure surfaces as error; palette (no-arg) behavior unchanged; copied payload equals directly built payload |
| `extension/main.test.ts` (26) | Activation audit | real `activate()` against a mocked `vscode`: config wiring, command registration, preview scheme registration, status bar and tree view updates, watcher-driven create/change/delete/rename indexing, events outside the workspace root ignored, background warm-up cancellation, dispose paths |
| `clipboard/clipboard.test.ts` (6) | Clipboard abstraction | exact copy, simulated failure, empty payload, 2 MB payload, Unicode preservation, no VS Code dependency |
| `property/invariants.test.ts` (3) | Invariants (seeded PRNG) | 60-step random create/edit/delete/rename keeps index consistent with disk with no stale records; unchanged files never re-parsed across repeated runs; ignored paths never indexed |

## How to run

```bash
npm test                                      # all suites
npx vitest run src/parser/parsers.test.ts     # one suite
npx vitest                                    # watch mode
npm run ci                                    # typecheck + lint + format + tests + compile + package
```

## ADR to test mapping

| ADR | Guarantee | Enforced by |
|---|---|---|
| 001 Offline-first | No network I/O; no telemetry | `outboundPolicy.ts` module inventory; no HTTP client in `src/` (reviewed per PR; not lint-enforced) |
| 002 Local index storage | Atomic per-entry commits; corruption recovery | `indexStore.test.ts` (atomic reload, manifest rebuild, corrupt entry drop, schema drift); `indexingService.test.ts` (cancel mid-run leaves committed state) |
| 003 Parser abstraction | Registry dispatch; unknown languages degrade | `parsers.test.ts` (registry fallback); `workspaceScanner.test.ts` (generic metadata) |
| 004 Deterministic retrieval | Stable scores and explanations | `retrieval.test.ts` (determinism, signal reasons); `retrievalEval.test.ts` (stable Top-1/Top-5, explanations verified against real symbols and edges); `text.test.ts` (canonical forms) |
| 005 Context budgeting | Budgets never exceeded; graceful degradation | `contextBuilder.test.ts` (oversized fixture, truncation, priority order); `contextService.test.ts` (scope determinism) |
| 006 Security boundary | Secrets withheld or redacted; leak gate fail-closed; injection contained | `security.test.ts` (policies, redaction, leak gate); `contextBuilder.test.ts` (payload byte-absence, adversarial text confined to REPOSITORY CONTENT) |
| 007 Clipboard export | Preview equals clipboard, byte for byte | `clipboard.test.ts` (exact copy); `commands.test.ts` (copied payload equals directly built payload; copy never opens preview) |
| 008 Incremental indexing | Hash-gated re-parses; serialized mutations | `indexingService.test.ts` (zero reparse assertion, restart, concurrent jobs); `invariants.test.ts` (no reparse across random no-op runs) |

## Regression policy

Bugs land as: failing test, fix, passing test, permanent coverage. Bugs
caught this way during development and now regression-locked: store
self-indexing, interior `./` path normalization, call sites in arrow
initializer expressions, dynamic import capture, exact-count regex
boundaries in secret patterns, tf accumulation across symbol names, hub
score inflation, test-local variables polluting exact symbol matches,
trailing punctuation in query terms, file-extension fragments diluting
file-mode queries.

## Not automated here

- E2E inside a real VS Code extension host (`@vscode/test-electron`
  installed, harness not run: requires a VS Code binary download and a
  display). The extension layer is a thin adapter; the domain runs headless.
- Real OS clipboard and real git are mocked by design
  (`ClipboardExporter`, `GitMetadata`).
