---
command: np:stats
description: Stats output — phases-table (name/plans/completed/status/%) + metrics aggregation (tokens-in/out per phase, avg duration by tier, retry_count_sum, error_rate). Consumes node np-tools.cjs stats json. Null-token runtimes render as `—` (Phase 9 D-09). Read-only — no commits, no STATE mutation.
argument-hint: [json]
---

# np:stats

Implements UTIL-07b. Renders an on-demand snapshot combining a
phases-table (phase / plans total / complete / status / percent)
with metrics aggregation (tokens-in / tokens-out per phase, avg
duration by tier, retry_count_sum, error_rate). Read-only surface
per D-20 SC-5 — no files written, no state mutated, no git commit.

The workflow delegates ALL data collection to
`bin/np-tools/stats.cjs` (landed Plan 10-01-T04), which emits a
`schema_version:1` JSON envelope on stdout. This workflow consumes
that JSON and renders markdown. No JSONL parsing inline.

Pure read-only workflow — no agent spawn, no resolve-model, no
metrics record. Pitfall 9 / `workflow-missing-metrics` is exempt.

## Initialize

```bash
STATS_JSON=$(node np-tools.cjs stats json)
if [[ -z "$STATS_JSON" ]]; then
  echo "No stats available (empty project?)" >&2
  exit 0
fi
```

The stats CLI produces the full payload — `{schema_version, milestone,
phases, plans_total, plans_complete, percent, git, last_activity,
metrics_by_phase}`. An empty project yields an empty JSON; the
workflow short-circuits gracefully rather than producing an empty
table.

## Render

Render the JSON as markdown via a `node -e` one-liner. Null token
cells render as `—` (Phase 9 D-09) so non-claude runtimes don't show
misleading zeros. Progress bar is a 20-char block-string
`[████░░░░░░…]` (ADR-0002 — no cli-progress dep).

Progress bar helper:

```javascript
const filled = Math.round(percent / 5);
const bar = "█".repeat(filled) + "░".repeat(20 - filled);
```

Null-safe token rendering:

```javascript
const fmt = (v) => v === null || v === undefined ? "—" : v.toLocaleString();
```

Rendered output sections: Project Stats header (milestone / progress
bar / last activity / commits / start date), Phases table (phase /
name / plans / complete / status / percent), Metrics by Phase table
(records / tokens / tier-avg durations / errors). Example row for a
phase with no metrics: `| 10 | — | — | — | — | — | — | — |`.

The full render is a single `node -e` call consuming `$STATS_JSON`:

```bash
node -e '
  const j = JSON.parse(process.argv[1]);
  const fmt = (v) => v === null || v === undefined ? "—" : (typeof v === "number" ? v.toLocaleString() : String(v));
  const filled = Math.round((j.percent || 0) / 5);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  const lines = [];
  lines.push("## Project Stats");
  lines.push("");
  lines.push(`**Milestone:** ${fmt(j.milestone && j.milestone.version)} — ${fmt(j.milestone && j.milestone.name)}`);
  lines.push(`**Progress:** [${bar}] ${j.percent || 0}% (${j.plans_complete}/${j.plans_total} plans)`);
  lines.push(`**Last activity:** ${fmt(j.last_activity)}`);
  lines.push(`**Commits:** ${fmt(j.git && j.git.commits)}`);
  lines.push(`**Project started:** ${fmt(j.git && j.git.first_commit_at)}`);
  lines.push("");
  lines.push("### Phases");
  lines.push("");
  lines.push("| Phase | Name | Plans | Completed | Status | % |");
  lines.push("|-------|------|-------|-----------|--------|---|");
  for (const ph of (j.phases || [])) {
    const pct = ph.plans_total > 0 ? Math.round(ph.plans_complete / ph.plans_total * 100) : 0;
    lines.push(`| ${ph.number} | ${ph.name} | ${ph.plans_total} | ${ph.plans_complete} | ${ph.status} | ${pct}% |`);
  }
  lines.push("");
  lines.push("### Metrics by Phase");
  lines.push("");
  lines.push("| Phase | Records | Tokens In | Tokens Out | Avg Opus ms | Avg Sonnet ms | Avg Haiku ms | Errors |");
  lines.push("|-------|---------|-----------|------------|-------------|---------------|--------------|--------|");
  for (const ph of (j.phases || [])) {
    const m = (j.metrics_by_phase || {})[ph.number];
    if (!m || m.record_count === 0) {
      lines.push(`| ${ph.number} | — | — | — | — | — | — | — |`);
      continue;
    }
    const t = m.avg_duration_ms_by_tier || {};
    lines.push(`| ${ph.number} | ${m.record_count} | ${fmt(m.total_tokens_in)} | ${fmt(m.total_tokens_out)} | ${fmt(t.opus)} | ${fmt(t.sonnet)} | ${fmt(t.haiku)} | ${m.error_count} |`);
  }
  process.stdout.write(lines.join("\n") + "\n");
' "$STATS_JSON"
```

## No Commit

Stats is read-only (D-20 SC-5). No files are written, no state is
mutated, no git commit is made. The markdown goes directly to stdout
and is rendered by the agent CLI.

## Scope Guardrail

<scope_guardrail>
**Do:**
- Consume `node np-tools.cjs stats json` — trust its
  `schema_version: 1` output shape (Plan 10-01-T04 contract).
- Render `tokens_in` / `tokens_out` as `—` when null (Phase 9 D-09
  non-claude runtimes; D-15 hybrid-output decision).
- Render the progress bar as a 20-char `[████░░…]` string (ADR-0002
  — no cli-progress dep).
- Keep the workflow read-only — no files written, no STATE mutated,
  no git commit (D-20 SC-5).

**Don't:**
- Re-implement JSONL aggregation inline — `lib/metrics-aggregate.cjs`
  owns the schema (D-18).
- Write any files — this workflow is a render, not a producer.
- Add a git commit — there is nothing to commit.
- Invoke host-specific prompt tools directly (the BARE_ASKUSER lint
  in `bin/check-workflows.cjs` blocks them) — route through
  `node np-tools.cjs askuser --json '…'` if prompts are ever added.
- Add a `metrics record` block. No Task/Spawn site; Pitfall 9 /
  `workflow-missing-metrics` is exempt.
</scope_guardrail>

## Output

- Markdown snapshot on stdout with Project Stats header, Phases
  table, and Metrics by Phase table.
- No files created. No state mutated. No git commit.

## Success Criteria

- [ ] Data sourced exclusively from `node np-tools.cjs stats json`
      (Plan 10-01-T04) — no inline JSONL parsing.
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

- **`/np:progress`** — base-workflow percent snapshot (subset).
- **`/np:session-report`** — commits a rendered report with
  since-last-session metrics (the producer pair for `/np:stats`).

## Design Notes

Phases-table + metrics aggregation combined per D-15. Stats CLI
(`bin/np-tools/stats.cjs`) is the single data source (D-20 SC-5).
Null-token semantics from Phase 9 D-09. Progress bar uses block
characters (ADR-0002) instead of a cli-progress dep.
