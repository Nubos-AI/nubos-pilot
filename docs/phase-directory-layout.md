# Phase Directory Layout

**Status:** Canonical — Phase-4 D-24 / D-25
**Last updated:** 2026-04-15

This document is the authoritative spec for what a `.planning/phases/<NN>-<slug>/`
directory may contain, which files are parser-mandatory, which are produced by
which workflow, and which are consumed by which agent.

## Mandatory files

These are the only files that `lib/phase.cjs` / `lib/plan.cjs` / `lib/tasks.cjs`
read by contract. A phase directory is well-formed when each of its plans has a
`PLAN.md` and (optionally) a `tasks/` subdirectory with one `.md` file per task.

| File                   | Producer workflow           | Parser                  | Minimal required sections                                                             |
| ---------------------- | --------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `<NN>-<MM>-PLAN.md`    | `np:plan-phase`             | `lib/plan.cjs`          | Frontmatter: `phase, plan, type, wave, depends_on, files_modified, autonomous, must_haves`; body: `<objective>`, `<tasks>` (may be empty if plan is single-task), `<success_criteria>` |
| `tasks/<task-id>.md`   | `np:plan-phase`             | `lib/tasks.cjs`         | Frontmatter: full 12-field set per D-01 (`id, phase, plan, type, status, tier, owner, wave, depends_on, files_modified, autonomous, must_haves`); body: freeform task prose |

Notes:
- `tasks/` is **optional at the plan level**: a plan promotes to `tasks/*.md`
  only when parallelism, mixed tiers, or non-linear dependencies demand it.
  A single-task plan may keep its tasks inline inside `PLAN.md`.
- Every other file in the phase directory is **workflow-produced / workflow-consumed only**.
  Parsers never read them.

## Optional files (workflow artifacts)

The parser contract does not read these. Each is produced by a specific
workflow and consumed by a specific downstream agent or workflow step. Missing
files are never an error — they simply indicate that the corresponding workflow
step did not run (or has not run yet).

| File                              | Producer workflow            | Consumer agent(s) / workflow                        | Minimal required sections                                                                                                    |
| --------------------------------- | ---------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `<NN>-CONTEXT.md`                 | `np:discuss-phase`           | planner, researcher, plan-checker                   | `<domain>`, `<decisions>`, `<constraints>`, `<dependencies>`, `<success_criteria>`                                           |
| `<NN>-RESEARCH.md`                | `np:research-phase`          | planner, plan-checker                               | `<sources>` (at least one link with HIGH/MEDIUM/LOW credibility), `<findings>`, `<open_questions>`, `<flags>`                |
| `<NN>-PATTERNS.md`                | `np:plan-phase` (pre-plan)   | planner, executor                                   | `File Classification` table, per-file `Analog` block, `Shared Patterns` (S-1..S-N) section                                   |
| `<NN>-VALIDATION.md`              | `np:plan-phase` (pre-plan)   | planner, executor, verifier                         | `Validation Strategy`, `Must-Have Truths`, `Artifact Checks`, `Traceability Matrix`                                          |
| `<NN>-<MM>-SUMMARY.md`            | `np:execute-plan`            | verifier, `np:progress`, `np:next`                  | Frontmatter: `phase, plan, subsystem, key-files, decisions, metrics`; body: `Objective`, `What Was Built`, `Key Decisions`, `Deviations`, `Self-Check` |
| `<NN>-VERIFICATION.md`            | `np:verify-work`             | `np:next` (rule 4 gate), human reviewer             | `Scope`, `Evidence`, `Result` (pass/fail), `Follow-ups`. Presence flips `np:next` from rule-4 to rule-5 for the phase.       |
| `<NN>-DISCUSSION-LOG.md`          | `np:discuss-phase`           | planner (carry-over), human reviewer                | Freeform Q&A transcript — no parser contract                                                                                 |
| `<NN>-UI-SPEC.md`                 | `np:ui-phase`                | UI executor, reviewer                               | `Screens`, `Components`, `Interactions`, `Accessibility`, `Design-system references`                                         |
| `<NN>-AI-SPEC.md`                 | `np:ai-integration-phase`    | AI executor, eval-reviewer                          | `Framework selector`, `Model profile`, `Prompt contracts`, `Eval strategy`, `Metrics`                                        |
| `<NN>-REVIEW.md` / `REVIEW-FIX.md`| `np:review` / `np:code-review` | executor (follow-up), verifier                    | `Findings` table, `Severity`, `Remediation plan`                                                                             |
| `<NN>-verify.sh`                  | `np:plan-phase` (optional)   | executor, verifier, CI                              | POSIX-sh script; exit 0 = pass, non-zero = fail. Each assertion uses `[ -f ... ]` / `grep -q ...` / `node --test ...` style  |

## Parser contract

`lib/phase.cjs` (`findPhaseDir`, `paddedPhase`, `slug`) navigates the directory
tree by filename convention only. `lib/plan.cjs` (`parsePlan`, `listPlans`)
reads `PLAN.md` files. `lib/tasks.cjs` (`loadTaskGraph`,
`validateTaskFrontmatter`) reads `tasks/*.md` if the subdirectory exists.

None of these parsers read any of the optional files listed above. Workflows
that consume optional files do so by explicit path (e.g.
`fs.readFileSync(path.join(phaseDir, '04-CONTEXT.md'), 'utf-8')`) with
ENOENT-tolerance — a missing file is a non-error state meaning "that step
hasn't been run".

## Producer-workflow vs. consumer-agent separation

Workflow commands (`np:*`) produce files; subagents (planner, researcher,
executor, verifier, plan-checker) consume them. A well-formed phase directory
reflects exactly which workflow steps have been completed, which is what
`np:next` uses to compute the next actionable step (Phase-4 D-12..D-15 gate
rules).

## Relation to D-24 / D-25

- **D-24:** Only `PLAN.md` and `tasks/` are parser-mandatory. Every other file
  is workflow-produced and may be absent.
- **D-25:** This file is the authoritative spec for the optional-file list.
  When a new workflow is added (e.g. Phase 5's `np:research-phase`), it must
  either produce one of the files listed above or extend this table.

## References

- Phase-4 `04-CONTEXT.md` §decisions D-24, D-25
- Phase-3 `03-CONTEXT.md` §D-12..D-17 (task-frontmatter baseline)
- `lib/plan.cjs`, `lib/tasks.cjs`, `lib/phase.cjs` — the only parsers that read this tree
