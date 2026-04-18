# ADR-0005: Three Orthogonal File-Trees

* Status: Accepted
* Date: 2026-04-14
* Supersedes: None

## Context and Problem Statement

Three distinct concerns have historically been conflated in similar tools:

1. **What we (nubos-pilot contributors) author and commit** — the source repository.
2. **What we ship to end users via `npx nubos-pilot init`** — the install payload landing at the user's `.claude/nubos-pilot/`.
3. **What an end user's project accumulates** as they plan and execute with nubos-pilot — STATE.md, ROADMAP.md, phase directories, todos, checkpoints, metrics.

Mixing these three concerns produces two well-known failure modes:

* **Install bit-rot** — the "copy-paste N blocks to remove stale X" problem. When installer files and state files live in the same tree, "clean install" and "clean state" cannot be distinguished.
* **Contributor confusion** — authors cannot tell, for a given file, whether they are editing something that ships to users, something that only contributors see, or something users will mutate at runtime.

The question: how are these three concerns physically separated?

## Decision Drivers

* **Install correctness** — Phase 7's manifest-based installer (INST-01) needs a distinct payload subtree to manifest against. Mixing it with source code or project state makes the manifest incoherent.
* **Contributor clarity** — every file answers unambiguously: "do I edit this, does it ship, or does a user's project produce it?"
* **Removability** — end-user uninstall (INST-08, stale-install cleanup) must be able to operate on one well-defined tree without sweeping scattered files.
* **Avoiding bit-rot** — stale-install cleanup only works deterministically if payload boundaries are defined precisely enough to diff-check on reinstall.

## Considered Options

* **Three orthogonal file-trees** — Source tree / Install-Payload tree / Project-State tree, defined below. (CHOSEN)
* **Single tree with everything intermixed** — installer files, source files, and state files cohabiting in one location.
* **Two trees** — either merge Install-Payload into Source (ship the source tree directly), or merge Project-State into Install-Payload (state alongside installed tooling).

## Decision Outcome

