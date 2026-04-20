# Architectural Decision Records

This directory contains MADR-full ADRs that codify scope invariants of nubos-pilot. Each ADR is authoritative for the constraint it documents. Per CONTEXT.md D-07, decisions are superseded by new ADRs, never rewritten.

## Index

- [`0001-no-daemon-invariant.md`](0001-no-daemon-invariant.md) — No runtime daemon, no background process, no RPC multi-agents (FND-01)
- [`0002-zero-runtime-dependencies.md`](0002-zero-runtime-dependencies.md) — `package.json` dependencies block stays empty (FND-02)
- [`0003-max-six-unit-types.md`](0003-max-six-unit-types.md) — Milestone, Phase, Plan, Task, Todo, Backlog — no more (FND-03)
- [`0004-atomic-commit-per-unit.md`](0004-atomic-commit-per-unit.md) — Every unit-completion = exactly one git commit (FND-04)
- [`0005-three-orthogonal-file-trees.md`](0005-three-orthogonal-file-trees.md) — Source / Install-Payload / Project-State stay disjoint (FND-05)
- [`0006-yaml-dependency-amendment.md`](0006-yaml-dependency-amendment.md) — Accept `yaml@^2.8` as first runtime dep (amends ADR-0002)
- [`0007-codebase-docs-layer.md`](0007-codebase-docs-layer.md) — Skill-style codebase documentation under `.nubos-pilot/codebase/` as shared agent memory

## Status Lifecycle

Each ADR moves through three states:

1. **Proposed** — authored but not yet accepted; subject to revision during review.
2. **Accepted** — decision is binding; downstream work consumes the invariant as-is.
3. **Deprecated** — superseded by a later ADR (referenced via `Supersedes NNNN`); retained for history.

An ADR MAY enter directly as **Accepted** when it is ratified at authoring time (e.g. the FND-01…FND-05 ADRs in Phase 1, which encode invariants already agreed in CONTEXT.md). The `Proposed` state is reserved for ADRs whose decision is still open at commit time.

ADRs are append-only. A superseded ADR is never rewritten — instead, a new ADR with a higher number references it via its `Supersedes` line.

## Numbering

ADRs follow the pattern `NNNN-kebab-title.md` with a zero-padded four-digit sequence starting at `0001`. Numbers are monotonically incremented — no skips, no re-use — so that cross-references (e.g. `ADR-0003`) stay stable across the project's lifetime.
