# nubos-pilot

AI-driven planning and execution tool for code projects. Installs into 14 host CLIs (Claude Code, Codex, Gemini, OpenCode, Cursor and ten more) as a set of Markdown workflows + subagents.

- **No daemon.** Every command runs as a short-lived `node` invocation.
- **Markdown-first.** Workflows and agents are plain `.md` files — the host reads them directly.
- **Atomic per-task commits.** One `task(M<NNN>-S<NNN>-T<NNNN>): …` commit per unit of work. `/np:undo-task` and `/np:undo` are mechanical reverts.
- **Multi-runtime.** One source tree, one install payload, fourteen supported host CLIs.

## Install

```bash
cd your-project/
npx nubos-pilot                                 # interactive: pick runtime(s) + scope + model profile
npx nubos-pilot --agent claude                  # non-interactive single runtime
npx nubos-pilot --agents claude,codex,cursor    # multi-runtime install
```

Supported `--agent` values: `claude`, `antigravity`, `augment`, `cline`, `codebuddy`, `codex`, `copilot`, `cursor`, `gemini`, `kilo`, `opencode`, `qwen`, `trae`, `windsurf`. Other top-level subcommands: `update`, `uninstall`, `doctor`, `install-hooks`, `uninstall-hooks`.

`--dry-run` is a flag, not a subcommand — it previews without writing and works in any position (`npx nubos-pilot --dry-run`, `npx nubos-pilot update --dry-run`). When a re-install finds a payload file you edited, the conflict copy is written to `.nubos-pilot/backups/<timestamp>/` — outside the payload directory, so it survives the swap.

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

Fourteen spawnable subagents are installed into the host's agent directory (alongside three `np-critic-*` audit modules consumed by `np-critic`):

- `np-planner` (opus) — breaks a milestone into slices + tasks
- `np-plan-checker` (opus) — adversarial goal-backward review before execution
- `np-architect` (sonnet) — optional ADR-style decisions before planning
- `np-researcher` (sonnet) — milestone-level stack + pitfalls research
- `np-researcher-reconciler` (sonnet) — reconciles disagreements across researcher-swarm outputs
- `np-sc-extractor` (haiku) — derives observable Success Criteria from goal + CONTEXT
- `np-codebase-documenter` (sonnet) — maintains `.nubos-pilot/codebase/` module docs
- `np-executor` (sonnet) — one task per spawn, one commit per task
- `np-build-fixer` (sonnet) — recovery patcher for executor verify failures (manual spawn)
- `np-critic` (sonnet) — Nubosloop critic; audits executor output across style, tests and acceptance
- `np-verifier` (sonnet) — post-execution Pass/Fail/Defer per success_criterion
- `np-nyquist-auditor` (haiku) — requirement test-coverage audit
- `np-learnings-extractor` (haiku) — headless continuous-learning observer; distils reusable `{pattern, outcome}` learnings from a session's turn-diff
- `np-security-reviewer` (sonnet) — OWASP-aligned read-only audit (manual spawn)

Every spawn runs with an **explicit tier** (`haiku` / `sonnet` / `opus`) resolved to a concrete model via `np-tools.cjs resolve-model --profile <frontier|quality|balanced|budget|inherit>`.

## Model profile

Five profiles (`frontier`, `quality`, `balanced`, `budget`, `inherit`) map each tier (`haiku` / `sonnet` / `opus`) to a concrete model. Set at install time (`Model-Profile?` prompt) or in `.nubos-pilot/config.json`.

## Requirements

- Node.js **≥22** (uses the built-in `node:test` runner)
- `git` on PATH for any execute/commit/undo operation

## Commands

Run `npx nubos-pilot help` for the full list, or:

```bash
node np-tools.cjs help           # JSON: { commands: [ { name, category, description } ] }
```

## Scan

