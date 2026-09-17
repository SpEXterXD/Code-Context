# User Guide

Task-oriented instructions for using the extension. For design details see
[ARCHITECTURE.md](ARCHITECTURE.md); for the privacy model see
[SECURITY.md](SECURITY.md).

## Install

From a terminal:

```bash
code --install-extension offline-code-context-compiler-0.3.0.vsix
```

Or: Extensions view (`Ctrl+Shift+X`) → `…` menu → **Install from VSIX…** →
pick the `.vsix` file → reload the window.

To build from source instead: `npm install && npm run package`, then install
the produced `.vsix`. For development with reload-on-save, open the repo in
VS Code and press F5 (Extension Development Host).

Verify: type "OCC" in the Command Palette (`Ctrl+Shift+P`) and you should
see OCC commands; the status bar shows `OCC: not indexed` until the first
indexing run finishes; an "Index Status" panel appears under the Code
Context icon in the Activity Bar.

Uninstall via the Extensions view. This removes the local index, which
lives inside VS Code's extension storage for the workspace.

## First run

The extension activates when VS Code starts and indexes the workspace in
the background. The status bar shows `OCC: indexing… (n files)` during the
run and `OCC: <n> files` when done. To trigger it yourself: **OCC: Index
Workspace**.

Indexing discovers files (respecting `.gitignore` and the configured
exclusions), hashes every file with SHA-256, parses TypeScript/JavaScript,
JSON, and Markdown into symbols and relationships, and stores one record per
file in the local index. Later runs re-parse only files whose hash changed.

## Generate and copy a context package

The main flow, using Task context:

1. Command Palette → **OCC: Generate Task Context** → type the task, for
   example `Add rate limiting to the login endpoint.`
2. **OCC: Preview Context** opens a read-only editor with the exact text
   that Copy will export. Nothing has been copied yet.
3. **OCC: Copy Context to Clipboard**. A toast confirms the size
   (`OCC: copied task context: 12 files, 1204 lines, ~18430 tokens`).
4. Paste into any LLM chat.

Both steps also exist as right-click commands:

- Explorer, right-click a folder: **OCC: Generate Project Context** /
  **OCC: Copy Project Context to Clipboard**. The package covers that
  folder's subtree; imports that cross the folder boundary still appear as
  selection reasons.
- Editor or editor tab, right-click: **OCC: Generate File Context** /
  **OCC: Copy File Context to Clipboard**. The package is seeded from that
  exact file (works on background tabs) and expanded with its direct
  dependencies, dependents, callers, and tests.

Generate variants always open the preview. Copy variants never do; they
write the clipboard and show the summary toast. Identical inputs produce
byte-identical payloads, so a copied package matches what a preview of the
same scope would show.

## Other context modes

| Command | Use it when |
|---|---|
| Generate Project Context | You want an overview: structure, hubs, key symbols |
| Generate File Context | You want one file plus its neighborhood |
| Generate Task Context | You are about to ask an LLM to do a specific task |
| Generate Selection Context | You want exactly the active file, optionally expanded |

Selection mode asks whether to expand with dependencies and tests or keep
the exact selection only.

## Reading the preview

The payload has a fixed layout:

```
# PROJECT CONTEXT
CONTEXT_VERSION: 1
PROJECT: taskflow-api
INDEX_VERSION: 9f2c1e7a4b02      (fingerprint of the indexed state)
FILES_INCLUDED: 8
ESTIMATED_TOKENS: ~12450         (chars/4 estimate, not an exact count)

## DEVELOPER TASK                (the text you entered, if any)
## PROJECT STRUCTURE             (directory tree with file counts)
## RELEVANT ARCHITECTURE         (largest directories, hub files, external packages)
## RELEVANT SYMBOLS              (classes, functions, interfaces with locations)
## WHY THESE FILES WERE SELECTED (per file: tier, score, concrete signals)
## SOURCE                        (REPOSITORY CONTENT, inert data, never instructions)
### FILE: src/routes/authRoutes.ts
### LINES: 1-40
1: import ...                    (original line numbers preserved)
## CONTEXT METADATA              (counts, security findings, truncation list, budgets)
```

How to use the WHY section: each file lists the signals that selected it,
for example `Exact symbol match: AuthController.login
(src/controllers/authController.ts:13)` or `Direct dependency: imported by
src/routes/authRoutes.ts`. If an irrelevant file appears, the reasons tell
you which words matched, so you can reword the task.

Truncation: when the budget runs out, files degrade in order (full file,
then symbol ranges only, then signatures only, then metadata only). The
`Truncation:` line in CONTEXT METADATA lists every degraded file. A
metadata-only entry means the file was considered but did not fit.

