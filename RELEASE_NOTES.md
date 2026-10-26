# Offline Code Context Compiler (OCC) v0.3.2

Version 0.3.2 adds index secret-token filtering with store schema version 3, updates third-party notices, excludes repository security documentation from the packaged extension, and adds clean-profile smoke testing against minimum supported VS Code versions.

## What changed

| Area | Change |
|---|---|
| Index secret-token filtering | On-disk index shards (`entries/xx/<hash>.json`) no longer persist tokens flagged by `SecretScanner`. Matched secret spans are blanked before extracting `identifiers` and `bodyTokens`, and secrets in `fileSummary`, symbol `docComment`, and symbol `signature` are blanked. Applies across all `secretPolicy` settings. |
| Test fixture safety | Test fixtures assemble secret strings at runtime from string fragments across test files, preventing raw secret token literals in test source code. |
| Packaging hygiene | Excluded `SECURITY.md` from the packaged `.vsix` via `.vscodeignore`. Appended the full text of `ThirdPartyNoticeText.txt` to `THIRD_PARTY_NOTICES.md`. The package contains exactly six runtime and legal files. |
| Minimum-version smoke testing | Added `SMOKE_VSCODE_VERSION` support to `scripts/smoke-vsix.ts` and a dedicated CI job running the clean-profile smoke test under Linux (`xvfb-run`) against VS Code 1.85.0. |
| Documentation and gates | Added `docs/STYLE_GUIDE.md`, completed the technical documentation set, and added automated gates for link validation, reference synchronization, and style enforcement. |

## Upgrade note

On first run after upgrade, OCC clears older index stores and rebuilds the local index. Versions up to 0.3.1 persisted secret-like tokens in local on-disk index shards.

Filtering limit: Values that the scanner does not flag in the source file, such as short passwords or low-entropy strings, are still tokenized. Word-like fragments such as key-type prefixes also remain in the index.

## Verification

- Automated test suite: 27 test suites and 292 tests pass on GitHub Actions CI across Ubuntu, macOS, and Windows.
- Documentation gates: Link validation, reference synchronization against `package.json`, and strict documentation style checks pass.
- Clean-profile smoke test: Packaged `.vsix` verified for installation, extension activation, command registration, configuration defaults, and workspace indexing on clean profiles in VS Code 1.85.0 and stable.

## Release artifacts

| File | SHA-256 | Size |
|---|---|---|
| `offline-code-context-compiler-0.3.2.vsix` | `<VSIX_SHA256>` | `<VSIX_SIZE>` |
| `dist/extension.js` | `<EXTENSION_JS_SHA256>` | `<EXTENSION_JS_SIZE>` |
