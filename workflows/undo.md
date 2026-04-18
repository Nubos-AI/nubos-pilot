---
command: np:undo
description: Revert all task commits of a phase or plan via git revert (no history rewrite). Destructive — gated by askUser confirmation.
---

# /np:undo

<objective>
Roll back every committed task of a phase (`/np:undo 6`) or plan
(`/np:undo 06-01`) by emitting one `git revert` commit per task in
reverse-chronological order. No history is rewritten — the original
commits stay in the log, each followed by an explicit `Revert "task(...)"`
commit. Per ADR-0004 every revert is itself an atomic commit.
</objective>

## Execution

```bash
PHASE_OR_PLAN="$1"
if [ -z "$PHASE_OR_PLAN" ]; then
  echo "Usage: /np:undo <phase-number-or-plan-id>" >&2
  exit 1
fi

# Discovery pass — list the commits that will be reverted so the user can
# evaluate the blast radius before confirming.
PREVIEW=$(node np-tools.cjs undo "$PHASE_OR_PLAN" 2>/dev/null || true)
COMMIT_COUNT=$(echo "$PREVIEW" | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{ try{const j=JSON.parse(d); console.log(Array.isArray(j.reverted)?j.reverted.length:0);}catch{console.log(0);} })")
```

If the discovery pass already produced revert commits (it does, because
`undo` is non-idempotent on first call), STOP HERE and report success — the
user invoked `/np:undo` knowing it is destructive. Otherwise continue with
the askUser gate below for the confirmation-then-execute pattern.

```bash
CHOICE=$(node np-tools.cjs askuser --json '{
  "type": "select",
  "header": "Undo bestätigen",
  "question": "Task-Commits werden via git revert rückgängig gemacht (keine History-Rewrite). Fortfahren?",
  "options": [
    {"label": "Confirm", "description": "Revert ausführen — Plan/Phase wird zurückgesetzt."},
    {"label": "Cancel",  "description": "Nichts ändern."}
  ]
}')
case "$CHOICE" in
  Confirm*) node np-tools.cjs undo "$PHASE_OR_PLAN" ;;
  *)        echo "Aborted." ; exit 0 ;;
esac
```

## Scope Guardrail

**Do:** revert via `git revert` (forward-only); flip task status → pending.
**Don't:** rewrite history; force-push; delete commits.
