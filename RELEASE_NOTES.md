# Offline Code Context Compiler (OCC) v0.3.1 <!-- doc-style-ignore -->

> **Notice**: v0.3.1 is a packaging and hygiene patch release that **supersedes v0.3.0**. The v0.3.0 tag was created on origin before final packaging and third-party notices landed. v0.3.1 provides the complete packaging fixes with zero functional or wire format changes.

M1 through M4b are integrated. This release improves file selection in compiled context packages. On holdout evaluations using paired 95% confidence intervals, OCC scores higher than a BM25-over-contents baseline on Top-1, Recall@5, Recall@10, and MRR. Package recall is at parity with BM25. Rank-priority packaging closed the earlier package recall deficit.

Change-aware seeds were implemented and measured to provide no recall gain. Without the M4b slot-policy fix, change seeds were significantly harmful; with the fix, the difference was not significant. The feature therefore ships as experimental and disabled by default. When enabled, the optional CURRENT CHANGES diff section provides context to the model. The extension hardens git execution through a single safeGit spawn point that neutralizes repository-side configuration and respects workspace trust. For startup index loading, we removed a quadratic step that accounted for about 24% of the load profile. Over three runs on the test machine, median startup changed from 8,163 ms to 5,465 ms (before: 5,472 to 10,279 ms; after: 4,592 to 9,213 ms).

## What changed in v0.3.1 (patch release)

| Change | Description |
|---|---|
| VSIX packaging hygiene | Excluded `RELEASE_NOTES.md` and `.gitignore` via `.vscodeignore`. The package contains exactly 6 runtime and legal files (`dist/extension.js`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`). |
| Third-party notices | Added `THIRD_PARTY_NOTICES.md` with Apache License 2.0 text and Microsoft copyright notice for bundled `typescript 5.9.3`. |
| Startup performance claims | Corrected descriptions to match measured test ranges (median 5,465 ms vs 8,163 ms across 3 runs; before: 5,472 to 10,279 ms; after: 4,592 to 9,213 ms; quadratic step accounted for about 24% of the load profile). |
| Bundle parity verification | Verified minified bundle produces byte-for-byte payload parity with unminified builds (identical SHA-256 on `demo-project`). |
| Functional stability | Retrieval algorithms, ranking, secret detection policies, and wire format (`CONTEXT_VERSION: 1`) are unchanged from v0.3.0. |

## Measured context quality (holdout)

| Metric | OCC | BM25 | Paired difference [95% CI] |
|---|---|---|---|
| Top-1 hit rate | 0.303 | 0.200 | **+0.103 [0.040, 0.170]** |
| Recall@5 | 0.438 | 0.305 | **+0.133 [0.083, 0.184]** |
| Recall@10 | 0.560 | 0.466 | **+0.094 [0.044, 0.143]** |
| All-gold Acc@10 | 0.327 | 0.273 | **+0.053 [0.003, 0.110]** |
| MRR | 0.483 | 0.345 | **+0.138 [0.086, 0.189]** |
| Package recall | 0.458 | 0.412 | +0.046 [-0.004, 0.100] (statistical parity) |

## Highlights

### Added (M4 and M4b: change-aware seeds, machinery shipped, default OFF)

- **Working-tree change seeds** (`src/seeds/`, trust-gated, behind `offlineCodeContext.changeSeeds`, **default false**): staged, unstaged, untracked, renamed, and deleted paths are collected through hardened `safeGit`, flood-controlled (cap 20, state-then-path order, lockfile and generated exclusion, merge and rebase note), and rendered as an optional `## CURRENT CHANGES` section under `currentChangesMaxTokens` budget with fail-closed leak scanning.
- **Optional untuned seed sources**: open editor tabs and selection (`seedEditors`), diagnostics (`seedDiagnostics`), clipboard stack-trace frames via `OCC: Seed From Clipboard Stack Trace` (`seedStackTraces`).
- **M4b slot-policy**: default `slotPolicy: "signal-only"` ensures that when change seeds are enabled for experimentation, seeds do not consume and displace rank-priority package slots.

### Added (hardening)

- **Startup load**: external packages on the relationship graph are maintained incrementally on edge add or remove (O(N²) to O(N)). This removed a quadratic step that accounted for about 24% of the load profile. Median startup on the test machine changed from 8,163 ms to 5,465 ms over 3 runs (before: 5,472 to 10,279 ms; after: 4,592 to 9,213 ms).
- **Git hardening** (`src/git/safeGit.ts`): all git calls are centralized through a single hardened spawn point with `-c core.fsmonitor=false`, `core.hooksPath=<empty>`, `protocol.ext.allow=never`, `GIT_OPTIONAL_LOCKS=0`, and `GIT_TERMINAL_PROMPT=0`. Gated on VS Code workspace trust.

### Added (M3b: packaging)

- **P1 (rank-priority content slots)**: Top-ranked files claim content slots in rank order first, eliminating tier-order displacement and closing the package recall gap to statistical parity with BM25.

### Added (M3: retrieval improvements)

- **E2 (content-score fusion)**: Adds `2.0 * contentScore` to rank matching files above non-lexical structural neighbors.
- **E1 (body lexical field)**: Comments, strings, and doc prose are indexed as a searchable field with length-normalized BM25F scoring.

### Verification and test suite

- 27 suites, 292 tests pass across Ubuntu, macOS, and Windows on GitHub Actions CI.
