# Contributing to Offline Code Context Compiler

Thank you for your interest in contributing. OCC is developed as an offline, deterministic, fail-closed context compiler for VS Code.

## Getting Started

All development guidelines, ground rules, testing conventions, and contribution checklists are maintained in the developer guide:

-> [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)

## Quick Verification

Before opening a pull request, ensure the CI verification battery passes locally:

```bash
npm install
npm run ci
```

The `npm run ci` command runs type checking, ESLint, Prettier formatting checks, Vitest test suites (27 suites, 292 tests), documentation synchronization checks, and the bundle compilation.

## Pull Requests

1. Fork the repository and create a branch off `main`.
2. Ensure new features or bug fixes include corresponding tests.
3. Verify that test counts, reference docs, and links remain synchronized.
4. Open a pull request. All GitHub Actions CI checks must pass across Ubuntu, macOS, and Windows.
