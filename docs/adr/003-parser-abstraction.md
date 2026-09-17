# ADR-003: Parser Abstraction & Engine Choice (ADR-1 of the spec)

Date: 2026-09-11 · Status: Accepted

## Context

We need imports, exports, symbols, calls, and inheritance for TS and JS;
structure for JSON and Markdown; and metadata for everything else. The
choices also affect large-file performance and maintenance cost.

## Decision

**TypeScript Compiler API** (`typescript` package) for `.ts/.js/.tsx/.jsx`
plus **lightweight purpose-built parsers** for JSON and Markdown, behind a
`SourceParser` interface (`supports()/parse()`) resolved through a
`ParserRegistry`. Unknown languages fall through to a generic metadata-only
parser. Downstream code never depends on a concrete parser.

- TS Compiler API is error-tolerant: malformed files still yield partial
  symbols; parse errors are recorded (`parseError`), never thrown.
- We extract what the compiler gives us exactly: import specifiers (incl.
  `export ... from`, dynamic `import()`, CJS `require()`), named/default
  exports, classes with members, interfaces, type aliases, enums,
  namespaces, top-level functions/consts, heritage clauses, and call sites
  with their enclosing symbol.

## Alternatives

- Tree-sitter (native or WASM): uniform grammars and incremental parsing,
  but a second parser stack (native build risk or WASM loading) whose TS/JS
  grammar is less accurate than the compiler API for import and export
  resolution. Rejected for v1; two stacks cost more than they buy for four
  languages.
- Regex-only parsing: fastest to write, unacceptable accuracy for nested
  classes, re-exports, and generics.

## Trade-offs

- `typescript` is a runtime dependency, bundled by esbuild. The packaged
  VSIX is 1.62 MB total.
- The JSON and Markdown parsers are ours to maintain. They are small and
  tested, including JSONC leniency and fence-aware heading extraction.

## Consequences

- Adding a language = implementing one `SourceParser` + registering it; no
  downstream change (spec §3 requirement).
