---
command: np:session-report
description: Generate session report from metrics since .nubos-pilot/reports/.last-session pointer. Pointer update is file-lock-guarded (Pitfall 8). Output filename is ISO-8601-prefixed (YYYY-MM-DDTHHMM-session-report.md) for deterministic sort and no overwrite (D-17). Uses lib/metrics-aggregate.cjs.aggregateSession (D-18). One atomic docs commit.
argument-hint: [--since=<ISO-date>]
---

# np:session-report

Implements UTIL-07a. Produces a post-session markdown report
summarising metrics, commits, and progress since the last report.
Three deliberate design choices:

- **D-16 pointer file** — persists
  `.nubos-pilot/reports/.last-session` (ISO-8601 timestamp) so each
  report covers exactly "since last report" regardless of clock time
  (rather than a rolling 24h window that would double-count overlaps).
- **D-17 ISO-prefixed filename** — emits
  `YYYY-MM-DDTHHMM-session-report.md` so reports never overwrite and
  sort deterministically.
- **D-18 aggregation helper** — metrics come from
  `lib/metrics-aggregate.cjs.aggregateSession` (Plan 10-01-T02);
  workflow does not parse JSONL itself.

Pointer read + aggregation + write are wrapped in
`lib/core.cjs.withFileLock` (10s timeout per Pitfall 8, T-10-06-02
mitigation). Two concurrent `/np:session-report` invocations
serialise on the pointer so neither produces an overlapping report.

Pure-CRUD workflow — no agent spawn, no resolve-model, no metrics
record. Pitfall 9 / `workflow-missing-metrics` is exempt.

## Initialize

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
SINCE_OVERRIDE=""
for arg in "$@"; do
  case "$arg" in
    --since=*) SINCE_OVERRIDE="${arg#--since=}" ;;
  esac
done

STATE_DIR=$(node .nubos-pilot/bin/np-tools.cjs state-dir)
REPORTS_DIR="${STATE_DIR}/reports"
POINTER="${REPORTS_DIR}/.last-session"
mkdir -p "$REPORTS_DIR"

NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LOCAL_FILENAME_TS=$(date +"%Y-%m-%dT%H%M")
REPORT_PATH="${REPORTS_DIR}/${LOCAL_FILENAME_TS}-session-report.md"
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative. Obey it for the report's narrative
sections (summary, highlights, notable events) and any askuser prompts.
Task IDs, milestone IDs, commit SHAs, metrics keys, and file paths stay
canonical English. Supersedes CLAUDE.md.

**Text-mode routing.** Resolve once:

```bash
TEXT_MODE=$(node .nubos-pilot/bin/np-tools.cjs text-mode 2>/dev/null || echo false)
```

**Askuser routing.** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below is a spec, not a literal command. Pick the path once at Initialize:
- **Claude Code** (native `AskUserQuestion` tool is available): parse the JSON spec and call `AskUserQuestion` directly. `select` → `multiSelect: false`; `multiselect` → `multiSelect: true`; `confirm` → `options: [{label: "Yes"}, {label: "No"}]`; `input` → ask free-form in chat. Use a short `header` (≤12 chars).
- **`$TEXT_MODE == "true"`** (from the check above, or INIT payload `text_mode == true`): skip every askuser block and render questions as plain-text numbered lists. Opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.
- **Other runtime with TTY** (Codex, Gemini, …): execute the shell `askuser` block verbatim.

The filename format is `YYYY-MM-DDTHHMM-session-report.md` (D-17 —
4-char HHMM, no seconds, local time) so reports sort
lexicographically by invocation order.

## Pointer Read + Aggregation

Pointer read and metrics aggregation run inside a single
`withFileLock` call so a concurrent invocation cannot interleave
between "read pointer" and "write new pointer" (T-10-06-02 / Pitfall
8 mitigation). The lock times out at 10 000 ms; callers that wait
longer hit `lock-timeout` from `lib/core.cjs.NubosPilotError`.

```bash
if [[ -n "$SINCE_OVERRIDE" ]]; then
  REPORT_JSON=$(node .nubos-pilot/bin/np-tools.cjs session-aggregate --since "$SINCE_OVERRIDE")
else
  REPORT_JSON=$(node .nubos-pilot/bin/np-tools.cjs session-aggregate)
fi
```

The `aggregateSession` helper returns
`{since_iso, record_count, by_phase, total_tokens_in, total_tokens_out,
partial_tokens, total_duration_ms, error_count, phases_touched}`.
Null token values (non-claude runtimes per Phase 9 D-09) pass through
and are rendered as `—` in the output table.

## Render Report Body

Use the `Write` tool to create `$REPORT_PATH` with the body below
(not a bash heredoc per CLAUDE.md). Render values from
`$REPORT_JSON` using Node to produce the table rows (null-safe with
`—` for any null token fields, per D-09 / D-15).

```markdown
# Session Report — <NOW_ISO>

**Since:** <since_iso or "project inception">
**Records:** <record_count>
**Phases touched:** <phases_touched joined with comma>
**Total duration:** <total_duration_ms> ms
**Errors:** <error_count>

## By Phase

| Phase | Records | Tokens In | Tokens Out | Errors | Retry Sum |
|-------|---------|-----------|------------|--------|-----------|
| <phase> | <record_count> | <tokens_in or "—"> | <tokens_out or "—"> | <error_count> | <retry_count_sum> |
```

