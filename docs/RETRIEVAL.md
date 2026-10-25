# Retrieval and Ranking Architecture

Offline Code Context Compiler (OCC) selects files for a context package using deterministic hybrid retrieval. The retrieval engine combines lexical matching over inverted index fields, exact symbol matching, and structural graph traversal over dependencies, calls, and tests.

## Candidate Sources

The candidate pool is gathered from three distinct entry points:
1. Lexical and Symbol Matches: Files returned by the inverted index for terms extracted from the developer query, file path, or task description.
2. Seed Files: Explicit seed files provided via active editor focus, directory scoping, or change-aware seeds (when enabled).
3. Structural Graph Neighbors: Direct dependencies (imports), dependents (importers), callers, callees, naming-convention tests, and inheritance relationships discovered by traversing the relationship graph up to `offlineCodeContext.maxGraphDepth` (default 3).

## Field Weights in Inverted Index

Lexical scoring uses an in-memory inverted index (`InvertedIndex`). Terms are mapped to files with field-specific weights (`FIELD_WEIGHTS` in `src/retrieval/invertedIndex.ts`):

| Field | Weight | Description |
|---|---|---|
| `symbol` | `3.0` | Exact and tokenized symbol names (classes, functions, interfaces, methods, types) |
| `path` | `2.0` | POSIX file path segments and file base names |
| `io` | `2.0` | Imported and exported identifier names |
| `summary` | `1.2` | Top-level docblocks, Markdown headings, and JSON schema keys |
| `identifier` | `0.8` | Code identifiers harvested during AST parsing |
| `body` | `0.5` | Body, comment, and string-literal tokens with length normalization |

Occurrences within a field are subject to sublinear term frequency damping (`1 + ln(tf)`), capped at `MAX_TF_PER_FIELD = 10`.

### Body Field Length Normalization

The body lexical field (`M3_BODY_FIELD`) uses BM25F-style length normalization:
- `weight = 0.5`
- `k1 = 1.2`
- `b = 0.75`
- `referenceLength = 2000` tokens

Length normalization uses a fixed reference length (2000 tokens) rather than an average corpus length. This guarantees that adding or removing other files in the workspace does not alter the score of an unchanged file. Incremental indexing and full re-indexing yield identical lexical scores.

## Content Score Fusion

Raw lexical and symbol content scores are combined via content-score fusion (`M3_CONTENT_FUSION` in `src/retrieval/hybridRetriever.ts`):
- Multiplier: `weight = 2.0`

Content scores derived from tf-idf fall in the range 0.1 to 1.0, whereas graph structural bonuses accumulate between 0.42 and 0.7 per edge. Multiplying content scores by 2.0 ensures that a file with a strong lexical match (content score >= 0.25) outranks a graph-only neighbor that has zero text overlap with the task query.

## Ranking Signals and Weights

Final file ranking is calculated by `HybridRetriever` using `RANKING_WEIGHTS` (`src/retrieval/relevanceScorer.ts`):

```
final_score = (content_score * 2.0) + (structural_score * 0.7) + (recency_score * 0.15)
```

Where `content_score` incorporates:
- Exact symbol match (`exactSymbol = 1.0`): Fired when a query token matches a symbol identifier name exactly.
- File name match (`fileName = 0.8`): Fired when query tokens match the file's base name (for example, "auth routes" matching `authRoutes.ts`).
- Lexical score (`lexical = 0.9`): Sum of inverted index field hits.

### Structural Graph Bonuses

Structural expansion adds bonuses based on relationship kinds (`STRUCTURAL_BONUS`):

| Relationship Signal | Bonus | Description |
|---|---|---|
| `TEST_OF` | `0.7` | Candidate is the naming-convention test file for a seed (e.g. `service.test.ts` for `service.ts`) |
| `DIRECT_DEPENDENCY` | `0.6` | Candidate is imported by a seed file |
| `INHERITANCE` | `0.6` | Candidate extends or implements a symbol defined in a seed |
| `DIRECT_DEPENDENT` | `0.5` | Candidate imports a seed file |
| `CALL_EDGE` | `0.5` | Candidate contains functions called by or calling seed symbols |
| `SAME_DIRECTORY` | `0.2` | Candidate shares a directory with the top-scoring content match |

