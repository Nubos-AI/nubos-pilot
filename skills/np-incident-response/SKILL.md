---
name: np-incident-response
description: "Quality bar for changes that are risky or hard to reverse — feature flags, behavior gated on data state, data migrations coupled to code, or changes to external integrations. Triggered for executor work on high-blast-radius changes; encodes the reversibility and rollback-readiness checklist the change MUST satisfy before commit, not a runbook to author. Language- and framework-agnostic."
user-invocable: false
---

# Change Reversibility & Rollback Readiness

Reversibility is a property you design into a risky change, not something you bolt on after it breaks. Before you commit, you must already know how to undo it.

## Before editing
- Read existing conventions: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "<query>" --task $TASK_ID`.

## Know the reversal path
- Every risky change has one undo story: clean `revert`, flip a flag off, or a documented manual rollback. Pick one before writing code.
- If the only way back is "restore from backup," the change is not ready — make it cheaper to reverse.

## Gate new behavior
- Put new or risky behavior behind a flag/toggle so it can be disabled without a code change, redeploy, or hotfix.
- Default the flag to the old behavior; turning it ON is the deliberate act.
- Add a kill switch for anything that can misbehave under load or when an external system is slow or down.

## Keep data reversible
- Do not couple an irreversible data migration to the code that depends on it.
- Use expand/contract: add the new shape, backfill, switch reads, drop the old shape later — each step independently reversible.
- A rollback of the code must not leave data in a shape the old code cannot read.

## Blast radius
- Know what fails if this change fails: does it degrade gracefully, or take the system down with it?
- Isolate failure to the smallest surface — one feature, one path, one tenant — not the whole request.
- Leave a short runbook note where the project keeps them: what this changes, how to tell it's wrong, how to turn it off.

## Verification bar (must hold before commit)
- The change has a named reversal path: revert, flag-off, or a written manual rollback.
- New/risky behavior is behind a flag defaulting to old behavior; a kill switch exists for load- or integration-sensitive paths.
- Code is safe to roll back at any point: no data migration that the prior code can't tolerate (cross-link [np-data-modeling] for reversible expand/contract migrations).
- Failure degrades gracefully and is contained to a known blast radius, not the whole system.
- A short runbook note records what changed, how to detect it's wrong, and how to turn it off (cross-link [np-observability] for detection signals).
