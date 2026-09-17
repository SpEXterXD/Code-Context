# Contributing

## Setup

```bash
npm install
npm run ci      # typecheck + lint + format:check + tests + compile
```

Node 18+ (CI uses 20; development tested on 20 and 24, Windows/macOS/Linux).

## Ground rules

1. Layer boundaries: `extension/` may import `application/`; `application/`
   may import any lower tier; nothing below `extension/` may import `vscode`.
   Domain logic must run in plain Node; tests rely on it. The rule is
   described in ARCHITECTURE.md and enforced by code review (no lint
   boundary rule yet).
2. Determinism: no wall-clock time, no unsorted iteration reaching output,
   no positional IDs. New output must be reproducible from (repo state,
   config, request) alone.
3. TypeScript strict mode; `any` is an ESLint error. Unsafe casts need a
   comment justifying them.
4. Security invariants: no network imports; finding values never reach logs
   or output; changes to the context pipeline keep the payload leak-gate
   tests green.
5. Tests: new behavior lands with tests; bug fixes land with a failing test
   first (see docs/TESTING.md for the coverage areas and the current suite
   matrix).
6. Dependencies: the only runtime dependency is `typescript`. Do not add
   runtime dependencies without discussing it in an issue first; anything
   that needs a native build is rejected by default (see ADR-002). Dev-only
   tooling additions are fine.

## Workflow

1. Branch from `main`.
2. Make the change with tests.
3. `npm run ci` green.
4. Update docs (ARCHITECTURE.md, ADRs, TESTING.md counts) when behavior or
   architecture changes.
5. Open a PR. CI must pass on all three OS matrices.

## Adding a language

Implement `SourceParser` (`supports()` and `parse()` returning a normalized
`ParsedFile`), register it in `parserRegistry.ts`, and add fixture tests to
`parser/parsers.test.ts`. Nothing downstream changes.

## Adding an ADR

Copy the shape of an existing `docs/adr/*.md` (Context, Decision,
Alternatives, Trade-offs, Consequences), record the rejected alternatives
with reasons, and link it from ARCHITECTURE.md. If a test enforces the
decision, add the mapping row to the ADR table in TESTING.md.
