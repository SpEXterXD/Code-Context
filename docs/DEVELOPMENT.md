# Developer and Contributor Guide

This guide details the development workflows, repository structure, testing infrastructure, quality gates, and extension conventions for Offline Code Context Compiler (OCC).

## Prerequisites and Setup

- Node.js: Version 18 or higher (development and CI verified on Node 20 and Node 24).
- Operating Systems: Supported on Linux, macOS, and Windows.
- Package Manager: `npm` (packaged with Node).
- Git: Standard git CLI.

Clone the repository and install dependencies:

```bash
git clone https://github.com/SpEXterXD/Code-Context.git
cd Code-Context
npm install
```

## Running in VS Code Extension Host

To debug and test the extension interactively:
1. Open the repository root in VS Code.
2. Press `F5` (or select `Run and Debug` -> `Launch Extension`).
3. An Extension Development Host window launches with the extension loaded from source.
4. Open any test workspace in the development host to test indexing, status bar updates, preview generation, and commands.

## NPM Script Reference

| Script | Purpose |
|---|---|
| `npm run typecheck` | Validates TypeScript types across `src/` and `scripts/` using `tsc --noEmit` |
| `npm run lint` | Lints codebase using ESLint with strict boundary rules |
| `npm run format:check` | Checks formatting across TypeScript source files using Prettier |
| `npm test` | Executes the Vitest test suite (27 suites, 292 tests) headlessly |
| `npm run test:watch` | Starts Vitest in interactive watch mode for iterative development |
| `npm run test:docs-sync` | Verifies test count synchronization and runs all documentation gates |
| `npm run check:doc-links` | Gate: Asserts that all relative Markdown links and section anchors resolve |
| `npm run check:ref-docs` | Gate: Asserts that all 20 settings and 16 commands match package.json |
| `npm run check:doc-style` | Gate: Enforces documentation style rules (no banned marketing words, no em dashes) |
| `npm run build:ext` | Bundles `src/extension/main.ts` into `dist/extension.js` via esbuild |
| `npm run compile` | Runs typecheck followed by build:ext |
| `npm run package` | Compiles source and packages the extension into a `.vsix` file using `@vscode/vsce` |
| `npm run smoke:vsix` | Runs clean-profile extension installation and activation test |
| `npm run bench` | Runs synthetic scaling benchmark (20, 500, and 5000 files) |
| `npm run bench:small` | Runs synthetic benchmark capped at 500 files |
| `npm run ci` | Full battery executed by CI: typecheck, lint, format:check, test, docs-sync, compile |
| `npm run eval:build-dataset` | Mined benchmark dataset generation from pinned repositories |
| `npm run eval:retrieval` | Runs retrieval evaluation harness across tuning or holdout splits |
| `npm run eval:fsmonitor-repro` | Executes empirical git fsmonitor execution hazard test |
| `npm run eval:seed-hazard-repro` | Executes empirical diff and textconv execution hazard test |
| `npm run eval:seeds-sim` | Simulates change-aware seed retrieval performance |

## Performance Benchmarks

Performance metrics are measured using synthetic repositories generated in the operating system temporary directory via [scripts/benchmark.ts](../scripts/benchmark.ts).

### Reference Environment
- Source File: [scripts/benchmark.ts](../scripts/benchmark.ts)
- Date: 2026-10-25
- Machine: AMD Ryzen 7 4800H with Radeon Graphics (8 cores, 16 threads), 15 GB RAM, Windows 11 (Windows_NT 10.0.26300)
- Node.js Version: v24.15.0

### Scaling Benchmark Results

| Repository Scale | Initial Index | Incremental Index | Search (3 queries) | Context Generation | Heap Memory |
|---|---|---|---|---|---|
| 20 files | 121 ms | 39 ms (1 file changed) | 4 ms | 32 ms | 31 MB -> 33 MB |
| 500 files | 2,014 ms | 537 ms (25 files changed) | 6 ms | 103 ms | 38 MB -> 43 MB |
| 5,000 files | 18,343 ms | 5,406 ms (250 files changed) | 49 ms | 178 ms | 45 MB -> 129 MB |

### Startup Load Measurement

During milestone M4, profiling revealed a quadratic step during startup index loading that accounted for about 24% of the load profile. We removed this quadratic step. Across three runs on a 5,000-entry store on the reference machine, startup load time changed from 5,472 to 10,279 ms (median 8,163 ms) to 4,592 to 9,213 ms (median 5,465 ms). Because before and after ranges overlap, this is not a claimed speedup. Shard batching is documented as an architectural draft in [ADR-005](adr/005-startup-shard-batching.md).

## Testing Architecture

The test suite contains 27 test files covering 292 tests across four testing categories:

1. Unit Tests: Test AST parsers (`parsers.test.ts`), relevance scoring formulas (`retrieval.test.ts`), token estimators (`text.test.ts`), and secret scanner patterns (`security.test.ts`).
2. Integration Tests: Validate end-to-end context generation (`contextService.test.ts`), index store crash recovery and reconciliation (`indexStore.test.ts`), and git execution hardening (`safeGit.test.ts`).
3. Property-Based Tests: Seeded PRNG stress tests (`src/property/invariants.test.ts`) that execute randomized sequences of file creations, modifications, deletions, and renames to verify index consistency.
4. Contract and Sync Verification:
   - `scripts/check-docs-sync.ts`: Asserts that test counts published in `docs/TESTING.md` and `README.md` match the Vitest JSON reporter output.
   - `scripts/check-doc-links.ts`: Verifies that every Markdown link and anchor resolves to an existing file or heading.
   - `scripts/check-reference-docs.ts`: Confirms that all 20 settings and 16 commands in `package.json` are documented with matching defaults in `docs/CONFIGURATION.md` and `docs/COMMANDS.md`.
   - `scripts/check-doc-style.ts`: Enforces strict documentation voice guidelines.

