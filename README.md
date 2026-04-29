# nubos-pilot

AI-driven planning and execution tool for code projects. Installs into 14 host CLIs (Claude Code, Codex, Gemini, OpenCode, Cursor and ten more) as a set of Markdown workflows + subagents.

- **No daemon.** Every command runs as a short-lived `node` invocation.
- **Markdown-first.** Workflows and agents are plain `.md` files — the host reads them directly.
- **Atomic per-task commits.** One `task(M<NNN>-S<NNN>-T<NNNN>): …` commit per unit of work. `/np:undo-task` and `/np:undo` are mechanical reverts.
- **Multi-runtime.** One source tree, one install payload, four first-class host CLIs.

## Install

```bash
cd your-project/
npx nubos-pilot                                 # interactive: pick runtime(s) + scope + model profile
npx nubos-pilot --agent claude                  # non-interactive single runtime
npx nubos-pilot --agents claude,codex,cursor    # multi-runtime install
```

Supported `--agent` values: `claude`, `antigravity`, `augment`, `cline`, `codebuddy`, `codex`, `copilot`, `cursor`, `gemini`, `kilo`, `opencode`, `qwen`, `trae`, `windsurf`. Other top-level subcommands: `update`, `uninstall`, `doctor`, `install-hooks`, `uninstall-hooks`, plus `--dry-run`.

This writes a self-contained payload under `.claude/nubos-pilot/` (or the host-specific equivalent), plus a managed block in `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`. Uninstall with `npx nubos-pilot uninstall`.

## Project layout

Every nubos-pilot project lives under `.nubos-pilot/`:

```
.nubos-pilot/
  PROJECT.md                     # product truth (filled by /np:discuss-project)
  REQUIREMENTS.md                # requirement register
  roadmap.yaml                   # schema_version: 2
  STATE.md                       # cursor: current milestone + current task
  milestones/
    M001/
      M001-CONTEXT.md            # locked user decisions from /np:discuss-phase
      M001-ROADMAP.md            # slice list, execution order
      M001-META.json
      slices/
        S001/
          S001-ASSESSMENT.md
          S001-PLAN.md           # planner output: contains <task> blocks inline
          S001-RESEARCH.md       # optional, from /np:research-phase
          S001-SUMMARY.md
          S001-UAT.md            # acceptance criteria
          tasks/
            T0001/
              T0001-PLAN.md      # scaffolded from <task> blocks
              T0001-SUMMARY.md   # executor fills after commit
            T0002/...
  codebase/                      # module docs from /np:scan-codebase
```

**Milestone = "phase" in user-facing commands.** `/np:plan-phase 1` plans milestone M001 entirely — all its slices and tasks.
**Slice = wave.** All tasks inside one slice run in parallel; slices run serially.
**Task = one atomic commit.**

## Happy-path workflow

```bash
/np:new-project                  # scaffold PROJECT.md + M001 shell
/np:discuss-phase 1              # locked decisions → M001-CONTEXT.md
/np:research-phase 1             # optional — stack + pitfalls → M001-RESEARCH.md
/np:plan-phase 1                 # planner + plan-checker → S<NNN>-PLAN.md + task files
/np:execute-phase 1              # slice by slice; tasks parallel within each slice
/np:verify-work 1                # post-execution goal-backward verification
/np:validate-phase 1             # Nyquist coverage audit: COVERED / UNDER_SAMPLED / UNCOVERED
/np:add-tests 1                  # persist VERIFICATION Pass-cases as node:test UAT
```

## Recovery commands

| Command | When to use |
|---|---|
| `/np:reset-slice [<task-full-id>]` | Execute crashed mid-task. Discards working-tree changes for `files_modified`, drops the checkpoint, clears `STATE.current_task`. No commit. |
| `/np:undo-task <M001-S001-T0001>` | One committed task is wrong. `git revert --no-edit <sha>`, task frontmatter → `pending`. |
| `/np:undo <1 \| M001-S001>` | Roll back an entire milestone or one slice. Newest-first revert; every affected task → `pending`. |
| `/np:pause-work` · `/np:resume-work` | Explicit session handoff. |
| `/np:skip` · `/np:park` · `/np:unpark` | Task lifecycle state. |

## Task-ID schema

All task IDs are **`M<NNN>-S<NNN>-T<NNNN>`** (3/3/4 digits):

```
M001-S001-T0001    # milestone 1, slice 1, task 1
M002-S007-T0042    # milestone 2, slice 7, task 42
```

Task commits:

```
task(M001-S001-T0001): add login form
task(M001-S001-T0002): wire login handler
```

## Agents

Eleven subagents are installed into the host's agent directory:

- `np-planner` (opus) — breaks a milestone into slices + tasks
- `np-plan-checker` (opus) — adversarial goal-backward review before execution
- `np-architect` (sonnet) — optional ADR-style decisions before planning
- `np-researcher` (sonnet) — milestone-level stack + pitfalls research
- `np-sc-extractor` (haiku) — derives observable Success Criteria from goal + CONTEXT
- `np-codebase-documenter` (sonnet) — maintains `.nubos-pilot/codebase/` module docs
- `np-executor` (sonnet) — one task per spawn, one commit per task
- `np-build-fixer` (sonnet) — recovery patcher for executor verify failures (manual spawn)
- `np-verifier` (sonnet) — post-execution Pass/Fail/Defer per success_criterion
- `np-nyquist-auditor` (haiku) — requirement test-coverage audit
- `np-security-reviewer` (sonnet) — OWASP-aligned read-only audit (manual spawn)

Every spawn runs with an **explicit tier** (`haiku` / `sonnet` / `opus`) resolved to a concrete model via `np-tools.cjs resolve-model --profile <frontier|quality|balanced|budget|inherit>`.

## Model profile

Five profiles (`frontier`, `quality`, `balanced`, `budget`, `inherit`) map each tier (`haiku` / `sonnet` / `opus`) to a concrete model. Set at install time (`Model-Profile?` prompt) or in `.nubos-pilot/config.json`. Full matrix in `docs/agent-frontmatter-schema.md`.

## Requirements

- Node.js **≥22** (uses the built-in `node:test` runner)
- `git` on PATH for any execute/commit/undo operation

## Commands

Run `npx nubos-pilot help` for the full list, or:

```bash
node np-tools.cjs help           # JSON: { commands: [ { name, category, description } ] }
```

## Doctor

```bash
npx nubos-pilot doctor           # 6-check integrity scan
npx nubos-pilot doctor --fix     # auto-fix what's safely fixable
```

Checks: payload manifest integrity, version mismatch, hooks presence, codex-toml sanity, askuser runtime availability, codebase docs freshness, milestone/slice directory layout.

## Development

```bash
npm test                         # all unit tests via node:test
node bin/check-workflows.cjs     # workflow linter
```

## License

MIT
