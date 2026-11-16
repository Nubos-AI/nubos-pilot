---
name: np-adr
description: "Quality bar for the reasoning behind an architecturally significant decision — a datastore choice, sync vs async, a new external dependency, an auth model, a public contract, or any choice that is costly to reverse, spans multiple components, or constrains future work. Triggered for architect/planner/executor work that makes such a call (typically captured in the milestone ARCHITECTURE artifact). Encodes the decision-recording discipline the reasoning MUST satisfy, not a mandate to author a separate document. Language- and framework-agnostic."
user-invocable: false
---

# Architecture Decision Records

A significant decision with no recorded alternatives is a guess wearing a suit. This bar governs the reasoning you commit when you make an architecturally significant call — np's architect already emits ADR-style decisions into the milestone ARCHITECTURE artifact; this is the quality bar for that reasoning, not an instruction to spawn new files.

## Before editing

- Check whether the decision is already recorded or constrained: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "<decision topic>" --task $TASK_ID`. If a prior ADR-style decision already covers this, you are superseding it — say so explicitly; don't silently contradict it.

## What is worth recording

- **Significant only.** Record a decision when it is costly to reverse, affects multiple components, introduces a new external dependency, or constrains future choices: datastore choice, sync vs async, an auth/permission model, a public contract, a serialization format. Ignore the trivial — a local variable name or a one-file refactor is not an ADR.
- **One decision per record.** Don't bundle "we'll use Postgres and also restructure auth" — split them. Each stands or falls on its own forces.

## What the record must capture

- **Context / forces.** The constraints and pressures that make this a real decision — load, team, deadlines, existing stack, compliance. Without forces the decision looks arbitrary later.
- **The decision.** Stated plainly, in the active voice: what was chosen.
- **Consequences, good and bad.** Name what this buys you *and* what it costs — the lock-in, the new failure mode, the operational burden. A record listing only upsides is marketing, not engineering.
- **Alternatives considered and why rejected (load-bearing).** This is the value. At least one real alternative with the concrete reason it lost. "We considered X but rejected it because Y" — no Y means no decision was actually made.

## Timing & immutability

- **Record at decision time, not retroactively.** Reconstructed reasoning launders out the forces that were actually live; capture it while the trade-off is still in your hands.
- **Immutable once accepted.** Don't rewrite an accepted decision — supersede it with a new one that references the old. The history of *why we changed our minds* is itself the asset.

## Verification bar (must hold before commit)

- The decision is genuinely significant (hard to reverse / cross-component / constrains the future) — trivial calls are not recorded as ADRs.
- At least one real rejected alternative is named *with* its reason; consequences list both the wins and the costs.
- It is a single decision, recorded now (not reconstructed), and any prior decision it overrides is explicitly superseded, not silently edited.
- The forces tie to the actual system constraints — cross-check the structural framing against [np-system-design] and any boundary impact against [np-service-boundary].
