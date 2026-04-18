---
phase: "07"
generated_by: researcher
mode: offline
completed: 2026-04-15
---

# Phase 07 Research: Install & Distribution (offline sample)

This is a golden RESEARCH.md produced by the `researcher` subagent on the
offline path (D-21..D-22). It is checked in as a fixture so plan-checker
(Plan 05-10) can grep-match the required coverage annotation and the
downstream-warning line without having to re-run the agent.

## Research Coverage

**Sources used:**
- Local repo (Glob, Grep, Read)
- Prior-phase CONTEXT.md files

**Sources unavailable:**
- WebFetch (external URLs)
- Context7 (library docs)

**Downstream consumer warning:** Plan-Checker bewertet Library-Version-Compat-Claims mit Vorsicht.

## Standard Stack

- Runtime: Node.js >= 22 `[VERIFIED]` — confirmed in `package.json` `engines`
  field. Version floor matches ADR-0002's runtime constraints (HIGH
  confidence).
- Packaging: npm tarball via `files[]` whitelist `[VERIFIED]` — pattern
  already in use in this repo's `package.json`.
- Distribution: `npx nubos-pilot init` pattern `[ASSUMED]` — inferred from
  CLAUDE.md's "Distribution" constraint; verify against the npm-registry
  norms in Phase 9 before first publish.

## Don't Hand-Roll

- Git operations — use `child_process.execFileSync('git', […])` only; do
  NOT reimplement with `isomorphic-git` or NAPI bindings (ADR reasoning
  already documented in CLAUDE.md).
- Frontmatter parsing — `lib/frontmatter.cjs` already handles the minimal
  surface; do NOT add `gray-matter` or similar until a real need surfaces.

## Common Pitfalls

- Forgetting to add new paths to `package.json` `files[]` → npm tarball
  ships incomplete, `npx` run fails in a clean install. Mitigation: a
  Phase-7 sanity script that diffs `files[]` against `git ls-files` before
  publishing.
- Mixing CJS `.cjs` with an implicit `"type": "module"` in the consumer's
  `package.json`. Phase 7 install step must never set `type: module` in
  the user's project (it isn't ours to set).

## Open Questions

- Does Claude Code's `AskUserQuestion` tool bind to the same JSON payload
  the `np-tools.cjs askuser --json` helper produces? Cannot resolve
  offline; flag for Phase 8 runtime-adapter verification.
- Are `mcp__context7__*` tool names stable across agent CLIs, or is that
  scoping Claude-Code-specific? Deferred to Phase 8.

## Environment Availability

- `git` — probed via `command -v git`; present on every agent-CLI host
  we care about. HIGH confidence.
- `node` — version floor `>=22` enforced at `package.json` level.
- `npm` — bundled with Node 22. HIGH confidence.
- `npx` — bundled with npm >= 10.5. HIGH confidence.

## Assumptions Log

| Claim                                    | Confidence | Provenance    |
| ---------------------------------------- | ---------- | ------------- |
| npm-registry norms match `npx` DX        | MEDIUM     | `[ASSUMED]`   |
| Node 22 remains Active LTS through ship  | HIGH       | `[ASSUMED]`   |
| `mcp__context7__*` names are portable    | LOW        | `[ASSUMED]`   |

All `[ASSUMED]` rows are explicitly surfaced for discuss-phase /
plan-checker to gate before they harden into locked decisions.
