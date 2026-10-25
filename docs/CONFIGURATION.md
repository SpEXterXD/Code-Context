# Configuration Reference

Complete reference for all 20 settings in Offline Code Context Compiler (OCC). Settings are configured under the `offlineCodeContext.*` namespace in VS Code user or workspace settings (`settings.json`).

## Summary Table

| Setting | Type | Default | Range | Reindex Required |
|---|---|---|---|---|
| `offlineCodeContext.maxFiles` | integer | `40` | 1 to 500 | No |
| `offlineCodeContext.maxChars` | integer | `120000` | >= 1000 | No |
| `offlineCodeContext.maxLines` | integer | `3000` | >= 10 | No |
| `offlineCodeContext.maxTokens` | integer | `30000` | >= 100 | No |
| `offlineCodeContext.maxGraphDepth` | integer | `3` | 1 to 10 | No |
| `offlineCodeContext.maxCodeLinesPerFile` | integer | `400` | >= 10 | No |
| `offlineCodeContext.structureDepth` | integer | `4` | 1 to 12 | No |
| `offlineCodeContext.excludePatterns` | array | standard exclude list | Glob patterns | Yes (rebuild index) |
| `offlineCodeContext.maxFileSizeBytes` | integer | `1048576` | >= 1 | Yes (rebuild index) |
| `offlineCodeContext.secretPolicy` | string | `"block"` | `"block"`, `"warn"`, `"allow"` | No |
| `offlineCodeContext.redactSecrets` | boolean | `true` | true or false | No |
| `offlineCodeContext.enableGitRecency` | boolean | `false` | true or false | No |
| `offlineCodeContext.respectGitignore` | boolean | `true` | true or false | Yes (rebuild index) |
| `offlineCodeContext.statusBar` | boolean | `true` | true or false | No |
| `offlineCodeContext.changeSeeds` | boolean | `false` | true or false | No |
| `offlineCodeContext.changeSeedsMaxPaths` | integer | `20` | 1 to 200 | No |
| `offlineCodeContext.seedEditors` | boolean | `false` | true or false | No |
| `offlineCodeContext.seedDiagnostics` | boolean | `false` | true or false | No |
| `offlineCodeContext.seedStackTraces` | boolean | `false` | true or false | No |
| `offlineCodeContext.currentChangesMaxTokens` | integer | `1500` | 0 to 20000 | No |

## Settings Reference

### `offlineCodeContext.maxFiles`
- Type: `integer`
- Default: `40`
- Range: `1` to `500`
- Reindex Required: No
- Description: Maximum number of files included in a generated context package. Files beyond this limit are omitted from the source section. Interacts with `maxTokens`, `maxChars`, and `maxLines`: packaging halts as soon as any budget limit is reached.

### `offlineCodeContext.maxChars`
- Type: `integer`
- Default: `120000`
- Range: minimum `1000`
- Reindex Required: No
- Description: Maximum total characters of a generated context package. If a candidate file would breach this limit, the file degrades along the truncation ladder (full file, symbol blocks, declarations, metadata only) or is omitted.

### `offlineCodeContext.maxLines`
- Type: `integer`
- Default: `3000`
- Range: minimum `10`
- Reindex Required: No
- Description: Maximum total source lines included across all files in a generated context package. When reached, subsequent files degrade or are omitted.

### `offlineCodeContext.maxTokens`
- Type: `integer`
- Default: `30000`
- Range: minimum `100`
- Reindex Required: No
- Description: Maximum estimated tokens for the package. Estimated as characters divided by 4 (`chars / 4`). This is a deterministic heuristic estimate, not a tokenizer-exact count.

### `offlineCodeContext.maxGraphDepth`
- Type: `integer`
- Default: `3`
- Range: `1` to `10`
- Reindex Required: No
- Description: Hard depth limit for dependency graph traversal during candidate expansion. Governs how many hops of imports, call sites, and inheritance relationships the retriever follows from seed files.

### `offlineCodeContext.maxCodeLinesPerFile`
- Type: `integer`
- Default: `400`
- Range: minimum `10`
- Reindex Required: No
- Description: Maximum source lines emitted for a single file before truncation degrades excerpts. Files longer than this threshold emit focused symbol blocks instead of full file content.

