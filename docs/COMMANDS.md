# Command Reference

Complete reference for all 16 commands provided by Offline Code Context Compiler (OCC). Commands are accessible via the VS Code Command Palette (`Ctrl+Shift+P` on Windows/Linux, `Cmd+Shift+P` on macOS) by typing `OCC:` or through contextual menus.

## Summary Table

| Command ID | Title | Palette | Context Menu | Description |
|---|---|---|---|---|
| `offlineCodeContext.indexWorkspace` | OCC: Index Workspace | Yes | No | Scans and indexes all workspace files |
| `offlineCodeContext.rebuildIndex` | OCC: Rebuild Index | Yes | No | Discards current index and re-indexes from scratch |
| `offlineCodeContext.indexCurrentFile` | OCC: Index Current File | Yes | No | Re-indexes the active editor file immediately |
| `offlineCodeContext.showIndexStatus` | OCC: Show Index Status | Yes | Status Bar | Displays index statistics and status panel |
| `offlineCodeContext.searchCodebase` | OCC: Search Codebase | Yes | No | Interactive ranked search across symbols and tokens |
| `offlineCodeContext.generateProjectContext` | OCC: Generate Project Context | Yes | Explorer Folder | Compiles project overview context into preview |
| `offlineCodeContext.copyProjectContextToClipboard` | OCC: Copy Project Context to Clipboard | Yes | Explorer Folder | Compiles project context directly to clipboard |
| `offlineCodeContext.generateFileContext` | OCC: Generate File Context | Yes | Editor, Editor Title | Compiles file neighborhood context into preview |
| `offlineCodeContext.copyFileContextToClipboard` | OCC: Copy File Context to Clipboard | Yes | Editor, Editor Title | Compiles file context directly to clipboard |
| `offlineCodeContext.generateTaskContext` | OCC: Generate Task Context | Yes | No | Compiles task-directed context into preview |
| `offlineCodeContext.generateSelectionContext` | OCC: Generate Selection Context | Yes | No | Compiles active editor selection into preview |
| `offlineCodeContext.previewContext` | OCC: Preview Context | Yes | No | Opens read-only editor with current context |
| `offlineCodeContext.copyContext` | OCC: Copy Context to Clipboard | Yes | No | Copies current context package to clipboard |
| `offlineCodeContext.securityScan` | OCC: Security Scan | Yes | No | Runs standalone secret scanner across context |
| `offlineCodeContext.clearIndex` | OCC: Clear Local Index | Yes | No | Wipes local index shards and manifest from disk |
| `offlineCodeContext.seedFromStackTrace` | OCC: Seed From Clipboard Stack Trace | Yes | No | Parses stack trace in clipboard to seed retrieval |

## Commands Reference

### `offlineCodeContext.indexWorkspace`
- Title: `OCC: Index Workspace`
- Availability: Command Palette
- Description: Initiates a background scan of all workspace files matching inclusion rules. Discovers files, calculates SHA-256 hashes, parses syntax trees for supported formats (TypeScript, JavaScript, JSON, Markdown), and persists index shards to local workspace storage. Re-indexes only changed files on subsequent runs.

### `offlineCodeContext.rebuildIndex`
- Title: `OCC: Rebuild Index`
- Availability: Command Palette
- Description: Clears existing index entries and forces a full from-scratch re-indexing of all workspace files. Use this command after modifying `offlineCodeContext.excludePatterns` or `offlineCodeContext.respectGitignore`.

### `offlineCodeContext.indexCurrentFile`
- Title: `OCC: Index Current File`
- Availability: Command Palette
- Description: Re-indexes the currently focused file in the editor immediately without waiting for the background file watcher debounce window.

### `offlineCodeContext.showIndexStatus`
- Title: `OCC: Show Index Status`
- Availability: Command Palette, clicking Status Bar item
- Description: Opens the Code Context view container in the Activity Bar showing index statistics, including total indexed files, store schema version, memory usage, and last indexing duration.

### `offlineCodeContext.searchCodebase`
- Title: `OCC: Search Codebase`
- Availability: Command Palette
- Description: Opens an interactive input prompt for quick codebase search. Queries are scored using lexical and symbol signals, returning ranked file matches with selection rationale. Selecting a result navigates to the file.

### `offlineCodeContext.generateProjectContext`
- Title: `OCC: Generate Project Context`
- Availability: Command Palette, Explorer folder context menu
- Description: Generates a project-level context package summarizing repository architecture, directory hierarchy, hubs, and key exported symbols. When invoked from a folder in the Explorer view, scopes the target subtree. Opens the result in the read-only preview editor.

### `offlineCodeContext.copyProjectContextToClipboard`
- Title: `OCC: Copy Project Context to Clipboard`
- Availability: Command Palette, Explorer folder context menu
- Description: Generates the project-level context package and copies the finalized text directly to the system clipboard. Displays a summary notification with file and estimated token counts upon completion.

### `offlineCodeContext.generateFileContext`
- Title: `OCC: Generate File Context`
- Availability: Command Palette, Editor context menu, Editor title tab context menu
- Description: Generates a context package centered around the active file. Gathers direct dependencies, dependents, call relationships, and associated test files, opening the compiled output in the preview editor.

### `offlineCodeContext.copyFileContextToClipboard`
- Title: `OCC: Copy File Context to Clipboard`
- Availability: Command Palette, Editor context menu, Editor title tab context menu
- Description: Generates the file-centered context package and writes the result directly to the system clipboard without opening the preview window.

### `offlineCodeContext.generateTaskContext`
- Title: `OCC: Generate Task Context`
- Availability: Command Palette
- Description: Prompts the developer for a task description (for example, "Add rate limiting middleware to auth routes"). Retrieves relevant files using hybrid lexical and structural ranking, degrades excerpts to fit token budgets, runs security redaction, and opens the preview editor.

### `offlineCodeContext.generateSelectionContext`
- Title: `OCC: Generate Selection Context`
- Availability: Command Palette
- Description: Compiles a package focused on the active editor selection. Prompts whether to include graph neighbors (imports, callers, tests) or restrict the package to the selected file content only.

### `offlineCodeContext.previewContext`
- Title: `OCC: Preview Context`
- Availability: Command Palette
- Description: Opens a dedicated read-only editor displaying the most recently generated context package text. Allows manual inspection of package sections, token estimates, and WHY selection reasons before copying.

### `offlineCodeContext.copyContext`
- Title: `OCC: Copy Context to Clipboard`
- Availability: Command Palette
- Description: Copies the currently active context package directly to the system clipboard. Validates content against the fail-closed leak gate before copying; any surviving unredacted secret aborts the transfer.

### `offlineCodeContext.securityScan`
- Title: `OCC: Security Scan`
- Availability: Command Palette
- Description: Performs an explicit scan for secret-like tokens across workspace files selected for context. Reports findings, detected pattern types, and redaction actions in the Offline Code Context output channel.

### `offlineCodeContext.clearIndex`
- Title: `OCC: Clear Local Index`
- Availability: Command Palette
- Description: Prompts for confirmation and deletes all persisted index files, shard directories, and manifest files from local workspace storage. Leaves the workspace in an unindexed state.

### `offlineCodeContext.seedFromStackTrace`
- Title: `OCC: Seed From Clipboard Stack Trace`
- Availability: Command Palette
- Description: Reads the system clipboard, extracts file paths and line numbers matching error stack trace conventions, and registers them as retrieval seeds. Subsequent task or file context generations prioritize files identified in the trace.
