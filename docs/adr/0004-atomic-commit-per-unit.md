# ADR-0004: Atomic Commit per Unit

* Status: Accepted
* Date: 2026-04-14
* Supersedes: None

## Context and Problem Statement

Executor agents must produce a legible, reversible git history. Two anti-patterns destroy that property:

1. **Bundling** — a single commit that touches multiple units (e.g. two tasks + a plan edit in one commit). This makes `np:undo-task` impossible: there is no clean `git revert` for "only this one task".
2. **Splitting** — a single unit that spans multiple commits (e.g. "part 1 of task N", "part 2 of task N"). This makes `np:undo` incoherent: which commit represents the unit?

The question: what is the commit-to-unit mapping that makes phase-level, plan-level, task-level, and slice-level undo mechanically implementable?

## The Rule

**Every completed unit (Phase, Plan, Task, Todo, Backlog-move) produces exactly one git commit. A commit never bundles more than one unit. A unit never produces zero or two commits.**

This is the atomic-commit-per-unit invariant. It is the property the EXEC-06 (`np:undo`), EXEC-07 (`np:undo-task` / `np:reset-slice`), and EXEC-09 (Executor-Subagent) requirements rely on for their implementation.

### Milestone Exception

A Milestone is one of the six unit-types (ADR-0003) but **a Milestone completion is not itself a separate commit**. A milestone is represented by an entry in `ROADMAP.md`; marking it done is an edit to `ROADMAP.md` which is itself a unit-level commit (with commit-type `milestone(…)`). There is no "magic milestone commit" separate from the ROADMAP.md edit. Readers should not expect one.

## Decision Drivers

* **Reversibility** — `np:undo`, `np:undo-task`, and `np:reset-slice` all rely on the 1:1 commit-to-unit mapping; without it, these commands cannot be implemented as mechanical `git revert <sha>` operations.
* **Legibility** — `git log --oneline` reads like a plan-trace; each line corresponds to one unit completion. Reviewers, operators, and future-us can understand the project's progress from git alone.
* **Audit** — code review can proceed per-unit: a reviewer sees exactly what one unit changed, without having to mentally extract task-N from a mixed-unit commit.

## Considered Options

* **One atomic commit per unit** — the rule stated above. (CHOSEN)
* **Squash-at-phase-boundary** — authors produce many small commits during execution, then squash the whole phase into one commit at phase-end.
* **One commit per file change** — commit granularity is tied to file count, not semantic unit count.
* **No commit discipline** — the executor commits whenever it feels like it (developer's choice).

## Decision Outcome

Chosen: **"One atomic commit per unit"**, because it is the only option that makes EXEC-06 and EXEC-07 implementable as mechanical `git revert <sha>` operations. Every other option forces `np:undo-task` into either "impossible" (squash, no-discipline) or "brittle" (one-commit-per-file with heuristics about "which files belong to task N").

### Commit Message Format

Every unit-producing commit uses the prefix:

```
<type>(<phase>-<plan>-<task>): <unit title>
```

Where `<type>` is the lowercased unit-type name from ADR-0003: `phase`, `plan`, `task`, `todo`, `backlog`, or `milestone`. The `<phase>-<plan>-<task>` identifier is elided to the granularity of the unit (e.g. a Phase commit uses just `phase-03`; a Task commit inside Phase 3 Plan 2 Task 4 uses `phase-03-02-04` or similar). The exact punctuation and ordering of the identifier is Claude's-discretion in Phase 6 when the Executor-Subagent is authored; this ADR asserts only (a) the one-commit-per-unit rule and (b) the type-prefix convention. Later ADRs or the Phase-6 PLAN.md may refine the identifier format without superseding ADR-0004, provided the atomicity rule remains intact.

### Consequences

* Good, because `np:undo-task`, `np:reset-slice`, and `np:undo` each map to a well-defined set of commits — implementation reduces to `git log --grep=<type>(<id>)` + `git revert <sha>`.
* Good, because `git log --oneline` reads as a progress report; `git log --grep='phase-03'` filters one phase cleanly.
* Good, because code review can proceed per-unit: reviewers see one unit per commit with no extraction work.
* Good, because no daemon is required to enforce atomicity ([ADR-0001](0001-no-daemon-invariant.md)) — the Executor-Subagent enforces it in-session at commit time.
* Bad, because small units produce many commits. Accepted — `git log --grep 'phase-03'` filters by phase; squash-merge at PR boundary is still available if a maintainer chooses.
* Neutral, because PR-level squash-merging is compatible with this rule, provided per-unit atomic commits are preserved on the feature branch. The rule governs the executor's output, not the eventual merged-to-main shape.

## Pros and Cons of the Options

### One atomic commit per unit — chosen

* Good, because it makes EXEC-06 / EXEC-07 implementable as mechanical revert operations.
* Good, because it produces self-documenting git history.
* Good, because the one-to-one mapping is a well-understood git-discipline pattern with no novel enforcement cost.
* Bad, because commit count grows linearly with plan complexity — accepted; modern git tooling handles thousands of commits trivially.

### Squash-at-phase-boundary — rejected

* Good, because it produces a tidy "one commit per phase" history on main.
* Bad, because it destroys task-granularity undo: `np:undo-task` has no commit to revert once the phase is squashed.
* Bad, because crash-recovery loses intermediate state — if the agent crashes mid-phase, a partial squash either does not exist (work lost) or is incoherent (partial phase as one commit).
* Bad, because a verifier that wants to re-verify a single task after the phase is merged cannot isolate that task's diff.

### One commit per file change — rejected

* Good, because it produces the smallest possible commits.
* Bad, because it couples commit count to file count, not semantic unit count. A task that modifies 5 files produces 5 commits; a task that modifies 1 file produces 1 commit. `np:undo-task` then needs a heuristic — "which file-commits belong to this task?" — that the one-commit-per-unit rule eliminates entirely.
* Bad, because it breaks the mental model: readers can no longer equate "one entry in git log" with "one unit in the plan".
* Bad, because commit messages become meaningless ("add line to foo.md") rather than intentional ("complete task N").

### No commit discipline — rejected

* Good, because it requires the least process.
* Bad, because it breaks `np:undo-task` by construction — there is no deterministic commit-to-task mapping to revert.
* Bad, because it makes code review per-unit impossible.
* Bad, because two executor agents working the same plan at different times produce non-comparable histories.

## More Information

* **Related ADR:** [ADR-0001](0001-no-daemon-invariant.md) — the commit happens in the invoking agent's session, not in a background worker; no daemon holds a write-lock across sessions.
* **Related ADR:** [ADR-0003](0003-max-six-unit-types.md) — defines the six unit-types this rule binds to.
* **Related ADR:** [ADR-0005](0005-three-orthogonal-file-trees.md) — commits touch files in a single tree at a time (typically Source or Project-State; the Install-Payload tree at the user's install location is never committed from the user's side).
* **REQUIREMENTS.md:** §"Execution" → rows EXEC-06 (`np:undo`), EXEC-07 (`np:undo-task` / `np:reset-slice`), EXEC-09 (Executor-Subagent — atomic-commit-per-unit enforced).
* **CLAUDE.md:** §"Workflow Enforcement" — establishes atomic-commit-per-unit as the executor invariant.

---

*CI-gate enforcement of atomic-commit-per-unit (e.g. an automated rejection of multi-unit commits) is deferred to a later deploy/CI phase per ROADMAP.md. Phase 1 enforcement = human review and this ADR as the authoritative reference.*
