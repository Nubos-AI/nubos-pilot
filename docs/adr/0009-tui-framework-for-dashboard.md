# ADR-0009: TUI Framework for Interactive Dashboard (Amendment to ADR-0002)

* Status: **Accepted — Option D (no TUI framework adopted)**
* Date: 2026-04-23
* Accepted: 2026-04-23
* Amends: [ADR-0002](0002-zero-runtime-dependencies.md) — **no amendment takes effect.** ADR-0002's `dependencies: []` invariant stays intact.
* Relates-to: [ADR-0001](0001-no-daemon-invariant.md), [ADR-0006](0006-yaml-dependency-amendment.md)

## Context and Problem Statement

The one-shot dashboard (`np-tools.cjs dashboard`, ADR-0008 adjacent, already shipped) renders milestone/slice/handoff/worktree state as a formatted block with ANSI colors, plus an optional `--watch <seconds>` mode that repeatedly clear-screens and re-renders. This satisfies read-only inspection well.

A second user-facing surface is being requested: an **interactive** dashboard that supports keyboard-driven navigation — arrow keys through milestones/slices, `Enter` to drill into handoffs or task plans, `s`/`p` hotkeys to `skip`/`park` tasks in flight, flicker-free differential repainting. This is a concrete usability ask, not speculative scope.

The question: **does nubos-pilot adopt a terminal-UI library to implement this, and if so, which one?**

ADR-0002 makes `dependencies: []` the invariant. Only `yaml@^2.8` has been amended in (ADR-0006). Any TUI library is a new runtime dependency — so a new amendment is required per the ADR lifecycle.

## Decision Drivers

* **Install-anywhere preservation** — every extra transitive dep is payload size pulled on every `npx nubos-pilot` run.
* **Supply-chain surface** — each dep (and each of its transitives) is attack surface and a future maintenance risk.
* **Feature value** — does the interactive surface justify the cost?
* **Maintenance status** — nubos-pilot survives by zero-surprise dependencies; a library abandoned by its author is a liability we do not want to inherit.
* **ADR-0001 preservation** — a TUI library must not pull in a long-running daemon. Foreground, synchronous, user-interactive processes are fine (analog to `htop` / `top`).

## Considered Options

* **A — Adopt `ink` + React** — "React for the terminal", virtual-DOM diffing, component model, flicker-free repaint.
* **B — Adopt `neo-blessed`** — fork of Christopher Jeffrey's `blessed`, maintained, ncurses-style widget framework. No React.
* **C — Home-grown TUI on `readline` + ANSI escapes** — no dep. Manual cursor movement, manual double-buffer to avoid flicker, manual key-binding dispatch.
* **D — Do nothing, ship only A+B (one-shot + `--watch`)** — no new dep, no interactive surface. Accept that drill-down lives in separate `handoff-read <id>` / `render-todo <slice>` calls.

## Decision Outcome

**Chosen: Option D — no TUI framework, no dependency.** The existing one-shot + `--watch` dashboard (shipped alongside ADR-0008) remains the only dashboard surface. Interactive drill-down is served by composing the existing CLI commands (`handoff-list`, `handoff-read`, `render-todo`, `checkpoint show`) — no bespoke TUI.

ADR-0002's `dependencies: []` invariant (as amended by ADR-0006 for `yaml`) remains unchanged. No new runtime dependency is introduced by this ADR.

### Why Option D was chosen

1. **A+B already cover 80% of the value.** Read-only status at-a-glance is what most people mean by "dashboard". Drill-down is one CLI command away.
2. **The drill-down surface exists already:** `handoff-read`, `render-todo`, `checkpoint show`, `metrics record`. All callable without a custom TUI.
3. **Any dep is a one-way door** for `nubos-pilot`, given the install-anywhere promise. Reversing it later is a second ADR cycle.
4. **Interactive hotkey mutation** (e.g. `p` to park a task from the dashboard) is a convenience, not a capability — `np:park <task-id>` already exists.

### Revisiting this decision

If concrete interactive-workflow gaps emerge from real use that A+B + existing CLI cannot serve, this ADR should be **superseded** (not rewritten) by a new ADR that adopts a specific framework. The recommended order at that time:

* **B — `neo-blessed`** first: minimal transitive tree, no React, API stable, one library to audit.
* **A — `ink`** second: React baggage (hooks, fiber, dev-tools) for a status view is heavy. The React mental model is a force-multiplier for teams already fluent in it; standalone it is overhead.
* **C — home-grown** last: feasible but expensive. Cursor math, key-binding dispatch, double-buffer, Unicode-width calculation, terminal-capability detection — all must be hand-written. For a feature that's "nice to have" this trade is poor.

### Consequences per option

**If A (ink) is chosen:**
- Good: React-literate maintainers can iterate fast.
- Good: Flicker-free diff repainting via Virtual-DOM.
- Bad: React transitive tree (`react`, `react-reconciler`, scheduler, several small utility libs). Several MB of install payload per `npx` invocation.
- Bad: Ties the TUI to React's LTS cadence.

**If B (neo-blessed) is chosen:**
- Good: Smaller install payload, no React.
- Good: Battle-tested widget set.
- Bad: API is old-style (event-emitter + imperative layout). Not as ergonomic as ink's React model.
- Bad: Maintenance is best-effort; the upstream `blessed` was abandoned and `neo-blessed` is a small-volunteer fork.

**If C (home-grown) is chosen:**
- Good: Zero dependencies. ADR-0002 stays unbent.
- Good: Full control of rendering semantics.
- Bad: Weeks of work that duplicate what libraries already do well.
- Bad: Every new TUI feature is a manual re-implementation of patterns libraries give for free.

**If D (no interactive) is chosen:**
- Good: Status quo preserved; A+B ship as-is.
- Good: One less future-breakage risk.
- Bad: Users who wanted keyboard-driven drill-down get a CLI-composition answer instead.

## Consequences

**Good, because:**
- ADR-0002's `dependencies: []` invariant (as amended by ADR-0006 for `yaml`) stays intact. Install-anywhere story is unchanged.
- No new supply-chain surface. No CVE triage, no maintainer hand-off risk.
- One less future-breakage risk.

**Bad, because:**
- Users who want keyboard-driven drill-down get a CLI-composition answer instead. `handoff-list --for X --status open | jq …`, then `handoff-read $(…)`, then `render-todo M001-S001`.
- If a concrete workflow gap emerges later, we pay the full ADR-cycle cost to revisit.

## More Information

* Dashboard A+B already ships: `lib/dashboard.cjs`, `bin/np-tools/dashboard.cjs`, with `--json`, `--no-color`, `--watch [sec]` flags.
* Interactive drill-down composes existing commands — `handoff-list --for X --status open | jq …`, `handoff-read $(…)`, `render-todo M001-S001`.
* If this ADR is ever superseded to adopt a framework, `lib/dashboard.cjs` (snapshot collector) is already framework-agnostic and can be reused as-is.
