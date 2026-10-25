# Offline Code Context Compiler (OCC) v0.3.1

> **Notice**: v0.3.1 is a packaging and hygiene patch release that **supersedes v0.3.0**. The v0.3.0 tag was created on origin before final packaging and third-party notices landed. v0.3.1 provides the complete packaging fixes with zero functional or wire format changes.

M1 through M4b, integrated. This release makes the compiled context package measurably better at including the right files: OCC is significantly ahead of a BM25-over-contents baseline on Top-1, Recall@5/10 and MRR (holdout, paired 95% CIs) and at **parity** on package recall — the earlier significant deficit was closed by the rank-priority packaging change.

Change-aware seeds were fully implemented and then measured to provide **no recall gain** (significantly harmful without the M4b slot-policy fix, not significant with it), so the feature ships **experimental and OFF by default**; the CURRENT CHANGES diff section still provides direct context for the LLM when enabled. The extension is hardened: git runs only through a single safeGit spawn point with repo-side config neutralized, is workspace-trust gated, and for startup index load we removed a quadratic step that accounted for ~24% of the load profile; median startup on the test machine changed from 8,163 ms to 5,465 ms over 3 runs (before: 5,472-10,279 ms; after: 4,592-9,213 ms).

## What Changed in v0.3.1 (Patch Release)

- **VSIX Packaging Hygiene**: Added `RELEASE_NOTES.md` and `.gitignore` to `.vscodeignore` to exclude them from the published `.vsix`. The extension package now cleanly contains exactly 6 runtime and legal files (`dist/extension.js`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`).
- **Third-Party Notices**: Added `THIRD_PARTY_NOTICES.md` with full verbatim Apache License 2.0 text and Microsoft copyright notice for the bundled `typescript 5.9.3` dependency.
- **Startup Performance Claims**: Corrected startup index load descriptions across all documentation to match the exact measured test ranges (median 5,465 ms vs 8,163 ms across 3 runs; before: 5,472–10,279 ms; after: 4,592–9,213 ms; quadratic step accounted for ~24% of the load profile).
- **Bundle Parity Verification**: Verified that minified bundle output produces byte-for-byte payload parity with unminified builds (identical SHA-256 on `demo-project`).
- **No Functional Changes**: Retrieval algorithms, ranking, secret detection policies, and wire format (`CONTEXT_VERSION: 1`) are completely unchanged from v0.3.0.

## Measured Context Quality (Holdout)

| Metric          | OCC   | BM25  | Paired difference [95% CI]                      |
| --------------- | ----- | ----- | ----------------------------------------------- |
| Top-1 hit rate  | 0.303 | 0.200 | **+0.103 [0.040, 0.170]**                       |
| Recall@5        | 0.438 | 0.305 | **+0.133 [0.083, 0.184]**                       |
| Recall@10       | 0.560 | 0.466 | **+0.094 [0.044, 0.143]**                       |
| All-gold Acc@10 | 0.327 | 0.273 | **+0.053 [0.003, 0.110]**                       |
| MRR             | 0.483 | 0.345 | **+0.138 [0.086, 0.189]**                       |
| Package recall  | 0.458 | 0.412 | +0.046 [−0.004, 0.100] — **statistical parity** |

## Highlights

### Added (M4 & M4b: change-aware seeds — machinery shipped, default OFF)

- **Working-tree change seeds** (`src/seeds/`, trust-gated, behind `offlineCodeContext.changeSeeds`, **default false**): staged/unstaged/untracked/renamed/deleted paths collected through hardened `safeGit`, flood-controlled (cap 20, state-then-path order, lockfile/generated exclusion, merge/rebase note), and rendered as an optional `## CURRENT CHANGES` section under `currentChangesMaxTokens` budget with fail-closed leak scanning.
- **Optional untuned seed sources**: open editor tabs + selection (`seedEditors`), diagnostics (`seedDiagnostics`), clipboard stack-trace frames via `OCC: Seed From Clipboard Stack Trace` (`seedStackTraces`).
- **M4b slot-policy**: default `slotPolicy: "signal-only"` ensures that when change seeds are enabled for experimentation, seeds do not consume and displace rank-priority package slots.

### Added (Hardening)

- **Startup load**: external packages on the relationship graph maintained incrementally on edge add/remove (O(N²) → O(N)) — a quadratic step that accounted for ~24% of the load profile. Median startup on the test machine changed from 8,163 ms to 5,465 ms over 3 runs (before: 5,472-10,279 ms; after: 4,592-9,213 ms).
- **Git hardening** (`src/git/safeGit.ts`): all git calls centralized through a single hardened spawn point with `-c core.fsmonitor=false`, `core.hooksPath=<empty>`, `protocol.ext.allow=never`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`. Gated on VS Code workspace trust.

### Added (M3b: Packaging)

- **P1 — rank-priority content slots**: Top-ranked files claim content slots in rank order first, eliminating tier-order displacement and closing the package recall gap to statistical parity with BM25.

### Added (M3: Retrieval Improvements)

- **E2 — content-score fusion**: Adds `2.0 × contentScore` to elevate matching files above structural noise.
- **E1 — body lexical field**: Comments, strings, and doc prose indexed as a searchable field with length-normalized BM25F scoring.

### Verification & Test Suite

- 27 suites, 286 tests, 100% passing across Ubuntu, macOS, and Windows on GitHub Actions CI.