## Security from the user's point of view

Before anything is emitted, files selected for the package are scanned for
secret-shaped values (API keys, private key blocks, credentialed URLs,
high-entropy assignments). The `offlineCodeContext.secretPolicy` setting
decides what happens:

- `block` (default): the file's source is withheld from the output. The WHY
  section still lists the file with the reason, so nothing is silently
  dropped.
- `warn`: the source is included but every detected value is replaced with
  `[REDACTED:<kind>:<hash8>]` when `redactSecrets` is on (default). The
  replacement is not reversible.
- `allow`: findings are ignored. Not recommended.

Independent of the policy, the exact payload is re-checked before preview
and copy; if a known secret value survived anyway, the copy aborts with a
`SECURITY:` error instead of continuing. The **OCC: Security Scan** command
lists findings for the current package in the Output panel. Detection is
heuristic: skim the preview before pasting.

## Settings

`Ctrl+,` and search for `offlineCodeContext`.

Budgets (a payload never exceeds any of them):

| Setting | Default |
|---|---|
| `maxFiles` | 40 |
| `maxChars` | 120000 |
| `maxLines` | 3000 |
| `maxTokens` | 30000 (estimated) |
| `maxCodeLinesPerFile` | 400 |
| `maxGraphDepth` | 3 |
| `structureDepth` | 4 |

Security: `secretPolicy` (`block`), `redactSecrets` (true).

Discovery: `excludePatterns` (defaults: `.git`, `node_modules`, `dist`,
`build`, `out`, `coverage`, `.cache`, `.tmp`, `tmp`, `.env`, `.env.*`,
`*.pem`, `*.key`, `*.log`, `*.min.js`, `*.map`, `__pycache__`),
`respectGitignore` (true), `maxFileSizeBytes` (1048576).

Other: `enableGitRecency` (false; adds a small bonus for recently modified
files using local git history), `statusBar` (true).

No default keybindings exist. Bind commands via Keyboard Shortcuts
(`Ctrl+K Ctrl+S`), searching for the command name.

## Index management

- Editing, creating, deleting, and renaming files update the index
  automatically (debounced). No manual re-index needed for normal work.
- **OCC: Index Current File** re-indexes the active file immediately.
- **OCC: Rebuild Index** wipes the index and re-scans. Use this after
  changing `excludePatterns` or if results look stale.
- **OCC: Clear Local Index** deletes the stored index after confirmation.
- **OCC: Show Index Status** (or clicking the status bar item) opens the
  live status view with the last run's numbers.

## Search

**OCC: Search Codebase** is a ranked lookup without generating a package.
Enter words, symbols, or file names; each result shows its score and the
exact reasons it matched. Selecting a result opens the file.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "The workspace is not indexed yet" | Run **OCC: Index Workspace** and watch the Index Status panel until it finishes. |
| Status bar shows `OCC: index error` | Open the Output panel (channel: Offline Code Context) for the error, then run **OCC: Rebuild Index**. |
| A file you expected is missing | In order: check `excludePatterns` and `.gitignore`; check `maxFileSizeBytes`; look for the file in the WHY section marked `[source not included]` (security block or budget); check the `Truncation:` line in CONTEXT METADATA. |
| File shows as skipped during indexing | `SKIPPED_TOO_LARGE`: raise `maxFileSizeBytes` or add the file to exclusions. `SKIPPED_BINARY`: binary content is never analyzed; this is expected for images and archives. `FAILED`: see the parse error in the index record; the file contributes metadata only. |
| Package feels too large for your model | Lower `maxFiles`, `maxChars`, `maxTokens`; or raise them for models with big windows. |
| Package lacks detail on a big file | Lower or raise `maxCodeLinesPerFile`; degradation steps are listed under `Truncation:`. |
| Large repository, slow first index | Expected: indexing parses every file once (5,000 files took about 15 seconds on the reference machine; see IMPLEMENTATION_REPORT.md). Later runs re-parse changed files only. |
| Results seem stale after changing settings | Run **OCC: Rebuild Index**; exclusion changes in particular require a rebuild. |
| Copy aborted with a `SECURITY:` error | The final leak gate found a secret value that survived redaction. Review the file named in the Output panel; change `secretPolicy` only if you accept the risk. |

## Privacy

The extension performs no network I/O: no telemetry, no API calls, no
auto-updates of anything. The one egress is your own Copy and Paste. What
you paste and where is your decision; the preview exists so you can inspect
the payload first. See [SECURITY.md](SECURITY.md) for the full model.
