# ADR-001: Offline-First Architecture

Date: 2026-09-11 · Status: Accepted

## Context

The extension compiles a repository into an LLM-ready context package. Any
network dependency would create a privacy boundary, a failure mode, and a
compliance burden (telemetry, GDPR, secrets in transit). The product promise
is "the only egress is the user's own copy-paste".

## Decision

Every stage (discovery, parsing, analysis, indexing, retrieval, context
generation, preview, clipboard export) runs locally in the extension host
with zero network I/O. There is no AI/ML model anywhere in the pipeline, no
telemetry, no hosted component. `src/security/outboundPolicy.ts` codifies the
guarantee and lists the forbidden Node modules; the module graph is audited so
no HTTP client can be imported from `src/`.

## Alternatives

- Optional cloud enrichment (embeddings, hosted search): rejected. It
  violates the core promise, adds keys and credentials, and makes outputs
  non-deterministic.
- Local LLM assistance: rejected. The tool must run on any machine, and a
  local model would dominate memory and CPU for no determinism gain.

## Trade-offs

- Ranking is lexical and structural only, with no semantic understanding.
  Explanations always cite the concrete signals that fired.
- Some relevance quality a semantic system might have is deliberately traded
  for determinism, privacy, and instant offline operation.

## Consequences

- Same repo state + config + task ⇒ byte-identical output. Test-enforced.
- No telemetry means no usage data; issues arrive from users directly.
- SECURITY.md documents the true boundary: after the user copies the payload,
  what they do with it is outside the program's control.
