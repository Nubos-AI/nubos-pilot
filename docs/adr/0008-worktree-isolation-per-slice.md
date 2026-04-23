# ADR-0008: Worktree Isolation per Slice

* Status: **Accepted**
* Date: 2026-04-23
* Accepted: 2026-04-23 (all 11 decisions D-8.1..D-8.11 ratified at defaults)
* Supersedes: None
* Relates-to: [ADR-0001](0001-no-daemon-invariant.md), [ADR-0004](0004-atomic-commit-per-unit.md), [ADR-0005](0005-three-orthogonal-file-trees.md)

## Context and Problem Statement

Today the `np-executor` edits, verifies, and commits directly on the user's active branch. Three failure modes follow:

* **Cross-contamination** — if execution is interrupted mid-slice (crash, timeout, manual abort), half-applied edits pollute the user's working tree. Recovery requires manual `git restore` judgment calls.
* **No inspection point** — once a slice is merged (or aborted) its intermediate state is lost. Post-mortem analysis of "what did the executor do before it broke" requires git-stash archaeology.
* **No parallelism pathway** — two unrelated slices of the same milestone cannot run concurrently because they share one working tree. Even when parallelism is NOT the immediate goal, the single-working-tree assumption blocks it forever.

Octogent (hesamsheikh/octogent) solves adjacent problems via per-job "tentacle" worktrees. The question is whether a similar isolation layer fits nubos-pilot without violating existing invariants (ADR-0001 no-daemon, ADR-0004 atomic commits, ADR-0005 three file-trees).

## Decision Drivers

* **Reversibility** — a failed slice must not leave the user's working tree dirty. Rollback = delete worktree.
* **Inspectability** — post-execution, the worktree of a slice (passed or failed) can be opened in an editor and examined like any git-checkout.
* **No-daemon preservation** — the mechanism must work with plain `git worktree add/remove` inside the bash blocks of each workflow; no long-running coordinator, no RPC.
* **ADR-0004 preservation** — atomic-commit-per-unit survives. Each task commit lands as-is on the slice branch; merge-back must be fast-forward so history stays linear and `np:undo-task` still resolves to a single SHA.
* **ADR-0005 preservation** — the Project-State tree (`.nubos-pilot/`) stays single-writer-single-location; worktrees reference it, do not duplicate it.
* **Backward compatibility** — existing projects and existing slices must continue to work without worktree mode. The feature is additive, not a hard migration.
* **Host-simplicity** — nubos-pilot must not require the user to clean up stray worktrees manually in the common case.

## Considered Options

* **A — Status quo (no worktree isolation).** Rejected: the failure modes above are real and will only compound as nubos-pilot is used on longer milestones.
* **B — Worktree per task.** Rejected: per-task worktrees multiply disk usage and setup/teardown cost without proportional benefit — tasks within a slice are already atomic via ADR-0004; the isolation need is at slice boundaries (multiple tasks running as one unit of work).
* **C — Worktree per slice, opt-in via config, merge-back fast-forward.** **Chosen.**
* **D — Branch-only isolation (no separate working tree).** Rejected: still shares one working tree across slices; solves nothing that's actually broken.
* **E — External worktree location (`~/.nubos-pilot/worktrees/<hash>/`).** Rejected: cross-project path management, cleanup ambiguity, surprises for users who expect `rm -rf .nubos-pilot/` to remove everything.

## Decision Outcome

Chosen: **Option C — Worktree per slice, opt-in via config, merge-back fast-forward.**

### Open Decisions (need explicit sign-off before implementation)

The ADR captures the currently-recommended defaults; each is marked **[DEFAULT]** and the alternative is documented so a reviewer can dissent before code is written.

#### D-8.1 — Activation

* **[DEFAULT]** Opt-in via `workflow.worktree_isolation: false` in `.nubos-pilot/config.json`. Default off.
* **Alternative:** Default on for all new projects (detected via absent config key).
* **Rationale for default:** Additive feature; zero surprise for existing projects. Opting in is one line of config.

#### D-8.2 — Worktree Location

* **[DEFAULT]** `.nubos-pilot/worktrees/<milestone-id>/<slice-id>/` — inside the Project-State tree.
* **Alternative A:** `../<repo-name>-worktrees/<milestone-id>/<slice-id>/` — sibling directory.
* **Alternative B:** `~/.nubos-pilot/worktrees/<project-hash>/…` — user-home, cross-project.
* **Rationale for default:** Matches octogent convention; single cleanup target (`rm -rf .nubos-pilot/`); survives ADR-0005 because worktrees are a git-runtime artifact adjacent to state (analog to `.nubos-pilot/checkpoints/`), not a fourth file-tree.

#### D-8.3 — Shared State Resolution

* **[DEFAULT]** `.nubos-pilot/` lives **only** in the main workspace. The worktree references it via its absolute path (resolved on worktree-create, stored in `.nubos-pilot/worktrees/<mid>/<sid>/.np-origin` for recovery).
* **Alternative:** Symlink `.nubos-pilot/` into each worktree.
* **Rationale for default:** Symlinks break on Windows without developer mode; absolute-path reference is portable. All CLI commands already accept a `cwd` argument — we pass the main-workspace path explicitly from inside the worktree.

#### D-8.4 — Branch Naming

* **[DEFAULT]** `np/<milestone-id>-<slice-id>` (e.g. `np/M001-S001`).
* **Alternative:** `np/<milestone-id>-<slice-id>-<slug>`.
* **Rationale for default:** Deterministic, short, scriptable. Slug adds no machine value and may drift from the slice-name frontmatter.

#### D-8.5 — Base Branch