Chosen: **"Three orthogonal file-trees"**. The three trees are enumerated in prose below; each tree has a distinct owner, lifecycle, and runtime location. This ADR asserts the boundary as a TEXT INVARIANT only — it does NOT create any of the trees beyond what Phase 1 authors (i.e. only the Source tree's `docs/adr/` subdirectory is materialized by this phase; see the scope disclaimer).

### The Three Trees

1. **Source tree** — what lives inside the nubos-pilot git repository (this monorepo subdirectory at `tools/nubos-pilot/`). **Owned by** contributors. **Lifecycle:** normal git. **Contains** (over time, as phases complete): a `bin/` subdir for the installer and the CLI helper, a `docs/` subdir (including `docs/adr/` authored now), a staging subdirectory whose contents become the install-payload after `npx nubos-pilot init` runs, a `.planning/` subdir with authoring-time planning artifacts (nubos-pilot's own ROADMAP / STATE / PLAN files), `CLAUDE.md`, `package.json`, and related author-facing artifacts. Committed.

2. **Install-Payload tree** — the subset of the Source tree that is copied onto an end user's machine when they run `npx nubos-pilot init`. **Owned by** the end user after install, but **managed** by the installer via a manifest. **Lifecycle:** overwritten on `npx nubos-pilot` reinstall; cleaned up via `np:doctor --fix` against the manifest (Phase 7, INST-01 / INST-05 / INST-08). **Runtime location** on the end user's machine: `.claude/nubos-pilot/` for Claude Code (primary), or `.agents/nubos-pilot/` for other runtimes (Codex/Gemini/OpenCode — forward-reference Phase 8). **Not materialized in this phase** — scaffolded in Phase 7 (INST-01 manifest install).

3. **Project-State tree** — state that end users' projects accumulate as they plan and execute: `STATE.md`, `ROADMAP.md`, `phases/<NN>-<slug>/` directories, `todos/pending/`, `backlog/`, `checkpoints/`, `metrics/`. **Owned by** the end user's project. **Lifecycle:** mutated only through nubos-pilot workflows under a single-writer lock (Phase 2, LIB-02). **Runtime location** on the end user's machine: `.nubos-pilot/`. **Not materialized in this phase** — scaffolded starting Phase 4 (base workflows + state schemas).

### Orthogonality Rule

**No file lives in two trees simultaneously at runtime.** A file is either source (in the contributor's repo), or payload (at the end user's install location), or state (in the end user's project) — **never two at once**. Workflow commands operate on exactly one tree per invocation; a single commit touches files in one tree at a time (see [ADR-0004](0004-atomic-commit-per-unit.md)).

### Source-vs-Install-Payload Overlap Nuance

The install-payload content ORIGINATES in the Source tree — it is authored by contributors in a staging subdirectory of the repo (e.g. `tools/nubos-pilot/nubos-pilot/…` as a suggested staging layout, finalized in Phase 7). **At install time**, the installer copies those files into a distinct tree at the end user's `.claude/nubos-pilot/` — a different filesystem location entirely. "Orthogonality" applies to **runtime locations** (what exists where when things are running), not to pre-install staging. Authoring in the Source tree is how Install-Payload files come to exist; they become the Install-Payload tree only after `npx nubos-pilot init` has run on the end user's machine. On the contributor's machine, only the Source tree is populated; on the end user's machine, only the Install-Payload and Project-State trees are populated (plus a snapshot of the payload staging subtree if the user also clones the repo, which is an unusual contributor-mode case).

### Scope Disclaimer for Phase 1

**Phase 1 materializes ONLY the Source tree** — specifically, `docs/adr/` and this ADR itself. Install-Payload and Project-State directories are **deferred**: the Install-Payload tree is scaffolded in Phase 7 (INST-01 manifest install), and the Project-State tree is scaffolded starting Phase 4 (base workflows + state schemas). **No `.gitkeep`, no empty staging directories, no skeleton subtrees are created in Phase 1.** This disclaimer is mandatory per CONTEXT.md D-09 and RESEARCH.md Pitfall 3.

### Consequences

* Good, because Phase 7 installer (INST-01) has a well-defined source-of-truth for manifest generation — the payload staging subtree inside the repo maps 1:1 to the installed content.
* Good, because uninstall and stale-cleanup (INST-05, INST-08) are mechanical — operate on the Install-Payload tree only; Project-State is never touched.
* Good, because `git log` on the nubos-pilot repo contains contributor work only — never end-user state churn (which lives on the user's machine, not in our repo).
* Good, because users can delete `.nubos-pilot/` to reset their state without disturbing the installed tool, or delete `.claude/nubos-pilot/` to uninstall without losing their plans.
* Bad, because contributors must remember the staging-subtree-vs-installed-payload distinction — mitigated by this ADR being linked from `bin/install.js` and CLAUDE.md once those artifacts exist in later phases.
* Neutral, because project-state schema evolves across Phases 2–4 — ADR-0005 is agnostic to the schema, only asserts the tree boundary.

## Pros and Cons of the Options

### Three orthogonal file-trees — chosen

* Good, because it maps cleanly to the three distinct owners (contributor / installed-tool / user-project) without overlap.
* Good, because each tree has a single, well-defined lifecycle operation (git-commit / npx-reinstall / workflow-mutate).
* Good, because it makes Phase 7's manifest-based installer (INST-01) implementable without heuristic boundaries.
* Bad, because contributors must mentally track the staging-vs-installed distinction — the ONE piece of nuance this model requires.

### Single tree with everything intermixed — rejected

* Good, because it is "simpler" in the sense of having fewer rules.
* Bad, because it reproduces the "copy-paste N blocks to remove stale X" bit-rot pattern — stale install files cannot be distinguished from stale state files when they cohabit.
* Bad, because a user who wants to reset state deletes things that look like state but may be installed-tooling, or vice versa.
* Bad, because manifest-based install becomes undecidable — the installer cannot tell a file it shipped from a file the user created.

### Two trees (merge source+payload, or payload+state) — rejected

* Good, because it reduces the tree count, superficially simpler.
* Bad — **merge source+payload:** ships contributor-only artifacts (planning docs, ADRs, internal notes) to end users, bloating installs and leaking internal state.
* Bad — **merge payload+state:** reintroduces the bit-rot failure mode exactly. A user's state lives alongside installed tooling; reinstall must then distinguish "state I should keep" from "tooling I should overwrite" — the very problem we're avoiding.
* Bad, because every 2-tree variant reintroduces one of the two failure modes the 3-tree split is designed to eliminate.

## More Information

* **Related ADR:** [ADR-0002](0002-zero-runtime-dependencies.md) — the Install-Payload tree contains only `.cjs` + markdown; no `node_modules/` subtree ever lives inside it.
* **Related ADR:** [ADR-0004](0004-atomic-commit-per-unit.md) — commits touch files in a single tree at a time (almost always the Source tree; end-user commits on their own repos are their business and out of nubos-pilot's scope).
* **REQUIREMENTS.md:** §"Install" → INST-01 (manifest-based install — Install-Payload tree is the consumer), INST-05 (`np:doctor` — Install-Payload tree), INST-08 (stale-install auto-cleanup — Install-Payload tree).
* **CLAUDE.md:** §"Technology Stack" → "Installation" — confirms the end-user install path `.claude/nubos-pilot/`.
* **CONTEXT.md:** D-09 — only `docs/adr/` is materialized in Phase 1; other trees are text invariant only.
* **RESEARCH.md:** Pitfall 3 — do NOT create Install-Payload or Project-State directories in this phase.
