---
command: np:stats
description: Stats output — phases-table (name/plans/completed/status/%) + metrics aggregation (tokens-in/out per phase, avg duration by tier, retry_count_sum, error_rate). Consumes node .nubos-pilot/bin/np-tools.cjs stats json. Null-token runtimes render as `—` (Phase 9 D-09). Read-only — no commits, no STATE mutation.
argument-hint: [json]
---

# np:stats

Implements UTIL-07b. Renders an on-demand snapshot combining a
phases-table (phase / plans total / complete / status / percent)
with metrics aggregation (tokens-in / tokens-out per phase, avg
duration by tier, retry_count_sum, error_rate). Read-only surface
per D-20 SC-5 — no files written, no state mutated, no git commit.

The workflow delegates ALL data collection AND markdown rendering to
`bin/np-tools/stats.cjs` (`stats markdown` subcommand). Localized labels
(en/de) are sourced from `.nubos-pilot/config.json` →
`response_language`. No JSONL parsing or markdown templating inline.

Pure read-only workflow — no agent spawn, no resolve-model, no
metrics record. Pitfall 9 / `workflow-missing-metrics` is exempt.

## Render

The `stats markdown` subcommand reads project state, builds the snapshot,
and emits a localized markdown report on stdout. Labels are sourced from
`.nubos-pilot/config.json` → `response_language` (en/de). Null token cells
render as `—` (Phase 9 D-09); progress bar is a 20-char block-string
`[████░░░░░░…]` (ADR-0002).

```bash
node .nubos-pilot/bin/np-tools.cjs stats markdown
```

Empty projects (no milestones / phases) render an empty Phases / Metrics
table — the workflow does not need to special-case that.

Rendered output sections: project-stats header (milestone / progress bar /
last activity / commits / start date), phases table (phase / name / plans /
complete / status / percent), metrics-by-phase table (records / tokens /
tier-avg durations / errors). Example row for a phase with no metrics:
`| 10 | — | — | — | — | — | — | — |`.

## No Commit

Stats is read-only (D-20 SC-5). No files are written, no state is
mutated, no git commit is made. The markdown goes directly to stdout
and is rendered by the agent CLI.

## Scope Guardrail

<scope_guardrail>
**Do:**
- Consume `node .nubos-pilot/bin/np-tools.cjs stats markdown` — the
  subcommand owns both data collection (Plan 10-01-T04 schema) and
  localized rendering.
- Use `stats json` only when raw machine-readable output is needed
  (no localization applies there).
- Keep the workflow read-only — no files written, no STATE mutated,
  no git commit (D-20 SC-5).

**Don't:**
- Re-implement JSONL aggregation inline — `lib/metrics-aggregate.cjs`
  owns the schema (D-18).
- Write any files — this workflow is a render, not a producer.
- Add a git commit — there is nothing to commit.
- Invoke host-specific prompt tools directly (the BARE_ASKUSER lint
  in `bin/check-workflows.cjs` blocks them) — route through
  `node .nubos-pilot/bin/np-tools.cjs askuser --json '…'` if prompts are ever added.
- Add a `metrics record` block. No Task/Spawn site; Pitfall 9 /
  `workflow-missing-metrics` is exempt.
</scope_guardrail>

## Output

- Markdown snapshot on stdout with Project Stats header, Phases
  table, and Metrics by Phase table.
- No files created. No state mutated. No git commit.

## Success Criteria

- [ ] Markdown rendered exclusively via `node .nubos-pilot/bin/np-tools.cjs stats markdown` —
      no inline `node -e` or JSONL parsing.
- [ ] Labels follow `.nubos-pilot/config.json` → `response_language`
      (en / de today; English fallback for unknown codes).
- [ ] Null `tokens_in` / `tokens_out` render as `—` (D-09 / D-15).
- [ ] Progress bar is a 20-char block-string (ADR-0002).
- [ ] Phases table contains phase / name / plans_total / completed
      / status / percent.
- [ ] Metrics-by-phase table shows records / tokens / tier-avg
      durations / errors per phase.
- [ ] Zero file writes, zero state mutations, zero commits (D-20
      SC-5).
- [ ] Lint clean under `bin/check-workflows.cjs` — no BARE_ASKUSER
      violations, no DIRECT_READ matches.

## Related Workflows

- **`/np:dashboard`** — read-only milestone/slice/task overview with
  per-status counts and checkbox rollups.
- **`/np:session-report`** — commits a rendered report with
  since-last-session metrics (the producer pair for `/np:stats`).

## Design Notes

Phases-table + metrics aggregation combined per D-15. Stats CLI
(`bin/np-tools/stats.cjs`) is the single data source (D-20 SC-5).
Null-token semantics from Phase 9 D-09. Progress bar uses block
characters (ADR-0002) instead of a cli-progress dep.
