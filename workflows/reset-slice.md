---
command: np:reset-slice
description: Crash-recovery. Discard the in-flight task (the one named in STATE.current_task), restore its files_modified from HEAD, delete its checkpoint, and clear STATE.current_task. No commit, no revert — use this when execute-phase crashed and you want a clean working tree.
argument-hint: [<task-full-id>]
---

# np:reset-slice

Drop the in-flight task without committing or reverting. This is the crash-recovery primitive `/np:execute-phase` advertises when its orphan-checkpoint guard fires.

What it does:

1. Reads `STATE.current_task` (or the explicit task id you pass).
2. Reads the task's `files_modified` from `T<NNNN>-PLAN.md` frontmatter.
3. Runs `git restore -- <files>` to wipe uncommitted changes to exactly those paths.
4. Deletes the checkpoint at `.nubos-pilot/checkpoints/<task-id>.json`.
5. Sets `STATE.current_task = null`.

**No commit, no revert.** The task was never committed — the work-in-progress edits are discarded from the working tree.

## Usage

```bash
/np:reset-slice                     # discard the task named in STATE.current_task
/np:reset-slice M001-S001-T0003     # explicit task id
```

## Guard

No argument required. If `STATE.current_task` is null **and** no explicit id was passed, the subcommand falls through to orphan-checkpoint cleanup (deletes any leftover `.nubos-pilot/checkpoints/*.json` and exits 0 with a message).

## Apply

```bash
RESULT=$(node np-tools.cjs reset-slice ${1:+"$1"})
echo "$RESULT" | jq .
```

Full-reset result:

```json
{
  "ok": true,
  "task_id": "M001-S001-T0003",
  "restored_files": ["src/auth/loginHandler.ts"],
  "deleted_checkpoints": ["M001-S001-T0003"],
  "message": "in-flight task discarded; working tree restored to HEAD"
}
```

Orphan-only result (no current_task):

```json
{
  "ok": true,
  "task_id": null,
  "restored_files": [],
  "deleted_checkpoints": ["M001-S001-T0002"],
  "message": "no current_task — cleared 1 orphan checkpoint(s)"
}
```

## Errors

| Code | Trigger | User action |
|------|---------|-------------|
| `reset-slice-invalid-task-id` | explicit id does not match `M<NNN>-S<NNN>-T<NNNN>` | Use the correct form |
| `reset-slice-no-state` | `.nubos-pilot/STATE.md` not readable | Run from inside a nubos-pilot project |

## Scope Guardrail

**Do:**
- Restore via `lib/git.cjs.restoreFiles` — never call `git restore` directly.
- Only restore the paths declared in the task's `files_modified` — never `git restore .` (blast radius).
- Clear `STATE.current_task` through `lib/state.cjs.mutateState` (single-writer lock).

**Don't:**
- Revert a committed task — use `/np:undo-task` for that.
- Run this after `commit-task` succeeded — the task is already in the log; use `/np:undo-task` to reverse it.
- Delete the task plan/summary files — they stay, so `/np:execute-phase` can re-pick the task as pending.

## Output

- Working tree: `files_modified` paths reset to HEAD.
- `.nubos-pilot/checkpoints/<task-id>.json`: deleted.
- `STATE.current_task`: null. `STATE.last_updated` refreshed.
- No git commit.