* **[DEFAULT]** Worktree branches off the **current HEAD of the invoking workspace** at slice-start time.
* **Alternative:** Always branches off a configured base (`config.git.base_branch`, e.g. `development`).
* **Rationale for default:** Matches user expectation ("executor works from where I am"). Users on Nubos-Platform are on `development` per memory; this is already handled.

#### D-8.6 — Commit Flow

* **[DEFAULT]** Executor `cd`s into the worktree; `commit-task` runs inside the worktree and commits to `np/<mid>-<sid>`. Each task is its own atomic commit (ADR-0004 preserved).
* **Alternative:** Executor stays in main workspace, operates on worktree via `git -C <worktree-path> …`.
* **Rationale for default:** `cd`-based is what every other `np:*` workflow already assumes. `git -C` would require every child command to know about the worktree path.

#### D-8.7 — Merge-Back Strategy

* **[DEFAULT]** Fast-forward merge only. After all tasks of a slice pass verify + commit, the workflow runs `git merge --ff-only np/<mid>-<sid>` from the main workspace. If FF is impossible (main branch advanced during execution), workflow stops and surfaces the conflict to the user for manual resolve.
* **Alternative A:** Rebase the slice branch onto current main, then FF.
* **Alternative B:** Three-way merge with auto-commit.
* **Rationale for default:** Preserves linear history (so `git log --oneline --grep='^task('` stays a plan-trace per ADR-0004). Surfacing conflicts to the user is the honest failure mode; auto-rebase can silently rewrite task commits, breaking `np:undo-task` SHA resolution.

#### D-8.8 — Parallelism

* **[DEFAULT]** Sequential execution only in this ADR. The worktree mechanism *enables* parallelism but does not introduce it. Parallel execution would require a disjoint-file-set check between slices and is **out of scope for ADR-0008** — a separate ADR-0009 would address it.
* **Rationale:** Isolation ≠ speedup. Ship the isolation property first; measure real-world merge-conflict rates before adding concurrency.

#### D-8.9 — Cleanup Policy

* **[DEFAULT]** After successful merge-back and commit, worktree is removed via `git worktree remove` and branch `np/<mid>-<sid>` is deleted. A failed slice leaves the worktree in place for inspection; cleanup is manual via `np:reset-slice`.
* **Alternative:** Retention period (e.g. keep successful worktrees for 24h).
* **Rationale for default:** Disk usage and clutter dominate once many slices ship. Retention complicates reasoning; inspection of successful slices is served by `git log` on main.

#### D-8.10 — Crash Recovery

* **[DEFAULT]** `resume-work` detects `.nubos-pilot/worktrees/<mid>/<sid>/` and re-enters it. If the worktree is unsalvageable (corrupt git state), `np:reset-slice` now also runs `git worktree remove --force` on the slice's worktree.
* **Rationale:** Maps the existing crash-recovery story onto the new artifact.

#### D-8.11 — Gitignore / Commit Policy

* **[DEFAULT]** `.nubos-pilot/worktrees/` is **always gitignored**, regardless of `workflow.commit_artifacts`. Committing worktree contents would duplicate the repo inside itself.
* **Rationale:** Hard safety rule. Install step adds `.nubos-pilot/worktrees/` to `.gitignore` when worktree isolation is first enabled.

### Consequences

**Good, because:**

* A failed slice leaves the main workspace clean; recovery is deletion, not fix-up.
* Post-mortem of any slice (passed or failed) is a `cd .nubos-pilot/worktrees/<mid>/<sid>/` away.
* Linear task-commit history survives (FF-merge); ADR-0004 undo semantics unchanged.
* Opt-in model: legacy projects untouched until a user flips the config flag.
* Worktree mechanism paves the path to parallel slices (ADR-0009, future) without re-architecting.

**Bad, because:**

* Disk usage grows per active slice (full working-tree copy — git worktrees share `.git` but not working-tree contents).
* Users must learn one new directory (`.nubos-pilot/worktrees/`) and one new CLI surface (`worktree list|prune|inspect` if we add it).
* FF-merge constraint is strict: if the user force-updates the main branch mid-slice, the slice must be rebased or discarded. This is an intentional sharp edge.
* Merge-back semantics may surprise users on Nubos-Platform's `development` → `main` reconcile flow (memory: "MRs development→main werden gesquasht"). The ADR does not change squash-merge — that happens at MR time, not slice time. Needs explicit test.

## More Information

* **ADR-0004 preservation test:** after implementing, `git log --oneline --grep='^task(' origin/main` must still return one line per committed task — no squash, no merge-commit noise.
* **ADR-0005 preservation:** the worktree physically contains code under `.nubos-pilot/worktrees/`, but that code is a git-working-tree view of the Source tree, not a copy, not state. `.nubos-pilot/` (state) still lives once, in the main workspace.
* **Out of scope:** parallel slices (ADR-0009), cross-milestone worktree pooling, worktree-based dev-mode (`np:dev --worktree` shell), TUI dashboard for worktree status (part of #4 in the octogent roadmap).
* **Implementation phasing (post-approval):**
  1. `lib/worktree.cjs` — create/list/remove/prune/ff-merge.
  2. `lib/worktree.test.cjs` — unit + integration (spawned git in sandbox).
  3. `bin/np-tools/worktree-*.cjs` — CLI surfaces (`worktree-create`, `worktree-remove`, `worktree-list`, `worktree-ff-merge`).
  4. `workflows/execute-phase.md` — conditional worktree-create at slice-start, ff-merge at slice-end.
  5. `bin/np-tools/reset-slice.cjs` — worktree teardown path.
  6. `bin/np-tools/resume-work.cjs` — worktree re-entry.
  7. `bin/install/` — add `.nubos-pilot/worktrees/` to `.gitignore` when `worktree_isolation=true` is first set.
  8. `lib/config-defaults.cjs` — `workflow.worktree_isolation: false`.
