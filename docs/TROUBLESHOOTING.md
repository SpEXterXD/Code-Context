# Troubleshooting Guide

This guide describes real diagnostic symptoms, error codes, and recovery procedures derived directly from the Offline Code Context Compiler (OCC) codebase.

## Diagnostic Error Codes

OCC errors carry a programmatic `code` property (`src/shared/errors.ts`):

| Error Code | Meaning | Typical Cause | Resolution |
|---|---|---|---|
| `NOT_INDEXED` | Workspace index is not ready | Context generation was requested before initial background indexing completed | Run `OCC: Index Workspace` and wait for the status bar indicator to display file counts |
| `SECURITY_BLOCKED` | Export blocked by security leak gate | A detected credential survived redaction, or a sensitive file path was requested | Inspect the finding reported in the Offline Code Context output channel; adjust `secretPolicy` or remove the credential |
| `STORE_CORRUPT` | Index storage on disk is malformed | A process crash or disk corruption damaged `manifest.json` or an entry shard | Run `OCC: Rebuild Index` to wipe the corrupted store and rebuild from scratch |
| `STORE_IO` | Filesystem input/output failure | Permissions errors or Windows file-locking (such as antivirus scanners locking temporary files during rename) | Ensure write permissions exist on the workspace storage path; run `OCC: Rebuild Index` |
| `BUDGET_INVALID` | Invalid budget configuration | Settings specify unreachable parameters (for example, `maxFiles` set below 1) | Verify that `maxFiles`, `maxChars`, `maxLines`, and `maxTokens` meet minimum bounds in settings |
| `CLIPBOARD_FAILED` | Clipboard write failure | The OS clipboard daemon refused the write or clipboard memory was exhausted | Use `OCC: Preview Context` to inspect the package, then select and copy text manually |
| `CANCELLED` | Operation aborted | The user cancelled an ongoing prompt or operation | Re-run the command |
| `PARSE_FAILED` | Parser failure | Extreme syntax error prevented AST parsing | The file is recorded as FAILED in the index; other files continue indexing normally |
| `INVALID_STATE` | State transition error | An internal service method was invoked before initialization | Reload the VS Code window |

## Common Symptoms and Solutions

### 1. "The workspace is not indexed yet"
- Symptom: Context generation commands fail with a notification stating the workspace is unindexed.
- Cause: Background indexing has not finished, or the workspace was opened in an empty state.
- Resolution: Check the VS Code status bar. If it shows `OCC: indexing...`, allow the scan to complete. If it shows `OCC: not indexed`, run `OCC: Index Workspace`.

### 2. An Expected File Is Missing from the Generated Package
- Symptom: A relevant file does not appear in the `## SOURCE` section of the context package.
- Step-by-Step Diagnostic:
 1. Inspect `## WHY THESE FILES WERE SELECTED`: Look for the file heading. If it appears with `[source not included]`, read the note:
 - `Note: excluded by security policy (block)`: The file contains a secret-like token and `secretPolicy` is set to `block`.
 - `Note: excluded by token budget`: Higher-ranked files exhausted `maxTokens` or `maxFiles`.
 2. Inspect `## CONTEXT METADATA`: Check the `Truncation:` line. If the file is listed under degraded files, it was truncated along the ladder (full file, symbol blocks, declarations, metadata only).
 3. Check Exclusion Settings: Verify whether the file path matches patterns in `offlineCodeContext.excludePatterns` or `.gitignore`.
 4. Check File Size Limit: Files exceeding `offlineCodeContext.maxFileSizeBytes` (default 1 MiB) are skipped during indexing and recorded as `SKIPPED_TOO_LARGE`.
 5. Check File Type: Non-text binary files are detected via NUL bytes and recorded as `SKIPPED_BINARY`.

### 3. Slow Initial Indexing
- Symptom: First-time indexing of a large repository takes several seconds.
- Cause: Initial indexing walks the filesystem, computes SHA-256 hashes, parses syntax trees for all TypeScript, JavaScript, JSON, and Markdown files, and writes individual shard files to disk. On a 5,000-file synthetic repository, initial indexing took approximately 18 seconds (Ryzen 7 4800H, Windows 11, Node 24).
- Resolution: Subsequent indexing runs are incremental: OCC checks content hashes and re-parses only files modified since the last run. Incremental indexing of 250 changed files in a 5,000-file repository took approximately 5.4 seconds.

### 4. Untrusted Workspace and Git Features Disabled
- Symptom: The status bar or output channel indicates that git features are disabled.
- Cause: The current workspace is running in VS Code Restricted Mode (`vscode.workspace.isTrusted === false`).
- Resolution: To prevent malicious repository configurations from executing arbitrary binaries via git hooks, OCC disables all git execution in untrusted workspaces. Indexing, AST parsing, and context generation remain fully operational. To re-enable git recency, grant workspace trust via the Manage Workspace Trust dialog.

### 5. Multi-Root Workspaces
- Symptom: Files from secondary workspace folders do not appear in index status or context packages.
- Cause: OCC currently supports single-root workspaces only. In a multi-root workspace, the extension binds exclusively to the primary root folder.
- Resolution: Open the target folder in an individual VS Code window.

### 6. Symlinked Files and Directories Skipped
- Symptom: Files inside symlinked directories are not discovered during workspace scanning.
- Cause: `WorkspaceScanner` ignores symbolic links to avoid infinite directory recursion and path traversal outside the repository root.
- Resolution: Ensure source files reside directly within the physical workspace directory tree.

### 7. Results Stale After Changing Settings
- Symptom: Modifying `excludePatterns` or `respectGitignore` does not immediately remove excluded files from search or context packages.
- Cause: Changes to file inclusion rules require an index synchronization.
- Resolution: Run `OCC: Rebuild Index` from the Command Palette to clear cached entries and re-scan the workspace.
