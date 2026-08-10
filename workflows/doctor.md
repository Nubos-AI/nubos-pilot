---
command: np:doctor
description: 16-check install-integrity scan (manifest, version, hooks, Codex config, askUser, codebase docs, layout, Nubosloop, workflow command surface, orphan temp files, orphan checkpoints, output schemas, milestone requirements, advisory snapshot). Use --fix to apply auto-safe fixes.
argument-hint: [--fix]
---

# np:doctor

Run a 16-check integrity scan of the nubos-pilot install: manifest integrity,
version mismatch, missing hooks, trapped Codex `[features]`, askUser broken,
codebase docs freshness, milestone/slice layout, the three Nubosloop checks
(critics present, knowledge store, config), orphan temp files, orphan
checkpoints, output schemas, milestone requirement coverage (a milestone
with no `requirements[]` makes `/np:validate-phase` audit nothing), and the
advisory snapshot in the shared per-user cache
(`~/.nubos-pilot/advisory-db/<version>/`). Use `--fix`
to apply auto-safe fixes; anything
touching user files outside the manifest will prompt via `askUser()` (SC-5).

**Advisory snapshot verdicts:** `advisory-db-missing` (info — no snapshot
installed; the dependency scanner then reports a coverage gap rather than a clean
result), `advisory-db-unreadable` (warn — `manifest.json` unparseable or an
unsupported `schema_version`), `advisory-db-incomplete` (warn — a shard the
manifest lists is not on disk), `advisory-db-stale` (info — snapshot older than
90 days, with `age_days` in details), and `advisory-db-tampered` (**error** — a
shard's SHA-256 disagrees with the manifest; a modified store answers "clean" for
packages it no longer covers, so this one gates the exit code).

**Exit code:** 0 when no `error`-severity issue was found, 1 otherwise. `warn`
findings are advisory and keep exit 0.

**Read-only without `--fix`:** every check reports, none of them writes. The
orphan-temp-file check *reports* stale temp files (>1h old, under `.nubos-pilot/`)
as `orphan-tmp-files`; only `--fix` deletes them and reports `orphan-tmp-files-cleaned`.
Temp files younger than 1h are never touched — they may belong to a live process.

```bash
node .nubos-pilot/bin/np-tools.cjs doctor "$@"
```
## Definition of Done

This workflow exits cleanly only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 1 (Do the whole thing) — every check runs; no skips. `--fix` only fixes what is mechanically safe.
- Rule 5 (Genuinely impress) — failures cite the exact file, the exact mismatch, the exact remediation command.
- Rule 11 (Ship the complete thing) — no `--fix` half-applies; either fully fixed or unchanged with the failure surfaced.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
