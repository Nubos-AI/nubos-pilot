---
command: np:verify-work
description: Two-pass goal-backward verification after execution. Verifier agent classifies deterministic evidence; Pass-2 askUser loop resolves needs_user_confirm flags (D-21/D-22).
---

# /np:verify-work

<objective>
Verify that a just-executed phase actually satisfies the ROADMAP
`success_criteria`. Pass 1 = verifier subagent emits Pass/Fail/Defer with
evidence; Pass 2 = workflow askUser resolves any `needs_user_confirm`
items. Final artifact: `<phase_dir>/<padded>-VERIFICATION.md` (D-24 schema).
</objective>

## Initialize

```bash
PHASE="$1"
INIT=$(node np-tools.cjs init verify-work "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_VERIFIER=$(node np-tools.cjs agent-skills verifier 2>/dev/null)
```

Parse: `phase`, `padded`, `phase_dir`, `success_criteria`, `draft_results`,
`verification_path`, `verifier_tier`, `agent_skills`.

## Pass 1 — verifier agent

Spawn `agents/np-verifier.md` (tier: sonnet, READ-ONLY tools) with:
- `<files_to_read>` = [ROADMAP.md, PLAN.md(s), all task commits via
  `git log --grep='^task(<padded>-'`, each task's `files_modified`].
- `success_criteria` list from `$INIT`.

The agent emits a structured verdict per SC: Pass | Fail |
Needs-User-Confirm | Defer (never invents a SC, never edits source).

Persist the deterministic draft:

```bash
node np-tools.cjs init verify-work emit-draft "$PHASE"
```

## Pass 2 — user-driven gate for needs_user_confirm

For each result flagged `needs_user_confirm` by Pass 1, ask the user:

```bash
# Example — iterated by the workflow over each needs_user_confirm SC.
CHOICE=$(node np-tools.cjs askuser --json '{
  "type": "select",
  "header": "SC-3: UX feels responsive",
  "question": "Ist dieses Kriterium erfüllt?",
  "options": [
    {"label": "Pass",            "description": "Kriterium ist erfüllt."},
    {"label": "Fail",            "description": "Kriterium ist nicht erfüllt — Defekt."},
    {"label": "Defer",           "description": "Absichtlich zurückgestellt, später prüfen."},
    {"label": "Re-investigate", "description": "Brauche mehr Evidence — spawn Verifier nochmal."}
  ]
}')
node np-tools.cjs init verify-work record-sc "$PHASE" "SC-3" "$CHOICE"
```

## Hard-stop on Fail (D-23)

If any result ends with `status: Fail` after Pass 1 or Pass 2:

```bash
echo "[np:verify-work] Phase $PHASE hat Fail-Ergebnisse — LOUD FAIL." >&2
exit 1
```

## Scope Guardrail

**Do:** spawn `agents/np-verifier.md` with read-only tools; persist SC
updates via `record-sc`; exit non-zero on any Fail.
**Don't:** let the verifier edit source files; self-classify subjective
criteria (Pitfall 5); mask a Fail as Defer.

## Output

- `<phase_dir>/<padded>-VERIFICATION.md` written (D-24 schema).
- Phase status recorded as `verified | failed | deferred`.
- Ready for `/np:add-tests $PHASE` to persist Pass-SCs as UAT.
