---
command: np:verify-work
description: Two-pass goal-backward verification after execution. Verifier agent classifies deterministic evidence; Pass-2 askUser loop resolves needs_user_confirm flags.
argument-hint: <milestone-number>
---

# /np:verify-work

<objective>
Verify that a just-executed milestone actually satisfies the ROADMAP `success_criteria`. Pass 1 = verifier subagent emits Pass/Fail/Defer with evidence; Pass 2 = workflow askUser resolves any `needs_user_confirm` items. Final artifact: `<milestone_dir>/<milestone_id>-VERIFICATION.md`.

Slice-level acceptance (UAT) is validated separately by `/np:validate-phase <N>` which reads each slice's `S<NNN>-UAT.md`.
</objective>

## Initialize

```bash
PHASE="$1"
INIT=$(node .nubos-pilot/bin/np-tools.cjs init verify-work "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_VERIFIER=$(node .nubos-pilot/bin/np-tools.cjs agent-skills verifier 2>/dev/null)
```

Parse: `milestone`, `milestone_id`, `milestone_dir`, `milestone_name`, `success_criteria`, `draft_results`, `verification_path`, `slice_uat`, `verifier_tier`, `agent_skills`.

## Pass 1 — verifier agent

Spawn `agents/np-verifier.md` (tier: sonnet, READ-ONLY tools) with:

- `<files_to_read>` = `[M<NNN>-ROADMAP.md, M<NNN>-CONTEXT.md, every S<NNN>-PLAN.md, every S<NNN>-SUMMARY.md, every T<NNNN>-PLAN.md + T<NNNN>-SUMMARY.md, all task commits via git log --grep='^task(M<NNN>-']`
- `success_criteria` list from `$INIT`.

The agent emits a structured verdict per SC: Pass | Fail | Needs-User-Confirm | Defer (never invents a SC, never edits source).

Persist the deterministic draft:

```bash
node .nubos-pilot/bin/np-tools.cjs init verify-work emit-draft "$PHASE"
```

## Pass 2 — user-driven gate for needs_user_confirm

For each result flagged `needs_user_confirm` by Pass 1, ask the user:

```bash
# Example — iterated by the workflow over each needs_user_confirm SC.
CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
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
node .nubos-pilot/bin/np-tools.cjs init verify-work record-sc "$PHASE" "SC-3" "$CHOICE"
```

## Hard-stop on Fail

If any result ends with `status: Fail` after Pass 1 or Pass 2:

```bash
echo "[np:verify-work] Milestone $PHASE hat Fail-Ergebnisse — LOUD FAIL." >&2
exit 1
```

## Scope Guardrail

**Do:** spawn `agents/np-verifier.md` with read-only tools; persist SC updates via `record-sc`; exit non-zero on any Fail.
**Don't:** let the verifier edit source files; self-classify subjective criteria; mask a Fail as Defer.

## Output

- `<milestone_dir>/<milestone_id>-VERIFICATION.md` written.
- Milestone status recorded as `verified | failed | deferred`.
- Ready for `/np:validate-phase $PHASE` to validate each slice's UAT.