### `offlineCodeContext.structureDepth`
- Type: `integer`
- Default: `4`
- Range: `1` to `12`
- Reindex Required: No
- Description: Depth of the directory tree rendered in the `## PROJECT STRUCTURE` section of the package. Directory counts beyond this depth are collapsed into summary tallies.

### `offlineCodeContext.excludePatterns`
- Type: `array` of `string`
- Default: `[".git", "node_modules", "dist", "build", "out", "coverage", ".cache", ".tmp", "tmp", ".env", ".env.*", "*.pem", "*.key", "*.log", "*.min.js", "*.map", "__pycache__"]`
- Reindex Required: Yes (run `OCC: Rebuild Index`)
- Description: Glob patterns matching files and directories that are never indexed, read, or included in context output. Modifying this setting requires an index rebuild to take effect.

### `offlineCodeContext.maxFileSizeBytes`
- Type: `integer`
- Default: `1048576` (1 MiB)
- Range: minimum `1`
- Reindex Required: Yes (run `OCC: Rebuild Index`)
- Description: Files larger than this threshold are skipped during indexing. Skipped files are recorded in the index store as `SKIPPED_TOO_LARGE` rather than silently ignored.

### `offlineCodeContext.secretPolicy`
- Type: `string`
- Default: `"block"`
- Options: `"block"`, `"warn"`, `"allow"`
- Reindex Required: No
- Description: Policy for potential secrets detected in candidate files. Under `block`, candidate files containing detected secrets are excluded from the source section while remaining listed in WHY entries. Under `warn`, file source is included with secrets redacted (when `redactSecrets` is true). Under `allow`, secrets are included verbatim (not recommended). Regardless of this setting, the final export passes through the leak gate.

### `offlineCodeContext.redactSecrets`
- Type: `boolean`
- Default: `true`
- Reindex Required: No
- Description: When true, secret-like matches in `warn` policy files are deterministically replaced with `[REDACTED:<type>:<hash8>]`. Files under `block` policy are excluded entirely regardless of this setting.

### `offlineCodeContext.enableGitRecency`
- Type: `boolean`
- Default: `false`
- Reindex Required: No
- Description: When true, applies a small deterministic recency boost based on local git modification timestamps. Operates locally through `safeGit` using read-only calls. Disabled automatically in untrusted workspaces.

### `offlineCodeContext.respectGitignore`
- Type: `boolean`
- Default: `true`
- Reindex Required: Yes (run `OCC: Rebuild Index`)
- Description: When true, ignores files matched by `.gitignore` rules during workspace discovery. Uses a deterministic subset of gitignore syntax.

### `offlineCodeContext.statusBar`
- Type: `boolean`
- Default: `true`
- Reindex Required: No
- Description: Controls visibility of the OCC index status indicator in the VS Code status bar.

### `offlineCodeContext.changeSeeds`
- Type: `boolean`
- Default: `false`
- Reindex Required: No
- Description: Experimental feature. When true, seeds retrieval with current working-tree changes from local git status. Defaults to false because evaluation benchmarks showed no recall gain on the tuning split (see ADR-006).

### `offlineCodeContext.changeSeedsMaxPaths`
- Type: `integer`
- Default: `20`
- Range: `1` to `200`
- Reindex Required: No
- Description: Maximum number of changed-path seeds collected when `changeSeeds` is enabled. Paths are ordered deterministically by change status priority (staged, unstaged, untracked, deleted) and file path.

### `offlineCodeContext.seedEditors`
- Type: `boolean`
- Default: `false`
- Reindex Required: No
- Description: Experimental feature. When true, seeds retrieval with files currently open in editor tabs and the active editor selection.

### `offlineCodeContext.seedDiagnostics`
- Type: `boolean`
- Default: `false`
- Reindex Required: No
- Description: Experimental feature. When true, seeds retrieval with files that contain compiler errors or warnings in the VS Code diagnostics panel.

### `offlineCodeContext.seedStackTraces`
- Type: `boolean`
- Default: `false`
- Reindex Required: No
- Description: Experimental feature. When true, incorporates file and line seeds captured via the `OCC: Seed From Clipboard Stack Trace` command into subsequent context generations.

### `offlineCodeContext.currentChangesMaxTokens`
- Type: `integer`
- Default: `1500`
- Range: `0` to `20000`
- Reindex Required: No
- Description: Maximum token budget allocated to the optional `## CURRENT CHANGES` diff section when `changeSeeds` is active. Counts directly against the overall package token budget.
