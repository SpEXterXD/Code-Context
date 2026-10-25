---
name: Bug Report
about: Create a report to help reproduce and fix a defect in OCC
title: "[Bug]: "
labels: ["bug"]
assignees: []
---

## Description
A clear and concise description of the defect.

## Environment
- OCC Extension Version:
- VS Code Version:
- Operating System (Windows / macOS / Linux and version):
- Node Version (if running from source):

## Workspace Information
- Approximate Workspace Size (total files and lines):
- Primary Languages in Workspace (TypeScript, JavaScript, Python, etc.):
- Single-root or Multi-root workspace:

## Active Settings
Please list any customized settings under `offlineCodeContext.*` (e.g. `maxFiles`, `maxTokens`, `secretPolicy`, `excludePatterns`):
```json
{
  "offlineCodeContext.maxFiles": 40,
  "offlineCodeContext.maxTokens": 30000
}
```

## Redacted Context Package Header
If applicable, paste the header and metadata sections from the generated preview (omit or redact any sensitive workspace names):
```
# PROJECT CONTEXT
CONTEXT_VERSION: 1
FILES_INCLUDED: ...
ESTIMATED_TOKENS: ...
```

## Steps to Reproduce
1. Open workspace folder '...'
2. Run command '...'
3. Enter task '...'
4. Observe error or unexpected behavior

## Expected Behavior
A concise description of what you expected to happen.
