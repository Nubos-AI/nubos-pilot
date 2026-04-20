---
command: np:undo
description: Revert every task commit of a milestone (or a specific slice) via git revert. No history rewrite. Use this to roll back an entire milestone or a whole slice at once.
argument-hint: <milestone-number | slice-full-id>
---

# np:undo

Rollback many tasks at once. Walks `git log --grep='^task(<prefix>-'` newest-first, runs `git revert --no-edit` per commit, and flips every affected task's `status:` back to `pending`.

Two input shapes:

- **Milestone** — `1` or `M001` → reverts every task commit of milestone M001 across all slices.
- **Slice** — `M001-S002` → reverts only the tasks of that single slice.

**No history rewrite.** Original `task(…)` commits remain in the log; fresh `Revert "…"` commits land on top.

## Usage

```bash
/np:undo 1               # revert entire milestone M001
/np:undo M001-S002       # revert only slice S002 of M001
```

## Guard

```bash
PREFIX="$1"
if [[ -z "$PREFIX" ]]; then
  echo "Usage: /np:undo <milestone-number | slice-full-id>" >&2
  echo "  e.g. /np:undo 1          — revert milestone M001" >&2
  echo "       /np:undo M001-S002  — revert only slice S002" >&2
  exit 2
fi
```

## Apply

```bash
RESULT=$(node .nubos-pilot/bin/np-tools.cjs undo "$PREFIX")
echo "$RESULT" | jq .
```

On success the subcommand emits:

```json
{
  "ok": true,
  "prefix": "M001",
  "reverted": [
    { "sha": "abc…", "subject": "task(M001-S001-T0003): …", "task_id": "M001-S001-T0003" },
    { "sha": "def…", "subject": "task(M001-S001-T0002): …", "task_id": "M001-S001-T0002" },
    { "sha": "ghi…", "subject": "task(M001-S001-T0001): …", "task_id": "M001-S001-T0001" }
  ],
  "count": 3
}
```

Empty result (no matching commits):

```json
{
  "ok": true,
  "prefix": "M001",
  "reverted": [],
  "message": "no task commits found for prefix M001"
}
```

## Errors

| Code | Trigger | User action |
|------|---------|-------------|
| `undo-missing-prefix` | no argument supplied | Pass a milestone number or slice full-id |
| `undo-invalid-prefix` | argument does not match `<number>` or `M<NNN>[-S<NNN>]` | Use the correct form |

## Scope Guardrail

**Do:**
- Revert newest-first so dependency chains unwind cleanly (if `T0003` depended on `T0001`, the `T0003` revert lands first — the `T0001` revert after it has a clean base).
- Route every revert through `lib/git.cjs.revertCommit`.
- Reset task frontmatters via `setTaskStatus` after each revert.

**Don't:**
- Use `git reset --hard` or force-push.
- Pass a task full-id — use `/np:undo-task` for single-task rollback.
- Expect a merge-revert of a single combined commit — each task commit is reverted individually (ADR-0004 atomic-per-task).

## Output

- N new `Revert "task(…): …"` commits on the current branch (one per affected task).
- Every affected task's `T<NNNN>-PLAN.md` frontmatter: `status: pending`.