A native dependency, secret and misconfiguration scanner ([ADR-0031](https://pilot.nubos.cloud/v1/adr/0031-native-dependency-and-misconfig-scanner)). Deterministic, offline, no model call, no external binary.

```bash
node np-tools.cjs scan                       # every scanner
node np-tools.cjs scan inventory             # dependency inventory (8 ecosystems, 14 manifest formats)
node np-tools.cjs scan advisory --json       # known CVEs + malicious packages
node np-tools.cjs scan secrets               # 95 provider credential shapes + entropy
node np-tools.cjs scan misconfig             # CI workflows, Kubernetes, Compose, container buildfiles, HCL
node np-tools.cjs scan license               # SPDX policy over the tree
node np-tools.cjs scan sbom                  # CycloneDX 1.6
node np-tools.cjs scan db-status             # is the advisory data present, and how old
```

`--fail-on high|critical` turns a run into a CI gate; the default is `never`, so a scan can never break a build by surprise. `--min-severity` sets the reporting floor. Both reject an out-of-vocabulary value rather than silently weakening the gate.

**A check that could not answer says so.** `NPS-0301` (no advisory snapshot), `NPS-0302` (snapshot failed its integrity check — and then no vulnerability verdict is issued at all), `NPS-0303` (no version comparator for that ecosystem). A coverage gap is never reported as a clean result.

The same scanners run non-blocking on every write through the in-session hook layer ([ADR-0020](https://pilot.nubos.cloud/v1/adr/0020-in-session-security-review)). Configure under `security.scan` in `.nubos-pilot/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch for the whole scan layer |
| `advisory` · `malicious` · `secrets` · `misconfig` | `true` | per-scanner toggle |
| `license` | `false` | opt-in; licence policy is a project decision, not a defect |
| `min_severity` | `"high"` | gating floor |
| `ignore_scopes` | `["dev"]` | scopes excluded from gating |
| `fail_on` | `"never"` | `never` \| `high` \| `critical` |
| `db_dir` | `null` | override the advisory snapshot location |
| `max_findings_per_run` | `50` | output cap; `max_severity` still reflects the full result |

### Advisory data

The vulnerability and malicious-package snapshot is built at release time (`npm run advisory:build`) and shipped inside the npm package, then copied once into `~/.nubos-pilot/advisory-db/<version>/` so several projects on one machine share it. It is **not** part of the install payload — [ADR-0002](https://pilot.nubos.cloud/v1/adr/0002-zero-runtime-deps) and [ADR-0005](https://pilot.nubos.cloud/v1/adr/0005-three-orthogonal-file-trees) pin that tree to `.cjs` + Markdown.

Without a snapshot the scanner reports `NPS-0301` and checks nothing for vulnerabilities. `npm run advisory:check` verifies the on-disk digests; `node np-tools.cjs scan db-update` fetches a delta.

## Doctor

```bash
npx nubos-pilot doctor           # 16-check integrity scan (exit 1 on error-severity findings)
npx nubos-pilot doctor --fix     # auto-fix what's safely fixable
```

Checks: payload manifest integrity, version mismatch, hooks presence, codex-toml sanity, askuser runtime availability, codebase docs freshness, milestone/slice directory layout, the three Nubosloop checks (critics present, knowledge store, config), orphan temp files, orphan checkpoints, output schemas, milestone requirement coverage, and the advisory snapshot in `~/.nubos-pilot/advisory-db/<version>/` (absent → `info`, unreadable/incomplete → `warn`, older than 90 days → `info` with `age_days`, a shard that fails its SHA-256 → `error`).

## Development

```bash
npm test                         # all unit tests via node:test
node bin/check-workflows.cjs     # workflow linter
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for setup, code conventions, ADR
map and commit format.

## Architecture Decisions

ADRs live in the VitePress at
[`pilot.nubos.cloud/v1/adr/`](https://pilot.nubos.cloud/v1/adr/). The
load-bearing ones for users and contributors:

| ADR | What it pins |
|---|---|
| 0004 | `workflow.commit_artifacts` controls whether `.nubos-pilot/` is committed |
| 0010 | Nubosloop — researcher → executor → critic-schwarm is mandatory in `/np:execute-phase` |
| 0012 | Completeness doctrine (12 rules in `templates/COMPLETENESS.md`) |
| 0013 | Learnings-store schema evolution |
| 0017 | Strict output-schema enforcement |
| 0019 | Plan-side trust layer (`lib/plan-lint.cjs`) |
| 0031 | Native dependency/secret/misconfig scanner; where the advisory snapshot lives and why not in the payload |

## Security

See [`SECURITY.md`](./SECURITY.md) for the vulnerability disclosure policy
and threat model.

### Headless recursion guard

The in-session security review and continuous-learning hooks do their work in
a headless `claude -p` subprocess. To stop that subprocess from re-firing the
same hooks (which would cascade into an unbounded fork of `claude`/`np-tools`
processes), nubos-pilot sets `NUBOS_PILOT_HEADLESS=1` and a
`NUBOS_PILOT_HOOK_DEPTH` counter on every headless spawn. The hooks no-op when
`NUBOS_PILOT_HEADLESS` is set, `spawn-headless` refuses a nested or
depth-exceeded spawn, and a per-agent lockfile under `.nubos-pilot/run/` bounds
concurrent headless runs to one per agent.

The guard is automatic — do not export `NUBOS_PILOT_HEADLESS` in your own
shell, or the in-session hooks will silently do nothing. The depth cap is one
level; override it with `NUBOS_PILOT_MAX_HOOK_DEPTH` only if you understand the
recursion risk.

## Support

- Bugs / features: [GitHub issues](https://github.com/Nubos-AI/nubos-pilot/issues)
- Security: `security@nubos.ai` (see [`SECURITY.md`](./SECURITY.md))
- Docs: <https://pilot.nubos.cloud>

## License

MIT — see [`LICENSE`](./LICENSE).
