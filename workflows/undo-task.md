---
command: np:undo-task
description: Revert a single task commit via git revert (no history rewrite) and reset the task's status to pending. Use this to surgically undo one task without touching the rest of the milestone.
argument-hint: <task-full-id>
---

# np:undo-task

Rollback exactly one task. Finds the task commit by grepping `git log --grep='^task(<task-id>):'`, runs `git revert --no-edit <sha>` (creating a new commit that inverts the change), and flips the task's `status:` frontmatter back to `pending`.

**No history rewrite.** The original `task(<id>)` commit stays in the log; a new `Revert "task(<id>): …"` commit lands on top. Re-running `/np:execute-phase <N>` will pick the task up again as pending.

## Usage

```bash
/np:undo-task M001-S001-T0003
```

## Guard

```bash
TASK_ID="$1"
if [[ -z "$TASK_ID" ]]; then
  echo "Usage: /np:undo-task <task-full-id>  (e.g. M001-S001-T0003)" >&2
  exit 2
fi
```

## Apply

```bash
RESULT=$(node .nubos-pilot/bin/np-tools.cjs undo-task "$TASK_ID")
echo "$RESULT" | jq .
```

On success the subcommand emits:

```json
{
  "ok": true,
  "task_id": "M001-S001-T0003",
  "reverted_sha": "abc1234…",
  "status": "pending"
}
```

## Errors

| Code | Trigger | User action |
|------|---------|-------------|
| `undo-task-missing-id` | no argument supplied | Pass a task full-id |
| `undo-task-invalid-id` | id does not match `M<NNN>-S<NNN>-T<NNNN>` | Use the correct form |
| `undo-task-commit-not-found` | no commit matches `^task(<id>):` | Task was never committed — nothing to undo |

## Scope Guardrail

**Do:**
- Route all git through `lib/git.cjs.revertCommit` — never call `git revert` directly.
- Reset the task frontmatter status via `setTaskStatus` so the next `/np:execute-phase` picks it up as pending.

**Don't:**
- Use `git reset --hard` or any history-rewriting flag.
- Touch sibling tasks. `/np:undo-task` operates on exactly one task.
- Delete the task plan/summary files — only the commit is reverted.

## Output

- One new `Revert "task(<id>): …"` commit on the current branch.
- Task's `T<NNNN>-PLAN.md` frontmatter: `status: pending`.
