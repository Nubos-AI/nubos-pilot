---
name: np-system-design
description: "Quality bar for executor or architect work that designs a new system, module, or significant feature — introducing components, defining how they interact, or restructuring how responsibilities and state are split. Triggered when a change establishes structure others will build on, not isolated logic inside one existing unit. Encodes design rules the change MUST satisfy before commit, not a design document to author. Intent-level and language-agnostic: shapes responsibilities, data flow, and failure behavior — never file names or schema DDL."
user-invocable: false
---

# System Design

Good design is the cheapest design that meets the requirement and degrades predictably. Shape the components and their seams; resist solving problems the requirement does not pose yet.

## Before editing
- Read the project's existing architecture/conventions first: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "<query>" --task $TASK_ID`. Match the established idiom — a new component should look like it belongs.

## Responsibilities and boundaries
- Give each component a single, statable responsibility. If you cannot name it in one sentence without "and", split it or narrow it.
- Keep cohesion high inside a component and coupling low across the seam. The boundary, not the internals, is the load-bearing decision.
- Depend on the narrowest contract that does the job; do not reach across a boundary into another component's internals.

## Data flow and ownership
- Make ownership explicit: one component owns each piece of state; others read or request, they do not mutate it behind its back.
- Make the call graph explicit — who calls whom, in which direction. Avoid cycles between components.
- State sync vs async per interaction and justify async only where it earns its cost (latency, decoupling, backpressure); do not default to it.

## Simplicity and fit
- Choose the simplest structure that meets the stated requirement. No speculative abstraction, no extension point for a use case nobody asked for (YAGNI).
- Match design complexity to problem size: a small problem gets a small design. Adding layers, indirection, or a queue must be justified by a real, present constraint — not a hypothetical one.
- Prefer fewer moving parts. Every new component, hop, or shared mutable state is a cost that must pay for itself.

## Failure modes and testability
- Name how the design degrades: what happens when a dependency is slow, absent, or returns garbage. The answer must be a deliberate choice, not an accident.
- Design components to be exercisable in isolation — dependencies enter through the seam, so a component can be tested without standing up the whole system.

## Verification bar (must hold before commit)
- Each component has a single responsibility statable in one sentence; boundaries follow cohesion, not convenience (pair with [np-service-boundary] when a seam is non-trivial).
- State ownership is unambiguous and the call direction is acyclic; sync vs async is a stated decision, not a default.
- The design is the simplest that meets the requirement — no abstraction, layer, or generality without a present constraint that demands it.
- Failure behavior for each external dependency is named and intentional; the system degrades predictably rather than silently.
- Components are testable in isolation through their seams.
- The load-bearing decision and its rejected alternatives are stated inline; when it is architecturally significant, capture it via [np-adr].
- The design stays intent-level — responsibilities, flows, and contracts — and prescribes no file names or schema DDL.