### Runtime-Assembled Secret Fixtures
To prevent committed test files from containing literal credentials that trigger repository secret scanners, all secret fixtures in tests are assembled at runtime from string fragments.

Verification Command:
Verify that no complete secret-looking literal exists in committed sources using this command:

```bash
git --no-pager grep -nE "AKIA[0-9A-Z]{16}|sk_live_[0-9A-Za-z]{10,}|xox[abp]-[0-9A-Za-z-]{10,}|ghp_[0-9A-Za-z]{30,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY" -- src scripts docs
```

The command must return exit code 1 (zero matches).

## VSIX Smoke Test and Limits

The smoke test (`scripts/smoke-vsix.ts`) validates the packaged extension in an isolated environment using `@vscode/test-electron` (pinned version 3.1.0, published 2026-07-24):
- Creates a clean temporary user data directory and extension directory.
- Installs the packaged `.vsix` archive into the clean environment.
- Launches VS Code headlessly, opening `demo-project`.
- Verifies that the extension activates without errors, registers all 16 commands, and executes `indexWorkspace`.

Stated Limit: The smoke test verifies extension activation and background indexing. It does not generate a context package or write to the system clipboard. Manual verification of context generation remains a required step during releases.

## Continuous Integration

CI runs on GitHub Actions across Ubuntu, macOS, and Windows runners (`.github/workflows/ci.yml`). Every pull request and push to `main` must pass:
1. `npm run typecheck`
2. `npm run lint`
3. `npm run format:check`
4. `npm test`
5. `npm run test:docs-sync`
6. `npm run compile`
7. Packaging into `.vsix` followed by `npm run smoke:vsix` on all three operating systems.

## Ground Rules and Architectural Boundaries

1. Layer Boundaries: Layers below `src/extension/` must never import `vscode`. Domain logic runs in headless Node.
2. Zero Network I/O: No networking modules (`http`, `https`, `net`, `dns`) may be imported in `src/`.
3. Determinism:
   - Output must be a pure function of repository state, configuration, and user task text.
   - No wall-clock timestamps or pseudo-random values may appear in output text.
   - All directory traversals, candidate sets, and postings maps must be sorted stably before consumption.
   - Use POSIX forward slashes for internal paths across all operating systems.
4. TypeScript Strict Mode: Strict type checking is enforced. The `any` type is prohibited by ESLint.

## Commit Message Conventions

This repository follows Conventional Commits:
- `feat:` New features or capabilities.
- `fix:` Bug fixes or correctness corrections.
- `docs:` Documentation additions or updates.
- `test:` Test suite additions or refactoring.
- `chore:` Tooling, workflow, or dependency updates.
- `eval:` Benchmark harness, dataset, or evaluation results updates.

## Checklists for Contributors

### Checklist: Adding a Language Parser
1. Implement the `SourceParser` interface (`src/parser/types.ts`).
2. Provide `supports(filePath: string)` and `parse(content: string, filePath: string)` returning a normalized `ParsedFile`.
3. Register the new parser in `src/parser/parserRegistry.ts`.
4. Add parser fixtures and tests in `src/parser/parsers.test.ts`.
5. Update language support documentation in `README.md` and `docs/USER_GUIDE.md`.

### Checklist: Adding a Retrieval Signal
1. Define the signal identifier in `RankingSignal["kind"]` (`src/retrieval/relevanceScorer.ts`).
2. Assign a deterministic weight constant in `RANKING_WEIGHTS` or `STRUCTURAL_BONUS`.
3. Add human-readable reason formatting in `explainSignals()`.
4. Implement signal extraction logic in `HybridRetriever`.
5. Add unit test assertions in `src/retrieval/retrieval.test.ts`.
6. Document the signal in `docs/RETRIEVAL.md`.

### Checklist: Adding a Configuration Setting
1. Add the configuration property under `contributes.configuration.properties` in `package.json` with type, default, and description.
2. Read the setting in `src/context/contextBudget.ts` or the relevant service.
3. Add the setting to the reference table and detailed section in `docs/CONFIGURATION.md`.
4. Run `npm run check:ref-docs` to verify synchronization.

### Checklist: Adding a Command
1. Register the command ID and title in `contributes.commands` in `package.json`.
2. Add menu placements in `contributes.menus` if applicable.
3. Register the command handler in `src/extension/commands.ts`.
4. Document the command in `docs/COMMANDS.md`.
5. Run `npm run check:ref-docs` to verify synchronization.

## Pull Request Checklist

Before submitting a pull request:
- [ ] Run `npm run ci` locally and ensure all steps pass.
- [ ] Verify that test counts in `docs/TESTING.md` and `README.md` match actual counts.
- [ ] Verify that doc link checks pass (`npm run check:doc-links`).
- [ ] Verify that reference doc checks pass (`npm run check:ref-docs`).
- [ ] Verify that style checks pass (`npm run check:doc-style`).
- [ ] Confirm no secret-looking literals remain in committed files via the git grep check.
- [ ] Keep pull request changes focused on a single concern.