To produce the rendered body deterministically, the agent invokes a
short Node snippet that consumes `$REPORT_JSON` on stdin and emits
the markdown table rows — then feeds the full text to the `Write`
tool. The snippet shape:

```bash
BODY=$(node -e '
  const j = JSON.parse(process.argv[1]);
  const fmt = (v) => v === null || v === undefined ? "—" : String(v);
  const rows = Object.entries(j.by_phase || {}).sort()
    .map(([k, p]) => `| ${k} | ${p.record_count} | ${fmt(p.total_tokens_in)} | ${fmt(p.total_tokens_out)} | ${p.error_count} | ${p.retry_count_sum} |`)
    .join("\n");
  process.stdout.write(rows);
' "$REPORT_JSON")
```

## Update Pointer

AFTER the report file is written via `Write`, update the pointer
inside a second `withFileLock` call so a crash between "write report"
and "update pointer" leaves the pointer STALE — the next run
re-covers the missing period (safe-by-default).

```bash
node .nubos-pilot/bin/np-tools.cjs session-pointer-write "$NOW_ISO" > /dev/null
```

Using `atomicWriteFileSync` ensures the pointer update is crash-safe
(ADR-0004) — a mid-write crash leaves the OLD pointer intact, not a
truncated file.

## Commit

Both the new report and the updated pointer land in a single atomic
docs commit per ADR-0004. Route through `node .nubos-pilot/bin/np-tools.cjs commit`
so `lib/git.cjs.assertCommittablePaths()` validates the paths.

```bash
node .nubos-pilot/bin/np-tools.cjs commit "docs(10): add session report — ${LOCAL_FILENAME_TS}" \
  --files "$REPORT_PATH" "$POINTER"
```

## Report

```
Session report: $REPORT_PATH
  Since:   <since_iso from JSON>
  Records: <record_count>
  Pointer: $POINTER (updated to $NOW_ISO)
```

## Scope Guardrail

<scope_guardrail>
**Do:**
- Wrap pointer reads AND pointer writes in `withFileLock` (10s
  timeout per Pitfall 8, T-10-06-02 mitigation).
- Use local time `YYYY-MM-DDTHHMM` for the filename prefix (D-17 —
  no seconds; deterministic sort; no overwrite).
- Render `—` for null token fields (Phase 9 D-09 non-claude runtimes).
- Commit BOTH the report file AND the updated pointer in a single
  atomic commit (ADR-0004).
- Delegate all JSONL parsing to `lib/metrics-aggregate.cjs` (D-18
  schema single-source-of-truth).

**Don't:**
- Use a 24h rolling window (rejected per D-16 — two invocations in 12
  hours would double-count the overlap).
- Overwrite `SESSION_REPORT.md` (rejected per D-17 — previous reports
  would be lost on every run).
- Bypass `aggregateSession` for raw JSONL reads — schema guarantees
  come from the aggregator.
- Update the pointer BEFORE the report file write succeeds — a crash
  between the two would skip a session.
- Invoke host-specific prompt tools directly (the BARE_ASKUSER lint
  in `bin/check-workflows.cjs` blocks them) — route through
  `node .nubos-pilot/bin/np-tools.cjs askuser --json '…'`.
- Add a `metrics record` block. No Task/Spawn site; Pitfall 9 /
  `workflow-missing-metrics` is exempt.
</scope_guardrail>

## Output

- `.nubos-pilot/reports/YYYY-MM-DDTHHMM-session-report.md` — rendered
  markdown with session summary, per-phase table (null tokens as
  `—`), and metadata header.
- `.nubos-pilot/reports/.last-session` — pointer file updated to the
  current ISO-8601 UTC timestamp (atomic write; file-locked).
- One atomic git commit
  `docs(10): add session report — <local-ts>` containing both files
  (ADR-0004).

## Success Criteria

- [ ] `--since=<ISO>` argv override honoured when present.
- [ ] Reports directory created via `projectStateDir` +
      `mkdir -p` (no direct project-state reads).
- [ ] Pointer read AND pointer write both wrapped in `withFileLock`
      with `timeoutMs: 10000` (Pitfall 8 / T-10-06-02).
- [ ] Metrics aggregation via `lib/metrics-aggregate.cjs.aggregateSession`
      (D-18 — workflow never parses JSONL directly).
- [ ] Filename format `YYYY-MM-DDTHHMM-session-report.md` (D-17 —
      no overwrite, deterministic sort).
- [ ] Null token fields rendered as `—` in the Phase table (D-09 /
      D-15).
- [ ] Pointer update happens AFTER report write succeeds (stale
      pointer on crash is safer than skipped session).
- [ ] Pointer written via `atomicWriteFileSync` (ADR-0004 crash-safety).
- [ ] Single atomic commit via `np-tools.cjs commit` containing both
      report file and pointer.
- [ ] Lint clean under `bin/check-workflows.cjs` — no BARE_ASKUSER
      violations, no DIRECT_READ matches.

## Related Workflows

- **`/np:stats`** — stats snapshot (read-only, no pointer, no commit).
- **`/np:cleanup`** — archive completed milestones (distinct
  milestone-level aggregation).

## Design Notes

D-16 pointer file replaces any rolling-window approach with
deterministic "since last report" semantics. D-17 ISO-prefixed
filename makes reports append-only and deterministically sortable.
D-18 delegates metrics aggregation to `lib/metrics-aggregate.cjs`
(landed Plan 10-01-T02). Pitfall 8 mitigation wraps pointer access
in `withFileLock`.
