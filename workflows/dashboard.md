---
command: np:dashboard
description: One-shot console dashboard of milestones, slices, and tasks. Read-only — no files written, no state mutated, no git commit.
---

# np:dashboard

Read-only snapshot of milestones, slices, and task statuses for the project.

```bash
node .nubos-pilot/bin/np-tools.cjs dashboard
```

That is the entire workflow. The CLI prints the snapshot to stdout — milestone-by-milestone, with one row per slice showing per-status counts plus a checkbox row of all tasks in the slice (`[ ]` pending, `[~]` in-progress, `[x]` done, `[-]` skipped, `[!]` parked).

## No Commit

Read-only. No files are written, no state is mutated, no git commit is made.

## Scope Guardrail

<scope_guardrail>
**Do:**
- Run the CLI with no arguments for the formatted view, `--json` for the raw snapshot, or `--no-color` for plain text.
- Treat the output as a render — re-run the workflow when you want a fresh view.

**Don't:**
- Add a long-running watch loop here — single-shot only, by design (ADR-0001).
- Mutate any state from this workflow — strictly read-only.
- Add additional sections beyond milestones / slices / tasks. Drill-down into handoffs / checkpoints / worktrees uses their dedicated commands.
</scope_guardrail>

## Output

Stdout only — formatted milestone overview with checkbox rows per slice. No files created. No state mutated. No git commit.

## Success Criteria

- [ ] Empty project renders the "No milestones yet" placeholder line.
- [ ] Every milestone in `roadmap.yaml` appears with its name and status.
- [ ] Every slice's checkbox row reflects current task frontmatter `status` values.
- [ ] `--json` emits the snapshot shape `{ milestones: [{ id, number, name, status, slices: [{ id, full_id, counts, task_statuses }] }] }`.
- [ ] `--no-color` emits no ANSI escape sequences.
- [ ] Zero file writes, zero state mutations, zero commits.

## Related Workflows

- **`/np:stats`** — phases-table + metrics aggregation (commit-history view).
- **`/np:state`** — current STATE.md frontmatter snapshot.
