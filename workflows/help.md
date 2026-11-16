---
command: np:help
description: List every available np-tools.cjs command grouped by category. Pass --json for programmatic consumption.
argument-hint: [--json]
---

# np:help

List every available `np-tools.cjs` command grouped by category. Pass `--json`
for programmatic consumption.

```bash
node .nubos-pilot/bin/np-tools.cjs help
```

## Unlazy Discipline

Every step of this workflow runs under the [`np-unlazy`](../skills/np-unlazy/SKILL.md) skill. Before the first step, `Read` `.claude/skills/np-unlazy/SKILL.md` (Codex: `.codex/skills/np-unlazy/SKILL.md`) and keep its step contract for every section of this workflow: reread the request, name the section's gates before running it, re-verify evidence yourself instead of trusting a spawn's report, surface every dropped outcome as a handoff, and audit the final report against measured counts. Every agent spawn prompt carries `np-unlazy` in its `Use the following Nubos skills:` line; when the spawn has a task id, record it first with `node .nubos-pilot/bin/np-tools.cjs skill-audit expect --task "$TASK_ID" --skills "np-unlazy,…"`.

## Definition of Done

Help reporter. Definition of Done, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 4 (Do it with documentation) — every command is listed; coverage gaps fail the workflow.
- Rule 5 (Genuinely impress) — descriptions are one-liners that name the deliverable, not abstractions.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
