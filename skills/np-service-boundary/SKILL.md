---
name: np-service-boundary
description: "Quality bar for changes that introduce or move a module/service boundary — splitting a service, extracting a module, adding a cross-module dependency, wiring an event-driven or microservice seam. Triggered for architect/executor work that changes how parts of the system are divided and coupled. Encodes the coupling rules the change MUST satisfy before commit, not a design document to author. Language- and framework-agnostic."
user-invocable: false
---

# Service & Module Boundaries

A boundary is a commitment. It decides what can change cheaply and what can't. Draw it for a reason, expose the least you can, and make the dependencies point on purpose.

## Before editing
- Read the project's existing module structure first: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "<query>" --task $TASK_ID`. Match the established boundaries, names, and seams instead of inventing new ones.

## Boundaries follow cohesion
- Group what changes together; separate what changes independently. A boundary that forces two unrelated things to deploy in lockstep, or splits one thing across two modules, is in the wrong place.
- Split into a separate service or module only for a real, present reason: independent scaling, independent deploy, or a distinct owner. Never split by reflex, by layer, or "for cleanliness."
- A wrong boundary is expensive to undo. When unsure, keep it inside one module — extracting later is cheap; collapsing a premature split is not.

## Dependency direction is deliberate
- Dependencies are acyclic. No A→B→A. If you reach for a circular dependency, the boundary is wrong.
- Depend on abstractions and stable things, not on volatile internals. Point arrows toward what changes least.
- A boundary exposes an explicit, minimal contract. Internals — schemas, helpers, storage shape — stay private. Callers reaching past the contract into internals is the coupling you are here to prevent.

## Sync vs async is a choice
- A network or process hop is a failure boundary, not a free function call. The other side can be slow, absent, or duplicate the call — handle it (see [np-system-design] for timeouts and retries).
- Choose synchronous only when the caller genuinely needs the result now and can wait. Otherwise prefer async/event-driven so the caller is not coupled to the callee's availability.
- Event-driven decoupling fits where producers and consumers should not know each other. The producer emits a fact; it does not call consumers or assume who listens. Adding a consumer must not require touching the producer.

## Verification bar (must hold before commit)
- The boundary maps to a cohesion or ownership reason that is stated, not assumed — and a new service/module split has a real independent-scaling, deploy, or ownership justification.
- The dependency graph stays acyclic; new dependencies point toward more stable abstractions, not volatile details.
- Each boundary exposes a minimal explicit contract; callers do not reach into internals, and internals are not widened to satisfy one caller.
- Sync vs async is chosen deliberately; every process/network hop is treated as a failure boundary, not assumed reliable (cross-check [np-system-design]).
- Cross-boundary calls match the surrounding contract and error conventions (see [np-api-design]); async hops use the established messaging seam (see [np-queue-design]).
- Event producers stay ignorant of consumers; adding or removing a consumer touches no producer code.
