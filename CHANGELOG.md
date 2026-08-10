# Changelog

All notable changes to nubos-pilot are documented in this file. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The research swarm's output now actually reaches the planner.** `/np:plan-phase`
  spawned `np-planner` with no `<files_to_read>` block at all — unlike the
  `architect-phase`, `execute-phase`, `research-phase` and `verify-work` spawn sites
  around it — and the `init plan-milestone init` payload never
  exposed `M<NNN>-RESEARCH.md`. Three researchers, a reconciler and two hard gates
  produced a document the planner never opened and the plan-checker never audited.
  Both agent docs also pointed at a slice-level `S<NNN>-RESEARCH.md` that nothing
  writes. The evidence block (CONTEXT + RESEARCH + ARCHITECTURE + RULES + codebase
  INDEX) is now assembled once and passed to both spawns, native and off-host, and
  `tests/plan-phase-inputs.test.cjs` keeps it from rotting again (ADR-0032).
- **`plan-lint` findings below `critical` are no longer discarded.** The ADR-0019
  Trust-Layer merge only wrote lint findings into the verdict when `critical > 0`,
  so every `major`/`minor` finding — e.g. `plan-over-specifies-implementation` —
  was dropped and never reached the planner in iteration 2. Findings are merged
  unconditionally now; only a `critical` one still forces `issues_found`.

### Added

- **Plan consistency gate (ADR-0032).** A plan can no longer demand two things that
  cannot both be true. Prompted by a shipped slice that required "fully mirror the
  segment-share pattern" *and* "a duplicate share fails", while the mirrored action
  used `firstOrCreate` and was idempotent by construction.
  - `<reality_check><pattern_refs>`: every instruction to mirror an existing
    implementation carries `symbol=`, `at="path:line"` and an **observed**
    `behavior=`, plus a `<deviation>` when a criterion needs behaviour the
    reference lacks.
  - `plan-lint` gains `pattern-claim-unverified` (critical, non-overridable): a
    mirror-phrase naming a concrete file or symbol with no matching `<pattern_ref>`,
    or an incomplete `<pattern_ref>`/`<deviation>`. Trigger requires both a phrase
    (EN + DE) and a code token, so ordinary prose does not fire; scaffolded task
    plans are exempt because the block lives in the slice plan.
  - `np-plan-checker` gains Dimension 13 and `contradictory-requirements`
    (critical): pairwise consistency of the acceptance-criteria set, verification
    of each `<pattern_ref>` against the real code, criteria vs. mirrored behaviour,
    and plan vs. `[VERIFIED]` research / ARCHITECTURE decisions / locked `D-XX`.
  - `np-planner` gains a `## PLAN CONTRADICTION` return. A contradiction with one
    derived side is resolved by the planner and recorded as a `<deviation>`; a
    collision between two **locked** decisions stops at an askuser gate, because
    choosing between them is the user's call.
- `lib/layout.cjs`: `milestoneResearchPath()` / `milestoneArchitecturePath()`,
  replacing the inline path joins in `research-phase.cjs` and
  `researcher-reconciler.cjs`.

## [1.5.0] — 2026-08-03

Nine gaps that were structural rather than broken.

- Agent rule compliance is tested instead of assumed. Fixtures stack
  three pressures and force a choice; a pass needs the right answer and
  the rule cited (ADR-0024).
- `pause-work` and `resume-work` hand over what a session disproved, not
  only what it concluded. Failed approaches become demoted learnings
  (ADR-0025).
- The planning hierarchy exports as an OpenTelemetry span tree. Span ids
  derive from unit ids, so a re-export updates one trace instead of
  adding another (ADR-0026).
- `roadmap.yaml` renders as a Mermaid or Graphviz dependency graph
  (ADR-0027).
- A slice can be gated on how an earlier slice turned out.
  `schema_version: 3` is written only when a conditional edge exists
  (ADR-0028).
- Execution isolation tiers have names, and the weakest can no longer
  pass for protection. A configured tier is never silently downgraded
  (ADR-0029).
