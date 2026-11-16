---
command: np:skip
description: Mark a task as skipped (lifecycle CRUD). The task is excluded from wave-selection until it is unparked or its status is set back to pending.
argument-hint: <task-id>
---

# /np:skip

<objective>
Flip the task's frontmatter `status` field to `skipped`. The wave-selector
treats `skipped` like `done` for advancement purposes, so the next wave
can proceed without this task. No commit is made; the task file is rewritten
in place.
</objective>

## Execution

```bash
TASK_ID="$1"
if [ -z "$TASK_ID" ]; then
  echo "Usage: /np:skip <task-id>" >&2
  exit 1
fi
node .nubos-pilot/bin/np-tools.cjs skip "$TASK_ID"
```

## Scope Guardrail

**Do:** flip task status to `skipped` via `lib/tasks.setTaskStatus`.
**Don't:** revert commits; modify other frontmatter fields.

## Unlazy Discipline

Every step of this workflow runs under the [`np-unlazy`](../skills/np-unlazy/SKILL.md) skill. Before the first step, `Read` `.claude/skills/np-unlazy/SKILL.md` (Codex: `.codex/skills/np-unlazy/SKILL.md`) and keep its step contract for every section of this workflow: reread the request, name the section's gates before running it, re-verify evidence yourself instead of trusting a spawn's report, surface every dropped outcome as a handoff, and audit the final report against measured counts. Every agent spawn prompt carries `np-unlazy` in its `Use the following Nubos skills:` line; when the spawn has a task id, record it first with `node .nubos-pilot/bin/np-tools.cjs skill-audit expect --task "$TASK_ID" --skills "np-unlazy,…"`.

## Definition of Done

Lifecycle transition. Definition of Done, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 7 (Never leave a dangling thread) — skipped task carries reason and timestamp; STATE.md and frontmatter are updated atomically.
- Rule 11 (Ship the complete thing) — verifier sees the skip-marker; no silent disappearance.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
