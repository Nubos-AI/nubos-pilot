# ADR-0003: Max Six Unit-Types

* Status: Accepted
* Date: 2026-04-14
* Supersedes: None

## Context and Problem Statement

Planning ontologies tend to grow without upper bound — epics, stories, sub-stories, initiatives, spikes, tickets, tasks, subtasks. Each new type fragments workflows, multiplies templates, and forces the user to internalize yet another naming distinction. The question for nubos-pilot is: how many user-facing planning "unit-types" exist, and what are they?

For the purpose of this ADR, a **unit-type** is a user-facing, persistence-bearing noun with its own template, its own file path in the project-state tree, and its own lifecycle states. An AI prompt variable, an internal helper module (e.g. `lib/tasks.cjs`), a configuration key, or a subsection inside a file are **not** unit-types — they are implementation details invisible to the user's mental model.

## Decision Drivers

* **Transparency (Core Value)** — users must be able to mental-model the whole planning system without a reference card. A small type set keeps the system legible.
* **Cheatsheet-legible** — six named types still fit on a cheatsheet a user internalizes in minutes; growing beyond six would require invoking a reference.
* **Surface-area cost** — each type costs a template + a workflow verb + a state-machine chunk. N types produce on the order of `N × 3` artifacts that must stay in sync.
* **Cap-and-escape-hatch** beats **open-ended ontology** for a tool that is supposed to be "transparent" by Core Value.

## Considered Options

* **Cap at exactly six** — Milestone, Phase, Plan, Task, Todo, Backlog. (CHOSEN)
* **Open-ended type system** — let users define new unit-types at will (e.g. via configuration).
* **Flat "ticket" model** — a single unit-type with tags/categories replacing structural distinctions.

## Decision Outcome

Chosen: **"Cap at exactly six"**. The six types are enumerated below as running prose with one short paragraph per type. This enumeration is deliberately NOT a YAML block, NOT a fenced code snippet, and NOT a machine-parsed table — downstream agents do not auto-consume this list; workflows hard-code the six type names inside their own code. The list is authoritative prose for human readers (CONTEXT.md §specifics: "sie ist prose, keine Maschinen-Konvention").

### The Six Unit-Types

1. **Milestone** — a top-level project goal spanning multiple phases. Milestones live as entries in `ROADMAP.md`. A milestone's completion does not itself produce a commit (see [ADR-0004](0004-atomic-commit-per-unit.md) for the milestone exception); instead, editing ROADMAP.md to mark the milestone done is the atomic commit that records the milestone's completion.

2. **Phase** — a sequential slice of a milestone pursuing a single coherent goal. Each phase gets its own directory at `.nubos-pilot/phases/<NN>-<slug>/`, contains a PLAN.md, and has its own lifecycle (not-started → executing → complete). Phases are the primary unit most workflows operate on.

3. **Plan** — the `PLAN.md` inside a phase describing how the phase executes: waves, tasks, verification. There is typically one PLAN per phase, and it is authored by the `np:plan-phase` workflow and consumed by the execution workflows.

4. **Task** — an atomic unit of work inside a plan. Tasks are authored as `<task>` XML blocks inside PLAN.md by default. Promotion to standalone `tasks/*.md` files is permitted when parallelism, mixed model-tiers, or non-linear dependencies demand it (forward-reference PLAN-06). A task is the smallest unit that produces exactly one git commit ([ADR-0004](0004-atomic-commit-per-unit.md)).

5. **Todo** — a captured-on-the-fly idea that lives under `.nubos-pilot/todos/pending/` until it is scheduled. Todos are the lightweight capture path for ideas that surface during execution but don't yet belong to any plan. Promoted todos become tasks or backlog items as part of their scheduling.

6. **Backlog** — a deferred item parked under `.nubos-pilot/backlog/`. Backlog items are scheduled for later but not yet bound to a phase. They are heavier than todos (they carry rationale and rough scoping) and lighter than phases (they have no plan, no tasks yet).

All six names (Milestone, Phase, Plan, Task, Todo, Backlog) appear verbatim above; the `.nubos-pilot/phases/`, `.nubos-pilot/todos/`, `.nubos-pilot/backlog/` paths referenced here are text-invariant forward-references — **Phase 1 does not create any of these directories** (D-09, Pitfall 3). They are scaffolded in later phases (Project-State directories starting Phase 4).

### Consequences

* Good, because every workflow knows exactly which of the six types it operates on; no type-discovery logic is needed.
* Good, because the full type catalogue fits on a cheatsheet — new contributors and users can internalize it in minutes.
* Bad, because users coming from tools that use "epic", "story", "sprint", or "initiative" must map those concepts onto Milestone / Phase / Plan. This is an accepted trade-off and the mapping is usually obvious.
* Neutral, because adding a seventh type is not forbidden forever — it requires a new ADR per CONTEXT.md D-07 that supersedes or amends ADR-0003. The forcing function prevents casual ontology drift.

## Pros and Cons of the Options

### Cap at exactly six — chosen

* Good, because the six types cover every planning granularity we have encountered — Milestone and Backlog fill the gaps above and below the Phase/Plan/Task/Todo core.
* Good, because every type has a unique, obvious scope — nothing overlaps.
* Good, because `N × 3` artifact cost stays fixed and small.
* Bad, because there is no native notion of "epic" or "initiative" for users coming from Jira-like tools. Mitigated by the Milestone/Phase mapping documented above.

### Open-ended type system — rejected

* Good, because users with niche workflows could model their exact process.
* Bad, because it fragments the workflow library: every `np:*` command either handles unknown types gracefully (complexity) or errors on them (frustration).
* Bad, because template proliferation breaks the Core-Value transparency — a user can no longer know the whole system at a glance.
* Bad, because cross-project conventions break down — if every install has a different type set, shared tooling (verifier, planner, reviewer) must be defensive about everything.

### Flat "ticket" model — rejected

* Good, because it is the simplest possible ontology — "everything is a ticket".
* Bad, because it loses the granularity distinction between a 5-minute idea (Todo) and a 3-week milestone. Users end up re-creating hierarchy via tags, which is just a rebuilt ontology without the clarity.
* Bad, because users want the distinction between "idea captured mid-work" (Todo), "thing I will definitely do later" (Backlog), and "thing I am doing right now" (Task). Flattening loses all three.
* Bad, because workflow logic becomes branch-heavy (if ticket has no parent plan → behave as todo; if ticket has tasks → behave as plan) — the six-type cap replaces runtime branching with a static type tag.

## Enforcement

CI-gate enforcement against a seventh unit-type is deferred to a later deploy/CI phase per ROADMAP.md. Phase 1 enforcement consists of human review during PR review and this ADR as the authoritative reference. Future additions of a seventh type require a new ADR superseding or amending this one (CONTEXT.md D-07).

## More Information

* **Related ADR:** [ADR-0004](0004-atomic-commit-per-unit.md) — atomic-commit-per-unit binds the one-commit rule to each of the six types.
* **Related ADR:** [ADR-0005](0005-three-orthogonal-file-trees.md) — the Project-State tree is where five of the six types physically live (Milestones live in ROADMAP.md within the same tree).
* **REQUIREMENTS.md:** §"Foundation" row FND-03 — the canonical statement "Milestone/Phase/Plan/Task/Todo/Backlog, keine weiteren ohne ADR".
* **CONTEXT.md:** §specifics — "sie ist prose, keine Maschinen-Konvention" (why the enumeration stays prose).
