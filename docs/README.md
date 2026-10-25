# Documentation Index

Welcome to the Offline Code Context Compiler (OCC) documentation set. This index lists all architectural, operational, reference, and developer documentation pages.

## User and Operational Guides

- [USER_GUIDE.md](USER_GUIDE.md): Task-oriented guide for using context modes, inspecting preview output, and adjusting settings.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md): Diagnostic workflows and recovery procedures for error codes, missing files, and indexing issues.
- [LIMITATIONS.md](LIMITATIONS.md): Transparent account of technical boundaries, analysis depths, and platform constraints.

## System References

- [CONFIGURATION.md](CONFIGURATION.md): Complete reference for all 20 settings under `offlineCodeContext.*` with types, defaults, and ranges.
- [COMMANDS.md](COMMANDS.md): Complete reference for all 16 commands with Command Palette and context menu availability.
- [WIRE_FORMAT.md](WIRE_FORMAT.md): Specification for Context Package Wire Format v1, fence calculation, line numbering, and section layouts.
- [GLOSSARY.md](GLOSSARY.md): Formal definitions of system concepts, metrics, and architecture terms.

## Architecture and Engineering

- [ARCHITECTURE.md](ARCHITECTURE.md): Layer boundaries, module map, pipeline stages, index storage layout, and git hardening.
- [RETRIEVAL.md](RETRIEVAL.md): Hybrid lexical and structural ranking formulas, candidate sources, signals, and failure modes.
- [SECURITY.md](SECURITY.md): Threat model, secret scanning rules, redaction, safeGit hardening, and private vulnerability reporting.
- [adr/README.md](adr/README.md): Index of Architectural Decision Records with statuses, dates, and duplicate-number history.

## Quality and Research

- [EVALUATION.md](EVALUATION.md): Commit-mined evaluation methodology, datasets, paired bootstrap metrics, and milestone results.
- [TESTING.md](TESTING.md): Test suite matrix, coverage areas, property testing, and docs-sync contract verification.

## Development and Releases

- [DEVELOPMENT.md](DEVELOPMENT.md): Developer guide covering setup, npm scripts, quality gates, and contribution checklists.
- [RELEASING.md](RELEASING.md): Step-by-step release process, artifact verification, smoke testing, and registry checklists.
- [ROADMAP.md](ROADMAP.md): Planned improvements and experimental capabilities with explicit implementation statuses.
