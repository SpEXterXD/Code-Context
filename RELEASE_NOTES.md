# Offline Code Context Compiler (OCC) v0.3.2 candidate

## What changed

- Raw Git diff export is paused. Change seeds remain off by default. When
  enabled in a trusted workspace, they use status paths as retrieval hints.
- Preview and clipboard use the same screened payload. OCC screens one
  bounded source snapshot per candidate, handles multiline private key
  blocks, and aborts export if a detected value survives in the payload.
- Discovery, indexing, metadata reads, and source export enforce the opened
  workspace boundary. OCC skips symlinks and junctions below the root.
- Incremental updates keep inheritance, imports, retrieval, and file counts
  consistent across edits, creates, deletes, renames, and reopening. Changes
  to ignore files and excluded alias configuration refresh the index.
- The candidate includes the third-party notices and packaged-extension
  smoke checks described in the changelog.

## Upgrade

Schema v7 stores sanitized inheritance clauses for relationship resolution.
OCC discards older local index shards on load and rebuilds from workspace
files. The store also uses safe categories for thrown parser diagnostics.
Secret filtering covers values the scanner detects.

## Release verification

The Windows, Linux, and macOS CI matrix, the minimum-version CI smoke, and
the smoke test of the exact CI distribution artifact are pending. Record the
distribution VSIX checksum after downloading that artifact.