Structural Cap: Total structural bonus per file is strictly capped at `STRUCTURAL_CAP = 1.0`. This prevents large central hub files (files imported by dozens of modules) from accumulating unbounded structural weight and displacing files with strong query relevance.

### Recency Bonus

When `offlineCodeContext.enableGitRecency` is enabled (default `false`), `safeGit` queries local commit timestamps. A deterministic recency bonus (`recency = 0.15`) scales with how recently the file was touched in local git history. In untrusted workspaces, this bonus is automatically disabled.

### Change-Aware Seed Signals

When `offlineCodeContext.changeSeeds` is enabled (default `false`, experimental), working-tree changes inject additional seed signals (`M4_SEED_WEIGHTS`):
- `DIFF_TOUCHED`: `0.6` (tuned by seed simulation in ADR-006)
- `OPEN_EDITOR`: `0.3` (untuned default)
- `DIAGNOSTIC`: `0.4` (untuned default)
- `STACK_FRAME`: `0.4` (untuned default)

Seed Slot Policy: Default is `signal-only`. Seeded files generate retrieval signals and expand graph neighbors, but they do not automatically pin content slots. Content slots are awarded strictly by overall ranking score.

## Tiering and Ranking Priority

Files are grouped into selection tiers based on their primary match source:
- Tier 1 (Direct Match): Files with exact symbol matches, file name matches, or top-decile lexical scores.
- Tier 2 (Direct Relationship): Direct dependencies, direct dependents, and companion test files.
- Tier 3 (Extended Relationship): Multi-hop dependencies, same-directory neighbors, and callers.

Packaging uses rank-priority selection: candidate files are sorted descending by final score. The packer processes candidates in order, filling package token budgets from top to bottom.

## Test-File Handling

Test files receive specialized treatment during retrieval:
1. Classification: A file is identified as a test file (`meta.isTest = true`) if its path matches test directories (`test/`, `tests/`, `__tests__/`) or suffixes (`.test.ts`, `.spec.ts`, `_test.go`).
2. Sibling Test Associator: When an implementation file ranks in the top candidates, its companion test file receives the `TEST_OF` bonus (0.7).
3. Test Penalization: Test files do not propagate secondary dependency hops. If a test file matches purely on low-weight lexical terms, it is deprioritized to avoid crowding out production code.

## Origin of WHY Entries

Every file included in the context package carries a structured WHY audit entry. WHY entries are generated by `explainSignals()` in `src/retrieval/relevanceScorer.ts`. They list the exact signals that fired for that file, sorted descending by signal weight:
- `Exact symbol match: <symbolName> (<path>:<line>)`
- `File name matches query: <matchedSegments>`
- `Lexical match (score <score>): <matchedTerms>`
- `Direct dependency: imported by <importerPath>`
- `Direct dependent: imports <dependencyPath>`
- `Call relationship with <callerPath>`
- `Test file for <targetPath> (naming convention)`
- `Inherits from / implements symbol in <targetPath>`
- `Same directory as top match: <directoryPath>`
- `Recently modified (git recency, <relativeAge>)`

## Known Failure Modes

1. Behavior-Described Tasks Without Lexical Overlap: If a developer enters a task describing abstract behavior without mentioning existing identifiers, file names, or domain nouns (for example, "fix the thing that breaks when clicking submit"), lexical retrieval finds few matching tokens. Retrieval falls back to directory structure and entry points.
2. Multi-Hop Architectural Reasoning: When a task requires modifications across four or more abstraction layers without direct call sites (for example, dynamic plugin architectures or event-bus messaging), graph traversal stops at `maxGraphDepth` (default 3) and will not reach distant modules.
3. Non-TypeScript/JavaScript Formats: Files in languages lacking deep AST parsers (such as Python, Go, or Rust) are indexed with metadata only (file path, line count, file size, hash). Symbol matches and call-edge signals do not fire for these languages.