- Agent Client Protocol groundwork: vocabulary, framing, handshake. No
  transport, every client capability off (ADR-0030).
- Native dependency, secret and misconfiguration scanning via
  `np-tools scan`, and the same checks on every write. Offline, no model
  call. The CVE and typosquat bars in `np-dependency-audit` are run now
  instead of claimed (ADR-0031).
- `/np:new-milestone` asks which requirement IDs a milestone covers.
  Nothing ever wrote `milestone.requirements[]`, so
  `/np:validate-phase` audited zero requirements. `doctor` reports the
  gap without failing.

Hardening found while reviewing the above: `lib/` no longer imports
`child_process`, mount paths are validated by real path rather than
string prefix, conditional-edge decisions are threaded through both
planner halves, and the ACP decoder handles a split multi-byte character.

Full documentation at <https://pilot.nubos.cloud>.

## [1.4.0] — 2026-07-20

Four capabilities that were missing rather than broken: status that derives itself, a learning layer that finally recalls, stack detection instead of hardcoded linters, and a close path that tells the truth about what it archived.

- Slice and milestone status now derive themselves from the tasks on disk. A new rollup reads the `status` frontmatter of every task in each `PLAN.md` and writes the result back into `roadmap.yaml` on every task transition — `commit-task`, `skip`, `park`, `unpark`, `undo`. Status was previously hand-maintained and routinely stale, which matters because `close-project`'s blocker gate reads it. The deliberate limit: the rollup never writes a *terminal* milestone status (`verified`/`failed`/`deferred`) — that stays with `verify-work`, because terminal means verification actually ran, so a milestone whose slices are all done stays `in-progress` on purpose. A rollup failure is logged and never fatal; the task transition still stands. Inspect without writing via `rollup inspect <N>`.
- `np:doctor` and `verify-work` now detect status drift across the three writers. Status lives in `roadmap.yaml`, `M<NNN>-META.json` and the SC verdicts in `VERIFICATION.md`, nothing reconciled them, and the dashboard reads META. Six new findings cover the cases, including a direction-aware hint that tells you when roadmap is the *fresher* side and `verify-work sync-roadmap` would wrongly promote it back up. `verify-work` also warns when it sets a terminal status with slices still open, and when only part of the SCs were classified.
- Learning retrieval was recalibrated against a real store, because the old thresholds meant the layer served nothing. Every learning now carries a `confidence` in `[0,1]` — computed on read, never stored, so there is no migration and `learnings.v1` is untouched — multiplying occurrence, outcome (with 30 % weight from `outcome_history`, so a flip-flopping learning scores below a steady one) and recency. Ranking became `similarity × confidence`. The measured basis: 994 of 1000 learnings had been seen exactly once, so repetition was the wrong trust signal, and correct and incorrect matches overlap heavily in absolute Jaccard while the correct one still ranks #1 in 82 % of queries. Hence `swarm.research.threshold` drops 0.9 → 0.2 and `minOccurrence` 3 → 1.
- Retrieval threshold and bypass threshold are now separate, which is what makes that loosening safe. Previously *any* cache hit set `bypass_swarm: true`. A hit below the new `swarm.research.bypassThreshold` is surfaced to the agent as advisory context with `cache_miss_reason: cache-hit-below-bypass-threshold`, and the Researcher-Schwarm still runs — so a repeatedly-failing pattern can no longer skip research.
- Learnings are injected back into context, not just captured. A confidence-ranked prior renders into a delimited block at `SessionStart`, again at `PreCompact` — which is exactly where the prior otherwise falls out of context — and into every prompt from `spawn-headless`. The block is fenced with `HISTORICAL REFERENCE ONLY — NOT LIVE INSTRUCTIONS`, since a stored learning is untrusted text that must not read as a command, and it states that current task instructions win wherever they conflict. A hard character budget prints `[N further learning(s) omitted…]` rather than silently truncating.
- New `gate-candidates` clusters `failed` and `reverted` learnings into recurring failure classes and ranks them by total failures. The point is in the closing line: each cluster is a class the model got wrong more than once, and that belongs in a lint or compiler rule that cannot go green — not restated in a prompt.
- Stack detection replaced hardcoded linters. `detect-stack` is a single source of truth for 11 stacks and 12 task runners (manifests, lockfiles, linters, typecheckers, test runners), and `plan-lint` and `workspace-scan` now read from it instead of their own hand-maintained copies. The reason it matters: the execution loop's mechanical-check step hardcoded `phpstan, pint, tsc, eslint`, so a tool meant for arbitrary foreign projects was quietly PHP+TypeScript-shaped. `execute-phase` now asks `detect-stack --lint-commands`.
- `close-project close [--archive]` runs summary → status → archive in the only order that works, since the archiver moves `PROJECT-SUMMARY.md` and it must exist first. Both `close` and `mark-completed` now enforce the blocker gate and refuse with `close-project-blocked` unless `--force`, **writing nothing on refusal**. Unknown flags and flags missing their value are rejected on both `close-project` and `archive-project` rather than silently ignored — a typo could previously skip the archive entirely. If close succeeds but archive fails, the payload reports `closed: true, archived: false` and exits non-zero; the close stands and must not be re-run.
- Archiving reports honestly and refuses on artefacts it does not recognise. `project_status: completed` used to upgrade the reported status to `complete`, so one force-complete permanently masked every later blocker check; `complete` is blocker-based again, and a separate `archivable` field carries what the recorded status actually conveys. The manifest records `forced` and `archived_with_blockers` as two distinct facts, because a force past the worktree guard on an otherwise-clean project reads as innocuous under either alone. Classification is now deny-by-default: any top-level `.nubos-pilot/` entry that is neither archived nor preserved refuses with `archive-unknown-state-artifact` (waivable with `--allow-unknown`). An allowlist alone silently left new artefacts behind, which is how project data leaked into successor projects — a new parity test asserts every state-dir path the source creates is classified, so an unclassified one fails the suite instead of leaking at archive time.
- Codex is a supported runtime rather than an advertised one (#3). `--agent codex` installed the payload and the managed `AGENTS.md` but no workflows and no agent roles, because the registry gave Codex neither a `commandsSubdir` nor an `agentsSubdir` — so the documented loop existed only for Claude Code and OpenCode while the quickstart offered Codex as an equal target. Codex has two extension surfaces and they mean different things, so both are now used. The 36 workflows install as **skills** under `.codex/skills/`: Codex loads custom prompts only from `$CODEX_HOME/prompts`, which is user-global, unshareable through the repository and deprecated by OpenAI, whereas skills are project-scoped — the scope the rest of the installer already uses. The one difference from Claude Code is stated in every generated `SKILL.md` rather than smoothed over: invocation is `$np-plan-phase 1`, not `/np:plan-phase 1`, since a leading `/` on a skill name is not a thing in Codex (`/skills` lists them).
- The 21 loop roles install as **subagents** in `.codex/agents/np-*.toml`, which is what gives the loop its isolation on Codex — a spawned subagent runs in its own thread, so `np-critic` does not share context with the `np-executor` output it reviews. Each file carries the three fields Codex requires (`name`, `description`, `developer_instructions`); concurrency stays with the parent's `agents.max_threads` (default 6). `model` and `sandbox_mode` are deliberately absent: nubos-pilot addresses models by tier while Codex resolves them by profile, so emitting one would pin a model the user never chose — the subagent inherits the parent session and the tier survives as reference text. The instructions are emitted as a TOML *literal* block, because basic strings process escapes and agent prose is full of regexes like `\d`, which would be a parse error in the user's session rather than a cosmetic defect; a body that could not be delimited safely is refused with `codex-agent-undelimitable-body` instead of being mangled. Rendering is deterministic from the same sources every other runtime uses, and the manifest hashes the *rendered* output, so a renderer change invalidates the installed files instead of leaving them silently stale.
- `np:doctor` validates the command surface per runtime, which is the check whose absence let the above ship. A new 14th check spot-checks the loop's spine (`new-project`, `plan-phase`, `execute-phase`, `verify-work`) at whatever path the runtime actually uses and reports `workflow-commands-dir-missing` / `workflow-command-missing` with that runtime's own invocation syntax in the hint. The Critic-Schwarm check learned the same lesson twice: it resolved agents as `<dir>/<name>.md`, which was silence for Codex when Codex had no agents directory and would have been 21 false positives once it got one, since Codex reads `.toml` — it now asks the layout where a role lives. Two sources colliding on one skill name are refused with `runtime-asset-name-collision` rather than one silently overwriting the other, and `workflows/state.md` — the one workflow that had no frontmatter at all, and so no description in any runtime's command menu — got one.
- `commit-task` refuses a message containing `Closes #N`, `Fixes #N`, `Resolves #N` or `Implements #N`. The forge auto-closes the issue on push and board automation moves it to Done before a human has tested anything. Use `Refs #N` and let a person close it after verification.
- Smaller fixes: `new-project`'s force-archive branch was unconditional because `STATUS` was read but never bound, so every archive ran `--force` and silently bypassed the active-worktree guard. `stats` was walking a schema-v1 roadmap shape that no longer exists. `propose-milestones` recognised `completed`, which is not a real status, and missed `verified`, which is the one milestones actually reach. `roadmap-render` fell through to raw values for `verified`/`failed`/`deferred`/`backlog`. `plan-lint`'s shell lexer handles `$"…"` locale strings, `>>>`/`<<<` triple redirects and `for`/`select` word lists.

Upgrading: five behaviours change without you touching config. Retrieval gets far more permissive if you never set `swarm.research.threshold` or `minOccurrence` (the new `bypassThreshold` is what keeps that safe); `mark-completed` starts failing on blockers unless scripted with `--force`; archiving refuses on custom top-level state artefacts until they are classified or waived; `commit-task` rejects issue-closing keywords; and `roadmap.yaml` slice status is machine-derived on every task transition, so hand-edits are overwritten. Nothing was removed or renamed, and every new config key is optional.

Full documentation at <https://pilot.nubos.cloud>.

## [1.3.6] — 2026-07-17

A correctness release. The execution loop's verify step was never running the task's check, and fixing that turned up a cluster of related bugs where the loop looked like it was working while quietly skipping a guard.

- The big one: the task's `<verify>` command was never actually defined. `$VERIFY_CMD` did not exist anywhere, and `VERIFY_EXIT=$?` captured the exit code of the log-file assignment, which was always 0. So verify always read green, the build-fixer path was dead code, and `loop-commit` committed on a check it never ran. There is now a single source of truth for reading the block (`lib/verify-block.cjs`) and a `task-verify-cmd` verb that extracts the real command from the plan's `<automated>` container, decodes XML entities, and refuses `<manual>` bodies so a human procedure can never reach bash. A task with an empty verify block fails closed instead of running `bash -c ""` and passing.
- `<verify>` now enforces a deny-by-default allow-list, and projects get a seam into it: `plan_lint.verify_allow_commands`. A repo built on `just`, `bazel`, or `mise` used to get a critical `verify-command-not-allowed` on every plan with no way to answer it, because nubos-pilot cannot know every project's runner. The new key registers those runners. It only widens the list — entries that would re-open the deny-list (`bash`, `curl`, an interpreter) are hard errors, not warn-and-coerce, since the key guards an execution surface.
- Critics fail closed on a report they cannot read. A critic that phrased its blocker as a plain string (`findings: ["BLOCKER: ..."]`) instead of an object used to shrink to zero findings, and zero findings routes straight to commit. Silence about a report we cannot parse is indistinguishable from "the code is clean," so the loop now refuses instead of guessing. The same rule covers an acceptance criterion that fails to parse — an unreadable criterion is not a satisfied one.
- `update --dry-run` is a real flag now. It used to land in the positional arguments where nothing read it, so `--dry-run` silently performed a full install. The preview is strictly read-only: no state dir, no lock file, no staging, no cleanup of stale staging — it hashes the source tree and reports what would change.
- The installer refuses to touch your managed files when it cannot read which runtimes you use. An empty or mistyped `runtimes` list used to degrade to `['claude']`, which is how a codex+gemini user's `AGENTS.md` and `GEMINI.md` got stripped on an update. A resolved runtime list is now required up front, before anything is staged, so a refusal leaves no debris. Backups also moved out of the payload directory, which the swap step renames aside and deletes — a sibling `.bak` in there went with it.
- Parallel tasks in a slice no longer race on `.git/index.lock`. Each task ends with its own `commit-task` process running `git add` + `git commit` against the same index, nothing serialised them, and a collision aborted the whole wave. Commits are now behind a file lock. Related: `git` calls and `reset-slice` honour a `--cwd`, so with `workflow.worktree_isolation` on they act on the slice worktree instead of `process.cwd()` — `reset-slice` was running `git restore` against the main repo and shredding uncommitted work.
- `np:doctor` checks the agents directory per installed runtime instead of assuming Claude's path. A healthy codex/gemini/opencode-only install kept getting `nubosloop-agents-dir-missing` for a directory its runtimes never use, with an `update` hint that could not create it. The orphan-tmp check is also wired to `--fix` instead of reporting `skipped: no-auto-handler`.
- `askuser` normalises its one-line stdout answer: a typed line and a chosen label pass through verbatim, `confirm` locks to `true`/`false` regardless of prompt language, and multiselect returns a JSON array. A value that is none of these (a raw option object) now fails loud rather than shipping `[object Object]` into a shell `case` arm. Note the confirm contract has two sides — under Claude Code the workflows route confirm to the native question tool, which answers with the button label; the canonical `[[ "$X" == "true" || "$X" == "Yes" ]]` idiom lives in `workflows/new-project.md`.
- Two config keys the code already honoured are now declared, so following them no longer trips an `unknown-key` warning. `memory` surfaces the opt-in vector-memory layer (`enabled`, `model` against the audited embedding whitelist, `alpha` for the hybrid merge; ADR-0014), and `runtime_source` is a key the installer wrote itself and then flagged. `memory-add` wired into a workflow absorbs only `memory-disabled` — a config that opts in but cannot resolve still throws.

Full documentation at <https://pilot.nubos.cloud>.

## [1.3.3] — 2026-06-25

An economy axis that pushes back on over-engineering, plus a stale-checkpoint fix.

- New economy axis, set by `agents.economy` with four levels (`off`, `lite`, `full`, `ultra`). It drives two mechanisms: a prevention ladder the executor climbs before it writes (reuse what already exists, reach for the stdlib or a native framework feature, prefer one clear line over a new abstraction), and an in-loop critic that reviews the committed diff for speculative abstraction, hand-rolled stdlib, duplicated dependency features, and logic that shrinks without losing clarity. The default `lite` keeps the ladder on and the critic off, so it costs no extra round; `full` and `ultra` add the critic, and a fresh install opts into `ultra`.
- Two manual commands apply the same rubric without running the loop. `/np:simplify-review` audits a diff, the working tree, or the whole repo (`--repo`) and reports what could be deleted, reused, or condensed, without ever editing or committing. `/np:simplify-debt` keeps a ledger of simplifications you choose to defer, so a shortcut gets tracked instead of forgotten.
- The axis is bounded by the completeness doctrine: it never flags a test, an input validation, an error path, or a security control as removable, and when economy and completeness conflict, completeness wins. On update, `agents.economy: ultra` is backfilled only into a config that has not set it, so an explicit choice is never overwritten. The legacy boolean `agents.economy_critic` still works (`true` maps to `full`, `false` to `lite`).
- `init resume-work` now reconciles every checkpoint against git before deciding orphan: a checkpoint whose task already has a `task(<id>):` commit is a tombstone left behind when the checkpoint was never unlinked (a crash between commit and unlink, or a commit made outside `commit-task`). Those are pruned silently and reported in `pruned_checkpoints`; only genuinely uncommitted checkpoints still surface as `orphan`. Git is the source of truth, so a committed task is never mistaken for in-flight work.
- `np:doctor` is git-aware for the same case: a committed-but-unlinked checkpoint is reported as `info` / `fixable: auto` with the commit sha, not as a manual-fix `warn`.
- The `execute-phase` orphan-checkpoint guard's two remediation options are now wired — "reset-slice" and "resume" were previously no-op `case` branches that left the file in place, so the prompt re-fired on every run.

Full documentation at <https://pilot.nubos.cloud>.

## [1.3.0] — 2026-06-17

Run any agent on any model, not only Claude.

- Per-agent model routing: two new config blocks, `model_providers` and `agent_routing`, send each agent to a specific model in the same run — planner on Claude opus, critic on OpenAI gpt-4o, executor on a local Ollama model. Any provider that speaks the OpenAI `/v1/chat/completions` dialect (OpenAI, xAI/Grok, Ollama, vLLM, LM Studio, LiteLLM) is reached through one `fetch`-based client, with no SDK added. Both blocks are optional; without them, resolution and spawning behave exactly as before.
- When the host can't route an agent to a non-native model — Claude Code's Agent tool only accepts Claude tiers — nubos-pilot runs the loop itself. It's a one-shot, zero-dependency tool-use harness: builds the prompt from `agents/<name>.md`, advertises the agent's tools as function schemas, runs the model's tool-calls against the workspace, and loops until a final answer. No daemon, the process exits when the loop returns.
- The off-host path runs through the same guards as the Claude path: working-tree safety, commit-policy, output-schema lint, the Nubosloop Rule-9 audit, and in-session security review, all unchanged. Off-host file writes are confined through `safe-path`. Off-host Bash runs only inside a slice worktree and stays off until `workflow.worktree_isolation` is on.
- Every workflow spawn now has an off-host branch — execute, plan, discuss, research, architect, validate, verify, scan. A test (`check-offhost-coverage`) walks the workflows and fails the suite if any spawn lacks one, so a new agent can't ship Claude-only by accident.
- A preflight runs before any off-host spawn and fails loud: it checks the server is reachable, the model is present, and tool-calling works, then aborts with an actionable message (`run: ollama pull <model>`) instead of dying mid-task. A routing entry that names an undefined provider is a hard config error at load time, never a quiet fallback to Claude.

Local models are weaker at multi-step tool-use than frontier Claude, so keep high-risk agents like the planner and security-reviewer on Claude — that's why the whole thing is opt-in. ADR-0021 has the full design.

Full documentation at <https://pilot.nubos.cloud>.

## [1.2.4] — 2026-06-15

Fixed a recursion fault in the in-session hooks that could spawn an unbounded cascade of headless `claude -p` processes.

- The Stop-hook security review and continuous-learning capture each spawn a headless `claude -p` to do their work. That headless run re-fires the same SessionStart/Stop hooks, which spawned another headless run, and so on — a fork bomb of `claude`, `np-tools` and duplicated MCP servers that survived closing the terminal. nubos-pilot now marks every headless spawn with `NUBOS_PILOT_HEADLESS=1` and a `NUBOS_PILOT_HOOK_DEPTH` counter; the hooks no-op immediately inside a headless run, so the chain stops at exactly one level.
- Three independent guards back this up: the hook scripts and the `security`/`learnings` backends exit early when `NUBOS_PILOT_HEADLESS` is set; `spawn-headless` refuses to start a nested headless run (reentrancy + depth cap, default one level); and a per-agent lockfile under `.nubos-pilot/run/` bounds concurrent headless runs to one per agent even if the environment is not inherited. Headless runs already carry a hard timeout with SIGKILL, so a hung review cannot linger.
- Escape hatch: the guard keys off `NUBOS_PILOT_HEADLESS`, set automatically on the spawned `claude` — do not set it in your own shell or the in-session hooks will silently no-op. Raise the depth cap with `NUBOS_PILOT_MAX_HOOK_DEPTH` only if you understand the recursion risk.

Full documentation at <https://pilot.nubos.cloud>.

## [1.2.3] — 2026-06-14

Three opt-in layers that make execution cheaper, more reliable, and self-improving.

- Cost-aware model routing: with `workflow.tier_routing` enabled, each task's executor runs at the model tier the plan assigned it — trivial work on a smaller model, structural or security-sensitive work on the strongest — instead of every task running at the top tier. The new `np:derive-tier` command suggests a tier from a task's observable signals (files touched, security/data sensitivity), so the choice is evidence-based. Off by default; behaviour is unchanged until you turn it on.
- Reliability checks (pass@k): set `loop.verify_runs` above 1 and nubos-pilot runs a task's verify command several times per round. A task goes green only when every run passes; a flaky task (passes sometimes, fails sometimes) is treated as red and handed to the build-fixer with a clear note, instead of slipping through on a lucky run. Defaults to a single run.
- Continuous learning: at the end of a session, a lightweight background reviewer reads what changed and distils reusable, durable lessons into the same learnings store the planner consults on the next similar task — so the system improves with use, not only inside the execution loop. On by default and rate-limited to bound cost; disable with `learnings.auto_capture`.

Full documentation at <https://pilot.nubos.cloud>.

## [1.2.2] — 2026-06-05

A dependency graph for the codebase you work in, plus stricter checks on nubos-pilot's own data.

- `np:scan-codebase` now builds a module dependency graph and writes it to `.nubos-pilot/codebase/.graph.json`. The new `np:graph-impact` command shows what a change touches before you make it. It reports which modules depend on a file, what that file depends on, and any dependency cycle it sits in. The graph reads relative imports only. It builds no AST and adds no dependencies.
- Persisted state files are now validated on read against versioned schemas. A corrupt single-document store fails with a clear error code. A bad line in an append-only log is skipped, not fatal.
- The reference docs now list every error code. That list is generated from source and checked on each build, so it cannot drift from the code.
- Internal logging goes through one structured logger. A test keeps `console.*` out of `lib/` and `bin/np-tools/`.
- Added `ATTRIBUTIONS.md`. It names the third-party packages nubos-pilot uses and their licenses.

Full documentation at <https://pilot.nubos.cloud>.

## [1.2.1] — 2026-06-02

Two always-on quality layers that act while the agent writes code.

- In-session security review: nubos-pilot reviews the code it writes for
  vulnerabilities while it works and fixes findings in the same session,
  before they reach a pull request. Three non-blocking depths — an instant
  per-edit pattern scan with no model call, a background semantic review of
  the turn's diff at end of turn, and a deeper review that reads surrounding
  code on each commit or push the agent makes.
- The security reviewer runs independently with a fresh context, reports each
  finding once, and never blocks a write or commit. Extend it with custom
  pattern rules and a review guidance file; built-in checks stay on.
- Requirements-aware executor: `/np:execute-phase` injects the milestone
  success criteria into the executor as its acceptance target, so it writes
  against the requirements from the first round, not just the verify command.
- New configuration blocks `security.*` and `conformance.*`.

Full documentation at <https://pilot.nubos.cloud>.

## [1.2.0] — 2026-05-25

Public release.

- Plan, execute, and verify code changes through a researcher + critic
  agent loop.
- Wave-based milestone execution; one atomic git commit per task.
- Multi-runtime install for 14 host CLIs (Claude Code, Codex, Gemini,
  OpenCode, Cursor, and more) via `npx nubos-pilot`.
- Local vector memory for cross-task learnings.
- Inter-agent messages, handoffs, and project archive with crash-safe
  resume.
- Hardened filesystem operations: symlink-rejecting locks, restricted
  permissions on audit logs, path containment for file-input flags,
  frontmatter sanitisation, and a memory-model allow-list.

Full documentation at <https://pilot.nubos.cloud>.
