# The Depth Tree in nubos-pilot

Unlazy's Depth Tree exposes natural work boundaries and the integration points between them. nubos-pilot already has that tree; this reference maps the discipline onto it.

| Unlazy | nubos-pilot |
|---|---|
| root | milestone `M<NNN>` — `M<NNN>-CONTEXT.md`, `M<NNN>-ROADMAP.md`, SC list |
| branch (integration node) | slice `S<NNN>` — `S<NNN>-PLAN.md` `<verification>` / `<success_criteria>`, `S<NNN>-UAT.md` |
| leaf | task `T<NNNN>` — `T<NNNN>-PLAN.md` `<verify>` / `<acceptance_criteria>` / `<done>` |
| contract inventory | milestone SC list + `requirements` + locked `D-XX` decisions |
| `OWNS:` | task `files_modified` |
| `Needs` | task `depends_on`, roadmap slice edges |
| leaf state | task checkpoint status (`in-progress → verifying → pre-commit`, or `stuck`); settled by `commit-task` |
| parent `--reverify` | orchestrator mechanical checks in the Nubosloop; `/np:verify-work` at milestone level |
| abandonment | `Deferred` marker, `stuck`, `needs_user_confirm`, `askuser` escalation |

## Rules

1. **Layer 1 is the requested outcome.** Split only at real domain, component or verification boundaries. Do not add slices or tasks to fill a number.
2. **Each task is one coherent deliverable.** It has exact `files_modified`, explicit `depends_on`, and its own runnable gate. Merge tiny adjacent tasks; split a task that hides several independent outcomes.
3. **Fix contracts before fan-out.** Before any executor starts: every SC has an owner and an observing gate, interfaces and shared formats are written down, error and naming conventions are fixed, and ownership is disjoint within a wave. Unknowns are resolved by a Wave-0 reconnaissance task, not by the executor guessing.
4. **Slices integrate.** A slice is done only after every task returned, was re-verified by the orchestrator, and the slice-level checks for interfaces, end-to-end behaviour and regressions passed. A set of locally green tasks is not a done slice.
5. **Gates and passes are the effort control.** Depth does not buy thoroughness; current evidence for every gate plus a clean improvement pass does.

## Completion hierarchy

| Level | Proof |
|---|---|
| Task | `<verify>` green after the last edit, every acceptance criterion evidenced, critic swarm reports zero blocking findings, `commit-task` succeeded |
| Slice | every task re-verified, slice `<verification>` green, UAT evidenced, no task `stuck` |
| Milestone | request and amendments reread, every SC reconciled to a `Pass` with current evidence, regressions checked, final report counts re-measured |

Local completion does not imply integration. Verify bottom-up and report only when the milestone level holds. A missing owner, a stale observation, a handoff or an open user decision is visible non-completion.

## Dispatch waves

When a wave has two or more dispatchable tasks (`dispatchable_task_ids`):

1. Confirm `files_modified` is pairwise disjoint across the wave. If it is not, the split is unsafe — sequence the tasks or use worktree isolation; never dispatch overlapping owners together.
2. Launch **every** task of the wave before waiting on, joining or reading any result. On Claude Code launch each executor as a background `Agent`; on Codex spawn every subagent before the first wait. Serial launch-then-wait-then-launch is not a parallel wave.
3. When a task returns, re-verify it (mechanical checks by the orchestrator, then the critic swarm) before counting it.
4. Roll forward: when a re-verified task unblocks another, dispatch the newly ready task without waiting for unrelated in-flight work.
5. If a launch fails and cannot be recovered, record the failure as a handoff. Never invent a result or treat a missing agent as returned.

A launched wave proves only that every start happened before the first result was read. It does not prove worker honesty, filesystem isolation or integration; re-verification and slice gates remain required.

## Verification layers

1. **Agent self-check** — the executor runs its own `<verify>`. Catches ordinary incompleteness; still self-certification.
2. **Orchestrator re-verification** — mechanical checks run by the orchestrator, not the agent, plus the Rule-9 and skill audits.
3. **Critic swarm** — independent review of the diff along every critic axis the loop configures.
4. **Slice / milestone integration** — `<verification>`, UAT and `/np:verify-work` against the joined result.

Only layers 2–4 are independent of the agent that did the work. Never skip them because layer 1 was green.

## When the tree is too much

A focused change that one executor can implement and verify still runs through the milestone → slice → task path when it enters `/np:execute-phase`, but it should be one slice with one task, not an artificial hierarchy. Orchestration is for attention isolation, not ceremony.
