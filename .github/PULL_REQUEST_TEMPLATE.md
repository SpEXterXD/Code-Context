## Summary
Brief description of the changes introduced by this pull request.

## Related Issues
Closes #(issue number)

## Scope of Changes
- [ ] Bug fix
- [ ] Documentation update
- [ ] Retrieval or ranking refinement
- [ ] New parser or signal addition
- [ ] Testing or build tooling

## Invariants and Ground Rules
- [ ] Domain logic below `src/extension/` does not import `vscode`
- [ ] Zero network modules imported in `src/` (`http`, `https`, `net`, `dns`)
- [ ] Output generation remains deterministic (no wall-clock timestamps or PRNG seeds in output)
- [ ] No raw secret-looking literals added to test fixtures (assembled at runtime from fragments)

## Verification
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm run format:check` passes
- [ ] `npm test` passes (all 27 suites, 292 tests)
- [ ] `npm run test:docs-sync` passes (all doc links, reference docs, and style checks pass)
- [ ] `npm run compile` produces identical bundle hash if touching only comments
