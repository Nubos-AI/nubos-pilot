---
command: np:execute-phase
description: Executes a milestone wave-by-wave (slice = wave). Tasks inside a slice run in parallel; slices run serially. One executor agent per task, atomic commit per task via np-tools.cjs commit-task. Pass --verify-work to chain into /np:verify-work on success.
argument-hint: <milestone-number> [--verify-work]
---

# /np:execute-phase

<objective>
Execute every slice of a milestone in wave order: slice S001 first (all its tasks in parallel), then S002, etc. Per task: start a checkpoint, spawn `agents/np-executor.md` (sonnet), verify, and invoke `node .nubos-pilot/bin/np-tools.cjs commit-task <task-full-id>` for the atomic commit. All git operations route through lib/git.cjs — agents NEVER call `git` directly (ADR-0004, CLAUDE.md §Git operations).

**Wave semantics:** one slice == one wave. Tasks in a slice have no intra-slice deps (they're parallel-safe by planner contract). Cross-slice deps flow forward only: a task in S002 may depend on a task in S001.
</objective>

## Initialize

```bash
PHASE="$1"
shift || true

AUTO_VERIFY="false"
for arg in "$@"; do
  case "$arg" in
    --verify-work) AUTO_VERIFY="true" ;;
  esac
done

LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT_ARGS=("init" "execute-milestone" "init" "$PHASE")
if [[ "$AUTO_VERIFY" == "true" ]]; then INIT_ARGS+=("--verify-work"); fi
INIT=$(node .nubos-pilot/bin/np-tools.cjs "${INIT_ARGS[@]}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_EXECUTOR=$(node .nubos-pilot/bin/np-tools.cjs agent-skills executor 2>/dev/null)
RUNTIME=$(node .nubos-pilot/bin/np-tools.cjs detect-runtime)
WORKTREE_ISOLATION=$(node .nubos-pilot/bin/np-tools.cjs config-get workflow.worktree_isolation 2>/dev/null || echo "false")
PARALLELIZATION=$(node .nubos-pilot/bin/np-tools.cjs config-get agents.parallelization 2>/dev/null || echo "true")
TIER_ROUTING=$(node .nubos-pilot/bin/np-tools.cjs config-get workflow.tier_routing 2>/dev/null || echo "false")
VERIFY_RUNS=$(node .nubos-pilot/bin/np-tools.cjs config-get loop.verify_runs 2>/dev/null || echo "1")
ECONOMY=$(node .nubos-pilot/bin/np-tools.cjs economy-mode --json 2>/dev/null || echo '{"mode":"lite","prevention":true,"critic":false,"ultra":false}')
ECONOMY_MODE=$(echo "$ECONOMY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).mode)}catch{console.log("lite")}})')
ECONOMY_PREVENTION=$(echo "$ECONOMY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).prevention)}catch{console.log("true")}})')
ECONOMY_CRITIC=$(echo "$ECONOMY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).critic)}catch{console.log("false")}})')
```

**Economy axis (Ponytail-style graduated modes, SSOT = `economy-mode`).** `$ECONOMY_MODE` is one of `off|lite|full|ultra` (default `lite` = prevention-first). It dials two mechanisms: `$ECONOMY_PREVENTION` (`true` for `lite`/`full`/`ultra`) gates the climb-the-ladder directive injected into the Executor (Step 3); `$ECONOMY_CRITIC` (`true` for `full`/`ultra`) gates the `np-critic-economy.md` audit module injected into np-critic (Step 5). `ultra` additionally tells the critic to lower its `shrinkable` bar. Resolve this ONCE here — never re-read the raw config toggle downstream.

When `--verify-work` is passed, the init payload's `auto_verify: true` flag tells this workflow to chain into `/np:verify-work $PHASE` after every slice committed and `finalize-milestone` ran. Without the flag the workflow stops after finalize as before — verify-work then remains a separate manual step.

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative for this workflow. Obey it for all user-
facing output, askuser prompts, and status updates. Pass `$LANG_DIRECTIVE`
into every np-executor spawn prompt as a system-level rule so task summaries
and checkpoint notes follow the project language. This supersedes any
directive in CLAUDE.md managed block.

Parse JSON for: `milestone`, `milestone_id`, `milestone_dir`, `waves[]` (each with `wave` (= slice number), `slice_id`, `slice_full_id`, `slice_dir`, `tasks[]`, `dispatchable_task_ids[]`, `complete`), `total_tasks`, `slice_count`, `executor_tier`, `auto_verify` (boolean — `true` when `--verify-work` was passed), `milestone_status_started` (`{from, to}` when init lifted the milestone off `pending`/`failed`/`deferred`, else `null`), `text_mode`, `text_mode_source`, `agent_skills`.

**Askuser routing.** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below (including the orphan-checkpoint and empty-milestone prompts) is a spec, not a literal command. Pick the path once at Initialize:
- **Claude Code** (native `AskUserQuestion` tool is available): parse the JSON spec and call `AskUserQuestion` directly. `select` → `multiSelect: false`; `multiselect` → `multiSelect: true`; `confirm` → `options: [{label: "Yes"}, {label: "No"}]`; `input` → ask free-form in chat. Use a short `header` (≤12 chars).
- **`text_mode == true`** (INIT payload): skip every askuser block and render questions as plain-text numbered lists. Opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.
- **Other runtime with TTY** (Codex, Gemini, …): execute the shell `askuser` block verbatim.

`PLAN_ID` is iterated per slice as `${milestone_id}-${slice_id}` (e.g. `M001-S001`). `TASK_ID` is iterated from each slice's `tasks[]` (e.g. `M001-S001-T0001`).

## Skills (Nubos library)

Nubos ships a skill library under `.claude/skills/np-*/` (auto-installed by `npx nubos-pilot`, present only on Claude Code). For each task in a wave, before spawning `np-executor`, classify the task by reading its `T<NNNN>-PLAN.md` and inject the matching skill triggers into the executor's spawn prompt as a "Use these skills" directive. The executor then loads each skill's `SKILL.md` via the runtime's skill mechanism and follows its rules during implementation.

Match the task against **both** tables below — a task can match rows in each (e.g. a new authenticated endpoint backed by a migration is UI-free but matches `np-api-design` + `np-secure-code-review` + `np-data-modeling`). Skills **stack**: trigger every row whose signal the task matches. The only exception is the UI style anchor (pick exactly one). If more than ~4 rows match, keep the most task-critical and always retain any security row (`np-secure-code-review` / `np-threat-model`) and `np-test-strategy` for behaviour changes.

**UI / frontend** (match the dominant signal in `files_modified` + task description):

| Task signal | Skills to trigger |
|---|---|
| Any UI/component edit (`.tsx`, `.jsx`, `.vue`, `.svelte`, `views/**`, `components/**`, `pages/**`, `app/**`) | `np-impeccable` (polish/audit), `np-frontend-design` (build), `np-design` (review), `np-web-design-guidelines` (a11y/UX), `np-accessibility-audit` (WCAG AA bar) |
| `components.json` present in repo OR shadcn/ui imports in modified files | `np-shadcn` (in addition to UI skills above) |
| React/Next.js component or hook edit | `np-react-best-practices`, `np-composition-patterns` |
| Page/route transitions, `<ViewTransition>`, `startViewTransition` | `np-react-view-transitions` |
| React Native / Expo source (`*.tsx` under `app/`, `screens/`, `mobile/**`) | `np-react-native-skills` |
| Restyling an existing surface (no greenfield) | `np-redesign-existing-projects` |
| New surface needing visual direction | Pick exactly **one** style anchor: `np-high-end-visual-design` (default agency premium), `np-minimalist-ui`, `np-industrial-brutalist-ui`, or `np-stitch-design-taste` |

**Engineering / non-UI** (these stack — include each row the task matches):

| Task signal | Skills to trigger |
|---|---|
| Adds/changes a consumed contract — HTTP route, RPC/GraphQL handler, controller, resolver, public SDK/library function, CLI flag | `np-api-design` |
| Touches auth, authz, session, secrets, crypto, SQL/query construction, file upload, deserialization, or any untrusted input reaching a sink | `np-secure-code-review` |
| Introduces or alters a trust boundary — new ingress, webhook/callback, queue consumer, third-party integration, or a new store for credentials/PII | `np-threat-model` (with `np-secure-code-review`) |
| DB schema, migration, ORM model/entity, or any backfill/transform of persisted data | `np-data-modeling` |
| Backend/service/integration/IO path that can fail — external calls, retries, timeouts, batch work | `np-error-handling` |
| Calls an external/unreliable dependency (other service, third-party API, DB under load) | `np-resilience-patterns` (with `np-error-handling`) |
| New service/handler/job/integration path, or a new failure path that must be diagnosable | `np-observability` |
| Data access, queries, loops over collections, hot paths — anything that scales with input size | `np-performance` |
| Adds or changes a cache / memoization layer (in-memory, distributed, HTTP/CDN) | `np-caching-strategy` |
| Message queue, background job, worker, async consumer, or event handler | `np-queue-design` |
| Introduces or changes a module/service boundary, splits a service, or makes a cross-module change | `np-service-boundary` |
| Roles, permissions, policies, resource ownership, or access-rule changes (RBAC/ABAC, authz checks) | `np-access-control` (with `np-secure-code-review`) |
| Encryption, hashing, password storage, TLS, tokens, signing/HMAC, or key/secret management | `np-encryption` |
| Adds or upgrades a third-party dependency, or edits a manifest/lockfile | `np-dependency-audit` |
| Collects, stores, processes, exports, or logs personal/sensitive data (PII) | `np-data-privacy` |
| Refactor / cleanup / restructure where behaviour must be preserved | `np-refactoring` |
| Risky / hard-to-reverse / high-blast-radius change — feature flags, migration coupled to code, change to an external integration | `np-incident-response` |
| LLM / agent / prompt / tool-use / structured-output / AI feature | `np-llm-app-architecture` (add `np-rag-design` if it retrieves from a corpus) |
| Any change to logic or behaviour (almost all non-trivial tasks) | `np-test-strategy` |
| Pure docs/config with no behaviour change | None — skip the skill block |

**Spawn-prompt injection format.** Append to the executor prompt verbatim (one line per matched skill):

```
Use the following Nubos skills for this task: <skill-1>, <skill-2>, ...
Each skill is installed at .claude/skills/<skill>/SKILL.md and encodes a
quality bar you must satisfy before invoking commit-task.
```

**Consultation audit (counterpart to Rule 9).** Whenever you inject a non-empty skill block, BEFORE spawning the executor record the expected set so the post-critics gate can verify the executor actually consulted them:

```bash
node .nubos-pilot/bin/np-tools.cjs skill-audit expect --task "$TASK_ID" --skills "<skill-1>,<skill-2>,..."
```

The executor stamps each skill it reads via `skill-audit ack`. At post-critics, any injected-but-unconsulted skill becomes a `skill-bar-unconsulted` finding that routes the task back to the executor (once per round, bounded by `loop.maxRounds`) — exactly like a Rule-9 search miss. Skip the `expect` call only when zero skills were injected.

If zero skills match, omit the block — do **not** invent skills. Adding new skills under `skills/np-*/` in the source repo is sufficient: the next `npx nubos-pilot update` rolls them out and you extend this mapping in one PR.

## Pre-Flight — orphan-checkpoint guard

Detect stale checkpoints from a prior run before starting new work. `init resume-work` first **reconciles every checkpoint against git** (`lib/checkpoint-reconcile.cjs`): any checkpoint whose task already has a `task(<id>):` commit is a tombstone (finishTask never unlinked it — crash between commit and unlink, or a commit made outside `commit-task`) and is pruned silently. They surface in `RESUME.pruned_checkpoints` for the log, never as a prompt. Only genuinely **uncommitted** checkpoints reach `status: orphan` and the dialog below — so a finished milestone can never block the next one.

```bash
RESUME=$(node .nubos-pilot/bin/np-tools.cjs init resume-work)
RESUME_STATUS=$(echo "$RESUME" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).status))")
if [ "$RESUME_STATUS" = "orphan" ]; then
  ORPHAN_ID=$(echo "$RESUME" | node -e "process.stdin.on('data', d => { const p = JSON.parse(d); console.log((p.checkpoint_ids || [])[0] || '') })")
  CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Verwaiste Checkpoints gefunden",
    "question": "Vor dem Milestone-Start wurde ein uncommitteter Checkpoint ohne passenden STATE.current_task gefunden (kein zugehöriger Commit). Was tun?",
    "options": [
      {"label": "Clean working tree (reset-slice)", "description": "Verwirft die in-flight Task und löscht ihren Checkpoint."},
      {"label": "Resume the orphan task",            "description": "Setzt STATE.current_task auf den Checkpoint-Eintrag und spawnt den Executor."},
      {"label": "Abort",                              "description": "Exit, User entscheidet manuell."}
    ]
  }')
  case "$CHOICE" in
    "Clean working tree (reset-slice)")
      node .nubos-pilot/bin/np-tools.cjs reset-slice "$ORPHAN_ID"
      ;;
    "Resume the orphan task")
      echo "execute-phase: resuming orphan task $ORPHAN_ID — run /np:resume-work" >&2
      exit 0
      ;;
    "Abort") exit 0 ;;
    *)
      # No silent fall-through: falling through here resumed the wave with the
      # orphan checkpoint still in place — the exact 1.3.3 no-op regression.
      echo "execute-phase: unrecognised orphan-guard answer: '$CHOICE' — aborting rather than starting a wave over an orphan checkpoint." >&2
      exit 1
      ;;
  esac
fi
```

**This guard covers unfinished work only.** A task that committed cleanly has no
checkpoint left, so `resume-work` cannot see it — and never should. Re-entry over
**finished** work is guarded one layer down, by the task status itself: see
"Re-entry — finished work is not dispatched again" before the wave loop.

## Pre-Flight — empty milestone guard

```bash
TOTAL_TASKS=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).total_tasks))")
if [ "$TOTAL_TASKS" = "0" ]; then
  echo "execute-phase: milestone $PHASE has 0 tasks. Did /np:plan-phase $PHASE run with task files scaffolded?" >&2
  echo "  Try: /np:plan-phase $PHASE --repromote" >&2
  exit 1
fi
```

## Execution — per-task Nubosloop, slices serial

Every task runs through the **Nubosloop** (ADR-0010, `lib/nubosloop.cjs`) — pre-flight cache lookup → researcher-schwarm (on miss) → executor or build-fixer → mechanical checks + tool-use audit → critic-schwarm → route. The loop terminates only on (a) `loop-evaluate.next_action == "commit"` (zero blocking findings) followed by `commit-task` (atomic commit per ADR-0004), or (b) `loop.maxRounds` cap (default `3`) reached → `loop-run-round --phase stuck` writes the marker, dashboard surfaces it, orchestrator escalates via `askuser`. Single-pass `executor → commit-task` is forbidden — the loop is the only sanctioned path.

**Wave shape (slices serial, tasks parallel within a slice):**

0. **Resolve conditional slice edges** (ADR-0028) before dispatching anything.
1. Dispatch **all tasks in the slice in parallel** — each task is one independent Nubosloop instance.
2. Wait until every task in the slice committed OR is `stuck` OR hit `plan-checker`.
3. If any task is `stuck` or hit `plan-checker` → stop the wave and exit non-zero. Previously committed tasks remain committed.
4. Move to the next slice.

**Step 0a — assert the isolation tier (ADR-0029).** Before any executor spawn,
confirm the configured tier can actually be delivered:

```bash
ISOLATION=$(node .nubos-pilot/bin/np-tools.cjs isolation status --json)
ISOLATION_OK=$?
if [ "$ISOLATION_OK" != "0" ]; then
  echo "[np:execute-phase] the configured isolation tier is unavailable — refusing to execute." >&2
  echo "$ISOLATION" >&2
  exit 1
fi
```

Three tiers, and the weakest is the default because it is the status quo, not
because it is safe: `direct` gives the agent whatever the host CLI grants —
normally your whole account; `worktree` adds version isolation only (ADR-0008 —
parallel slices cannot corrupt each other, but rights are unchanged); `container`
adds rights isolation, mounting the project and nothing else with no network.

**A configured tier is never silently downgraded.** When `isolation.tier` is
`container` and no container runtime is usable, this workflow refuses. Falling
back to `direct` unannounced would hand the plan your full account rights while
you believe it is contained, which is strictly worse than an error. To accept
`direct`, set it explicitly.

When the tier is `container`, obtain each executor spawn's invocation through
`isolation wrap` rather than constructing a `docker run` by hand — the flags it
emits (`--network none`, `--cap-drop ALL`, `--read-only`, env forwarded by name
only) are the tier's guarantees, and a hand-written command silently omits them:

```bash
node .nubos-pilot/bin/np-tools.cjs isolation wrap --env ANTHROPIC_API_KEY -- <executor command>
```

**Step 0b — conditional slice edges.** Most slices are unconditional and this step
is a no-op for them. A slice carrying a `when` in `roadmap.yaml` is gated on how
an earlier slice in the same milestone turned out, and that gate is data, not a
judgement the executor makes:

```bash
SLICE_PLAN=$(node .nubos-pilot/bin/np-tools.cjs slice-plan plan "$PHASE" --json)
SLICE_PLAN_OK=$?
if [ "$SLICE_PLAN_OK" != "0" ]; then
  echo "[np:execute-phase] a slice condition could not be evaluated — refusing the milestone." >&2
  echo "$SLICE_PLAN" >&2
  exit 1
fi
```

Re-run this **before every wave**, not once up front: a decision that was `wait`
becomes `run` or `skip` only after the slice it references reaches a terminal
state, which happens as the milestone executes.

Act on each slice's `decision`:

| Decision | Action |
|---|---|
| `run` | Dispatch the wave normally. |
| `skip` | Do not dispatch. The condition can no longer hold, so the slice is permanently out of this milestone. Record it and move on. |
| `wait` | Do not dispatch **yet**. Re-evaluate after the current wave completes. |
| `error` | Stop. The milestone is not executable until `roadmap.yaml` is fixed. |

**`wait` is not `skip`.** A slice whose referenced predecessor is merely still
in-progress has an undecided condition, and treating that as a skip permanently
drops work the plan asked for. The two are distinct decisions precisely because
collapsing them is the silent-data-loss bug in this feature.

**An unevaluable condition never means "run".** `slice-plan` exits non-zero on a
condition it cannot resolve — an unknown slice reference, a malformed term, an
empty `when: []` — and this workflow refuses the milestone rather than proceeding
with the gate ignored. A gate that opens when it breaks is not a gate.

**A `wait` that can never resolve is a stall, and `slice-plan` refuses it.** The
`wait` instruction above says "come back after the current wave"; when there is no
current wave, that instruction is a loop with no exit condition. `slice-plan plan`
reports `stalled: true` with a `stall_reason` and exits non-zero when slices are
waiting and there is nothing left to dispatch — nothing runnable that is not
already `done`, nothing in progress. No future re-evaluation can change that
answer. Treat it like `error`: stop and fix `roadmap.yaml`. Note that a finished
slice keeps decision `run`, because its gate does hold; `runnable` is the set of
slices whose condition is satisfied, not the set of slices with work left.

A skipped slice does **not** need a separate re-evaluation to settle its
dependents. `slice-plan` re-evaluates to a fixpoint within one call, so a slice
gated on a slice this pass skipped is reported in the same output — as `skip`, or
as `run` where the gate was `status_not` and the skip satisfied it. This holds
regardless of declaration order: a condition may reference a slice declared after
it. Do not persist a status for a skipped slice to force this; the evaluator
handles it and `roadmap.yaml` slice status stays rollup-derived.

**Per-task driver (single agent-native CLI surface):** `node .nubos-pilot/bin/np-tools.cjs loop-run-round <task-id> --phase <preflight|post-executor|post-critics|commit|stuck>`. Every non-LLM transition lives in this verb; LLM spawns (researcher, executor / build-fixer, critics) remain extern and feed their results back via `--query` / `--verify-exit-code` / `--critic-outputs`. A non-LLM runtime can drive the loop with five shell-outs per round.

**Per-task, per-round protocol:**

1. **Pre-flight cache lookup** (Round 1 only) — `loop-run-round --phase preflight --query "$TASK_QUERY"`. A hit at similarity ≥ `swarm.research.threshold` and `occurrence ≥ swarm.research.minOccurrence` short-circuits the Researcher-Schwarm; the cached pattern enters the Executor prompt with provenance `[CACHED]`. Soft cache failures (adapter-unknown) downgrade to a miss with `cache_miss_reason` populated; hard failures (corrupt store, version mismatch) propagate.
2. **Researcher-Schwarm (on cache miss, or on `next_action=researcher` re-route)** — orchestrator spawns `swarm.research.k=3` independent `np-researcher` agents IN PARALLEL (single message, three Agent blocks) and merges their outputs through `lib/researcher-swarm.cjs::mergeConsensus` (Mehrheit / Union / Schnittmenge). The merged consensus enters the Executor prompt with provenance.
3. **Executor (R1) or Build-Fixer (R≥2)** — single LLM spawn. Round 1 spawns `agents/np-executor.md`. Round ≥ 2 spawns `agents/np-build-fixer.md` with prior critic findings + verify output appended. Edits ONLY paths in `files_modified` (D-04 — no scope expansion). Does NOT call `commit-task`. **Off-host (ADR-0021):** when the executor agent routes to an `openai-compat` provider (`agent_routing`), the spawn runs through `spawn-offhost` inside a forced slice worktree instead of the host Agent tool — see the off-host branch in the spawn block below. It satisfies Rule 9 via an injected native `knowledge-search` tool, and the orchestrator runs the same Step-4 audit stamp.
4. **Mechanical Checks (orchestrator, NOT the agent)** — run task's `<verify>` command + the linters the project actually has: `LINTERS=$(node np-tools.cjs detect-stack --lint-commands)` derives them from the manifests present (`composer.json` → `pint`/`phpstan`, `package.json` → `eslint`/`tsc`, `Cargo.toml` → `clippy`, `go.mod` → `golangci-lint`, …). Never hardcode a stack's linters here — `lib/stack.cjs` is the single source of truth, and nubos-pilot targets arbitrary foreign projects. Skip any linter not installed in the project. Capture exit code + output to `$VERIFY_LOG`. Then `loop-audit-tool-use "$TASK_ID" --agent "$EXECUTOR_AGENT" --tool-use-log <json>` confirms the spawn invoked a knowledge-search tool ≥ 1× (Rule 9). The audited agent satisfies Rule 9 by running `node np-tools.cjs knowledge-search "<query>" --task "$TASK_ID" --agent "<its own agent name>"` via Bash, then stamping the exact string `knowledge-search` in `--tool-use-log`. The ledger is matched **per agent**: a search by another agent in the same round does not credit this spawn. The full accepted set is the `SEARCH_TOOLS` constant in `lib/nubosloop.cjs`; that constant is the single source of truth — do not re-enumerate it here. Audit findings get round-stamped and feed `loop-evaluate` alongside critic findings. Then call `loop-run-round --phase post-executor --verify-exit-code "$VERIFY_EXIT" --verify-output-path "$VERIFY_LOG"`. On verify-red the verb returns `next_action: spawn-build-fixer` — skip critics, advance to next round directly.
5. **Critic (verify-green only)** — one Critic agent spawns: `agents/np-critic.md` (sonnet). It writes the full findings JSON to `$CRITIC_REPORT_PATH` and emits a small verdict envelope as its final message (ADR-0010 §L5 Verdict-Only Contract, 2026-05-05). Single-critic revision per §Trust Layer 2026-05-05 — the prior 3-critic schwarm collapsed because three parallel spawns added latency without proportional finding-quality gains; the Verdict-Only Contract on top reduces per-round main-context tokens by an order of magnitude (verbatim findings reports were the dominant Nubosloop cost-driver).
6. **Route** — `loop-run-round --phase post-critics --critic-outputs-path "$CRITIC_REPORT_PATH"` (or legacy `--critic-outputs "$CRITIC_JSON"` when the Verdict-Only Contract is unavailable) returns `next_action ∈ {commit, executor, researcher, askuser, plan-checker, stuck}`:

   | `next_action`    | Trigger                            | Action                                                          |
   |------------------|------------------------------------|-----------------------------------------------------------------|
   | `commit`         | Zero blocking findings             | `loop-run-round --phase commit` + `commit-task` (atomic)        |
   | `executor`       | Style/Bug/Test/Acceptance findings | R≥2: spawn `np-build-fixer` with prior findings (next round)    |
   | `researcher`     | `information-missing` finding      | Re-run Researcher-Schwarm with the gap as input (next round)    |
   | `askuser`        | `question-to-user` finding         | Block on user reply via `askuser`; resume same round            |
   | `plan-checker`   | `locked-decision-violation`        | Abort wave; orchestrator escalates                              |
   | `stuck`          | `loop.maxRounds` reached           | `loop-run-round --phase stuck` + dashboard + askuser escalation |

7. **Commit** — `loop-run-round --phase commit --learning-pattern "$CONSENSUS_PATTERN" --learning-outcome verified` stamps the checkpoint to `pre-commit` and auto-logs the learning (when `auto_log_learning=true`, default — feeds future Round-1 cache hits). Then `node .nubos-pilot/bin/np-tools.cjs commit-task "$TASK_ID"` performs the atomic commit per ADR-0004.

   **Two terminal outcomes**, both exit 0 and complete the task:

   | `committed` | `skip_reason`           | When it fires                                                              | Wave handling |
   |-------------|-------------------------|----------------------------------------------------------------------------|---------------|
   | `true`      | _(absent)_              | At least one `files_modified` entry is tracked → atomic commit lands       | Continue      |
   | `false`     | `artifacts-gitignored`  | Every `files_modified` entry is gitignored (e.g. `.nubos-pilot/codebase/modules/*.md` when artifacts aren't versioned) | Continue — task is done, no commit produced |

   The orchestrator checks `git check-ignore --quiet --` per file: exit 0 = ignored, exit 1 = tracked, exit ≥ 2 = real failure (propagate). Soft-skip is not a failure mode — `commit-task` deletes the checkpoint and sets task status to `done` symmetric to a real commit. **Mixed paths** (some tracked, some ignored) commit only the tracked subset and emit a `[nubos-pilot warn] gitignored (skipping): …` line; the task is `committed: true` with `files_ignored` populated for audit. Gitignore state is a routing signal, never a hard stop — symmetric to the container-state doctrine.

**Per-task loop control values (read once at wave start):**

```bash
LOOP_MAX_ROUNDS=$(node .nubos-pilot/bin/np-tools.cjs config-get loop.maxRounds 2>/dev/null || echo 3)
SWARM_K=$(node .nubos-pilot/bin/np-tools.cjs config-get swarm.research.k 2>/dev/null || echo 3)
SWARM_THRESHOLD=$(node .nubos-pilot/bin/np-tools.cjs config-get swarm.research.threshold 2>/dev/null || echo 0.9)
SWARM_MIN_OCC=$(node .nubos-pilot/bin/np-tools.cjs config-get swarm.research.minOccurrence 2>/dev/null || echo 3)
AUTO_LOG_LEARNING=$(node .nubos-pilot/bin/np-tools.cjs config-get auto_log_learning 2>/dev/null || echo true)
SPAWN_HEADLESS_ENABLED=$(node .nubos-pilot/bin/np-tools.cjs config-get spawn.headless.enabled 2>/dev/null || echo false)
SPAWN_HEADLESS_AGENTS=$(node .nubos-pilot/bin/np-tools.cjs config-get spawn.headless.agents 2>/dev/null || echo '["np-critic","np-researcher"]')
SPAWN_HEADLESS_FALLBACK=$(node .nubos-pilot/bin/np-tools.cjs config-get spawn.headless.fallback_on_error 2>/dev/null || echo true)
CONF_INJECT_CRITERIA=$(node .nubos-pilot/bin/np-tools.cjs config-get conformance.inject_criteria 2>/dev/null || echo true)
# Round-1 prep agents (default on; backfilled on install/update). When a toggle
# is false the matching ACTION CONTRACT (Step 2b / Step 2c) is skipped wholesale.
ARCHITECT_ENABLED=$(node .nubos-pilot/bin/np-tools.cjs config-get agents.architect 2>/dev/null || echo true)
TEST_WRITER_ENABLED=$(node .nubos-pilot/bin/np-tools.cjs config-get agents.test_writer 2>/dev/null || echo true)
# Milestone success_criteria as the executor's acceptance target (rendered once from the INIT payload).
# Intent-level only (ADR-0019): these describe what "done right" means, NOT how to build it.
SUCCESS_CRITERIA_BLOCK=$(echo "$INIT" | node -e 'process.stdin.on("data",d=>{try{const c=JSON.parse(d).success_criteria||[];console.log(c.map(x=>"- "+(x.id?x.id+": ":"")+(x.text||x)).join("\n"))}catch(e){console.log("")}})')
```

## Spawn dispatch — agent-tool vs. headless subprocess (ADR-0010 §L6)

By default, `np-researcher` and `np-critic` spawns go through the runtime's
native Agent tool — the parent context picks up the spawn's final message as a
tool result. When `spawn.headless.enabled=true` AND the agent name appears in
`spawn.headless.agents`, the orchestrator instead shells out to
`node .nubos-pilot/bin/np-tools.cjs spawn-headless --agent <name> ...`, which
runs the agent inside an isolated `claude -p` subprocess. The subprocess'
final-message is captured to disk; the parent context only sees an exit code
plus the path. This buys true context detach for the verbose-but-bounded
critic/researcher passes — at the cost of an own prompt cache, separate auth,
and a cold-start per spawn.

**Dispatch helper (use at every np-researcher / np-critic spawn point):**

```bash
_spawn_dispatch_is_headless() {
  local agent="$1"
  [ "$SPAWN_HEADLESS_ENABLED" = "true" ] || return 1
  echo "$SPAWN_HEADLESS_AGENTS" | node -e \
    "let l=''; process.stdin.on('data',d=>l+=d); process.stdin.on('end',()=>{
      try { const arr = JSON.parse(l); process.exit(arr.includes(process.argv[1]) ? 0 : 1); }
      catch (e) { process.exit(1); }
    })" "$agent"
}
```

For each headless spawn the orchestrator (a) writes the rendered prompt to
`${TMPDIR:-/tmp}/nubos-pilot/prompts/<agent>-<task-id>-r<round>.md`,
(b) calls `spawn-headless --agent <name> --prompt-path … --output-path …`,
(c) on non-zero exit AND `spawn.headless.fallback_on_error=true`, falls back to
the regular agent-tool spawn. Falling back is logged on the checkpoint
(`spawn_headless_fallbacks[]`) so the fallback rate is visible on
`/np:dashboard`. **The Layer-C `loop-audit-tool-use` stamp is identical for
both paths** — it is the orchestrator's responsibility to call it after the
spawn returns, regardless of whether the spawn went through the agent tool or
the headless subprocess. Bypassing the audit by going headless is a Layer-C
violation by the same definition as before.

`np-executor` and `np-build-fixer` are NEVER eligible for headless spawn —
they edit files in the working tree and depend on the parent runtime's file
write semantics. `spawn.headless.agents` defaults to `['np-critic','np-researcher']`
for exactly this reason; do not extend it without understanding which agents
mutate the working tree.

**Per-task max-rounds override (T3, ADR-0010 Trust-Layer):** before entering the per-task while-loop, check the task's checkpoint for a `max_rounds_override` (set when the operator answered the stuck-dialog with "Weitermachen +5 Runden"). If present, it beats the config default — both for the bash while-cap and for the `post-critics` `evaluateLoop` cap.

```bash
OVERRIDE=$(node .nubos-pilot/bin/np-tools.cjs loop-state-read "$TASK_ID" 2>/dev/null \
  | node -e 'process.stdin.on("data",d=>{try{const j=JSON.parse(d);const o=j&&j.nubosloop&&j.nubosloop.max_rounds_override;console.log(Number.isInteger(o)&&o>=1?o:"")}catch(e){console.log("")}}')
[ -n "$OVERRIDE" ] && LOOP_MAX_ROUNDS="$OVERRIDE"
```

**ACTION CONTRACT — task dispatch within a slice (`$PARALLELIZATION`)**

The `for TASK_ID in $TASK_IDS` loop in the block below is written serially because
bash cannot express the orchestrator's parallel primitive. **How you actually
dispatch it is decided by `$PARALLELIZATION` (read in Step 0), and this contract is
the only authority on that:**

- **`$PARALLELIZATION == "true"` (default)** — one Nubosloop instance per task,
  **all tasks of the wave dispatched together**: each LLM step of the loop body
  goes out as ONE message containing one real Agent tool-call per task (not bash).
  Slice-as-wave is the point; the planner already proved the tasks are
  independent (`plan-lint::lintParallelTaskRaces`).
- **`$PARALLELIZATION == "false"`** — run the tasks **one after another**: task
  `N+1`'s pre-flight only after task `N` reached `commit` or `stuck`. This is the
  kill-switch for constrained environments (single-thread CI, rate-limited model
  APIs). It is strictly slower and buys no atomicity — that is per-task either way.

Do not read this value as advisory and dispatch in parallel anyway: an operator who
set `false` did so because their environment cannot take the concurrency.

## Re-entry — finished work is not dispatched again

`/np:execute-phase` on a partially finished milestone is the normal case, not an
edge case: a session ends, the operator starts a new one, the same milestone gets
re-run. Every task that reached `commit` is already `done` in its own frontmatter —
`commit-task` sets it, and the rollup derives the slice status from it into
`roadmap.yaml`. **Re-running such a task costs a full Nubosloop — researcher swarm,
executor, critics — and produces nothing.**

Two mechanisms keep that from happening; neither is optional:

- **`dispatchable_task_ids`** on each wave is the *only* legitimate source for
  `TASK_IDS`. It excludes `done`, `skipped` and `parked` (parked exclusion is
  `/np:park`'s documented contract). `tasks[]` stays complete on purpose — the
  slice summary and the wave banner need the full picture — so building the
  dispatch list from `tasks.map(t => t.id)` silently re-runs finished work.
- **`init execute-milestone execute-task` refuses** a non-dispatchable task with
  `execute-milestone-task-not-dispatchable` (exit non-zero). This is the backstop
  for an orchestrator that ignored the first rule. `--allow-redo` overrides it —
  use that only for a deliberate re-run, and reset the task properly
  (`/np:undo-task`, `/np:unpark`) when the intent is to redo it for real.

A wave whose tasks are all finished carries `complete: true`; skip it whole rather
than entering it with an empty task list — an empty wave would still create a
worktree and finalize the slice for nothing.

**Wave + per-task pseudocode (this is the executable shape — the orchestrator drives this verbatim, not just „shape but not concrete syntax"):**

```bash
for WAVE_INDEX in 0 1 2 ...; do
  WAVE=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.stringify(JSON.parse(d).waves[$WAVE_INDEX])))")
  [ -z "$WAVE" ] || [ "$WAVE" = "undefined" ] && break

  SLICE_FULL_ID=$(echo "$WAVE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).slice_full_id))")

  if [ "$(echo "$WAVE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).complete))")" = "true" ]; then
    echo "=== Wave $((WAVE_INDEX+1)): $SLICE_FULL_ID — already finished, skipping ===" >&2
    continue
  fi

  # NEVER build this from .tasks — that list contains already-finished tasks too.
  # dispatchable_task_ids excludes done / skipped / parked (see the re-entry section above).
  TASK_IDS=$(echo "$WAVE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).dispatchable_task_ids.join(' ')))")

  echo "=== Wave $((WAVE_INDEX+1)): $SLICE_FULL_ID — tasks: $TASK_IDS ===" >&2

  # Worktree-Isolation (ADR-0008): when workflow.worktree_isolation=true,
  # create an isolated git worktree for this slice. Nubosloop instances
  # run inside the worktree (cwd = worktree path); commits land on the
  # slice branch np/<slice-full-id>; FF-merged back on success.
  SLICE_CWD="$PWD"
  if [ "$WORKTREE_ISOLATION" = "true" ]; then
    WT_CREATE=$(node .nubos-pilot/bin/np-tools.cjs worktree-create "$SLICE_FULL_ID")
    SLICE_CWD=$(echo "$WT_CREATE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).path))")
    echo "[np:execute-phase] worktree created at $SLICE_CWD (branch np/$SLICE_FULL_ID)" >&2
  fi

  SLICE_COMMITTED_ANY=false

  # Dispatch per $PARALLELIZATION — see the ACTION CONTRACT above this block.
  for TASK_ID in $TASK_IDS; do

    node .nubos-pilot/bin/np-tools.cjs checkpoint start "$TASK_ID" \
      --phase "$PHASE" --plan "$SLICE_FULL_ID" --wave "$((WAVE_INDEX+1))"

    TASK_JSON=$(node .nubos-pilot/bin/np-tools.cjs init execute-milestone execute-task "$PHASE" "$TASK_ID")
    if [[ "$TASK_JSON" == @file:* ]]; then TASK_JSON=$(cat "${TASK_JSON#@file:}"); fi
    TASK_QUERY=$(echo "$TASK_JSON" | node -e "process.stdin.on('data', d => { const j=JSON.parse(d); console.log(j.query || j.name || ''); })")
    TASK_TIER=$(echo "$TASK_JSON" | node -e "process.stdin.on('data', d => { const j=JSON.parse(d); console.log(j.tier || 'sonnet'); })")

    EXECUTOR_START=$(node .nubos-pilot/bin/np-tools.cjs metrics start-timestamp)
    CONSENSUS_PATTERN=""
    NEXT_ACTION=""
    CACHE_HIT="false"
    ROUND=1
    # T3: honor a max_rounds_override stamped by a prior stuck-dialog
    # ("Weitermachen +5 Runden"). Survives /np:resume-work after a crash.
    TASK_OVERRIDE=$(node .nubos-pilot/bin/np-tools.cjs loop-state-read "$TASK_ID" 2>/dev/null \
      | node -e 'process.stdin.on("data",d=>{try{const j=JSON.parse(d);const o=j&&j.nubosloop&&j.nubosloop.max_rounds_override;console.log(Number.isInteger(o)&&o>=1?o:"")}catch(e){console.log("")}}')
    [ -n "$TASK_OVERRIDE" ] && LOOP_MAX_ROUNDS="$TASK_OVERRIDE"

    while [ "$ROUND" -le "$LOOP_MAX_ROUNDS" ]; do

      # === Step 1: pre-flight cache lookup (Round 1 only) ===
      if [ "$ROUND" -eq 1 ]; then
        PREFLIGHT=$(node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
          --phase preflight --query "$TASK_QUERY")
        CACHE_HIT=$(echo "$PREFLIGHT" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).cache_hit||false))')
      fi

      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # ACTION CONTRACT — Step 2: Researcher-Schwarm
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # WHEN: Round 1 cache-miss ($CACHE_HIT != "true") OR $NEXT_ACTION=researcher.
      # SKIP-GUARD: loop-post-researcher-missing-spawn-audit (needs $SWARM_K audits).
      # NO short-circuit. NO synthetic consensus. NO topic-split.
      #
      # Execute EXACTLY these three groups, in order:
      #
      # (1) ONE message with $SWARM_K PARALLEL Agent tool-calls (real tool-calls,
      #     not bash). Default $SWARM_K=3:
      #       Agent(subagent_type="np-researcher", prompt=<spawn_specs[0]>)
      #       Agent(subagent_type="np-researcher", prompt=<spawn_specs[1]>)
      #       Agent(subagent_type="np-researcher", prompt=<spawn_specs[2]>)
      #     Every prompt: <task_query>=$TASK_QUERY verbatim (identical for all k),
      #     <seed_delta>=swarm.spawn_specs[i].seed_delta (one line, per-spawn),
      #     <files_to_read>=task plan + slice plan + prior slice SUMMARYs +
      #     CONTEXT.md + codebase docs. Each spawn writes structured output to
      #     $TMPDIR/np-spawn-${TASK_ID}-r${ROUND}-${i}.json.
      #
      # (2) $SWARM_K Bash audit-stamps (one per returned spawn, same round):
      #       node .nubos-pilot/bin/np-tools.cjs loop-audit-tool-use "$TASK_ID" \
      #         --agent np-researcher --tool-use-log <tool_use_json_array>
      #
      # (3) ONE Bash advance:
      #       node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
      #         --phase post-researcher
      #
      # Then merge: CONSENSUS_PATTERN=$(node .nubos-pilot/bin/researcher-merge.cjs
      # "${SPAWN_OUT_PATHS[@]}") — provenance [VERIFIED] on majority+citation,
      # else [PROVISIONAL]. Cache-hit branch (R1, $CACHE_HIT=true) skips (1)-(3)
      # and leaves $CONSENSUS_PATTERN empty (commit auto-log skips on cache_hit).
      #
      # Rationale: ADR-0010 §Gap-#6 — synthetic-consensus-bypass mechanisch
      # geblockt (2026-05-05). Topic-splitting collapses agreement_score → 0.
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if { [ "$ROUND" -eq 1 ] && [ "$CACHE_HIT" != "true" ]; } || [ "$NEXT_ACTION" = "researcher" ]; then
        SPAWN_SPECS=$(echo "$PREFLIGHT" | node -e \
          'process.stdin.on("data",d=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify((j.swarm&&j.swarm.spawn_specs)||[]))})')
        # Off-host researcher swarm (ADR-0021): if np-researcher routes to an
        # openai-compat provider, run $SWARM_K read-only spawns via spawn-offhost.
        # np-researcher is Rule-9-audited → --task-id injects knowledge-search;
        # read-only ⇒ no worktree needed. Each spawn MUST emit the per-spawn
        # consensus JSON { decisions[], risks[], patterns[], open_questions[],
        # sources[] } that researcher-merge consumes (NOT the researcher-output
        # markdown artifact — that schema is for M<NNN>-RESEARCH.md, a different
        # contract). A spawn whose output is not that JSON is substituted with an
        # empty {} so researcher-merge degrades gracefully instead of aborting the
        # wave (exit 4). --no-audit defers the Rule-9 stamp to the orchestrator's
        # group-(2) loop-audit-tool-use (one per spawn) so the post-researcher
        # SKIP-GUARD is satisfied exactly as for native spawns.
        RESEARCHER_KIND=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-researcher --json 2>/dev/null \
          | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).kind||"native")}catch{console.log("native")}})')
        if [ "$RESEARCHER_KIND" = "openai-compat" ]; then
          SWARM_K=$(echo "$PREFLIGHT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.swarm&&j.swarm.k)||3)})')
          SPAWN_OUT_PATHS=()
          i=0
          while [ "$i" -lt "$SWARM_K" ]; do
            OUT_PATH="${TMPDIR:-/tmp}/np-spawn-${TASK_ID}-r${ROUND}-${i}.json"
            R_PROMPT="${TMPDIR:-/tmp}/np-offhost-researcher-${TASK_ID}-r${ROUND}-${i}.md"
            # … render researcher prompt i (task_query verbatim + seed_delta[i] + files_to_read) …
            R_OUT=$(node .nubos-pilot/bin/np-tools.cjs spawn-offhost \
              --agent np-researcher --task-file "$R_PROMPT" --task-id "$TASK_ID" \
              --read-only --no-audit ${SLICE_CWD:+--cwd "$SLICE_CWD"})
            echo "$R_OUT" | OUT_PATH="$OUT_PATH" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let c="";try{c=JSON.parse(s).content||""}catch{}var ok=false;try{JSON.parse(c);ok=true}catch{}if(!ok){process.stderr.write("off-host researcher: spawn output is not the {decisions,risks,patterns,open_questions,sources} JSON researcher-merge expects — substituting empty consensus for this spawn\n");c="{}"}require("fs").writeFileSync(process.env.OUT_PATH,c)})'
            R_LOG=$(echo "$R_OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify((JSON.parse(s).toolLog||[]).map(t=>t.name)))}catch{console.log("[]")}})')
            node .nubos-pilot/bin/np-tools.cjs loop-audit-tool-use "$TASK_ID" --agent np-researcher --tool-use-log "$R_LOG"
            SPAWN_OUT_PATHS+=("$OUT_PATH")
            i=$((i+1))
          done
        else
          true  # → execute groups (1) + (2) per ACTION CONTRACT above (native Agent spawns).
        fi
        CONSENSUS_PATTERN=$(node .nubos-pilot/bin/researcher-merge.cjs \
          "${SPAWN_OUT_PATHS[@]}")
        node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" --phase post-researcher
      elif [ "$CACHE_HIT" = "true" ] && [ -z "$CONSENSUS_PATTERN" ]; then
        CONSENSUS_PATTERN=""
      fi

      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # ACTION CONTRACT — Step 2b: Per-Task Architect (Round 1, config-gated)
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # WHEN: $ROUND -eq 1 AND $ARCHITECT_ENABLED = true. Skip wholesale otherwise
      #   (agents.architect=false → no architect this run; R≥2 build-fixer rounds
      #   never run it).
      # SKIP-GUARD: loop-post-architect-missing-spawn-audit (needs 1 architect audit).
      #
      # Execute EXACTLY these three groups, in order:
      #
      # (1) ONE Agent tool-call (real, not bash):
      #       Agent(subagent_type="np-task-architect", prompt=<…>)
      #     Prompt fields:
      #       <files_to_read>: task plan, slice plan, CONTEXT.md, RULES.md,
      #         M<NNN>-ARCHITECTURE.md (if present), .nubos-pilot/codebase/INDEX.md
      #       <consensus_pattern>: $CONSENSUS_PATTERN (researcher output; may be empty)
      #       <lang_directive>: $LANG_DIRECTIVE
      #     Curated skills (quality bar) — instruct the agent to Read each that
      #     applies from .claude/skills/<skill>/SKILL.md: np-system-design,
      #     np-service-boundary, np-api-design, np-composition-patterns,
      #     np-error-handling, np-adr (only for a costly-to-reverse choice).
      #     The agent is READ-ONLY: it emits its Task-Architecture spec as its FINAL
      #     MESSAGE (markdown per its Output Contract). Write that message verbatim
      #     to "$ARCH_CONSTRAINTS_PATH".
      #
      # (2) ONE Bash audit-stamp (same round) — architect is NOT Rule-9 audited,
      #     so an empty tool-use log is correct:
      #       node .nubos-pilot/bin/np-tools.cjs loop-audit-tool-use "$TASK_ID" \
      #         --agent np-task-architect --tool-use-log '[]'
      #
      # (3) ONE Bash advance:
      #       node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
      #         --phase post-architect
      #
      # $ARCH_CONSTRAINTS is injected as <architecture_constraints> into the
      # test-writer (Step 2c) AND executor (Step 3) prompts.
      #
      # Rationale: ADR-0023 — a per-task structural pass before tests/code so the
      # test-writer and executor build against a decided shape, honouring RULES.md
      # Conventions. Ephemeral ($TMPDIR, never committed) → plan-lint untouched.
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      ARCH_CONSTRAINTS=""
      ARCH_CONSTRAINTS_PATH="${TMPDIR:-/tmp}/np-arch-${TASK_ID}.md"
      if [ "$ROUND" -eq 1 ] && [ "$ARCHITECT_ENABLED" = "true" ]; then
        # Off-host (ADR-0021): np-task-architect is read-only (Read/Grep/Glob), not
        # Rule-9 audited, writes no files — run via spawn-offhost with default cwd
        # when it routes to an openai-compat provider; its spec returns as the
        # spawn's final message (content).
        ARCHITECT_KIND=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-task-architect --json 2>/dev/null \
          | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).kind||"native")}catch{console.log("native")}})')
        if [ "$ARCHITECT_KIND" = "openai-compat" ]; then
          A_PROMPT="${TMPDIR:-/tmp}/np-offhost-task-architect-${TASK_ID}.md"
          # … render the files_to_read block + consensus + skills + $LANG_DIRECTIVE into "$A_PROMPT" …
          A_OUT=$(node .nubos-pilot/bin/np-tools.cjs spawn-offhost \
            --agent np-task-architect --task-file "$A_PROMPT" --task-id "$TASK_ID" \
            --read-only --no-audit ${SLICE_CWD:+--cwd "$SLICE_CWD"})
          echo "$A_OUT" | ARCH_PATH="$ARCH_CONSTRAINTS_PATH" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let c="";try{c=JSON.parse(s).content||""}catch{}require("fs").writeFileSync(process.env.ARCH_PATH,c)})'
        else
          true  # → execute group (1): native Agent spawn; write its final message to "$ARCH_CONSTRAINTS_PATH".
        fi
        node .nubos-pilot/bin/np-tools.cjs loop-audit-tool-use "$TASK_ID" --agent np-task-architect --tool-use-log '[]'
        node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" --phase post-architect
        [ -f "$ARCH_CONSTRAINTS_PATH" ] && ARCH_CONSTRAINTS=$(cat "$ARCH_CONSTRAINTS_PATH")
      fi

      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # ACTION CONTRACT — Step 2c: Test-Writer / TDD (Round 1, config-gated)
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # WHEN: $ROUND -eq 1 AND $TEST_WRITER_ENABLED = true. Runs AFTER the architect,
      #   BEFORE the executor. Skip wholesale otherwise.
      # SKIP-GUARD: loop-post-test-writer-missing-spawn-audit (needs 1 test-writer audit).
      #
      # Execute EXACTLY these three groups, in order:
      #
      # (1) ONE Agent tool-call (real, not bash):
      #       Agent(subagent_type="np-test-writer", prompt=<…>)
      #     Prompt fields:
      #       <files_to_read>: task plan, slice plan, RULES.md, neighbouring tests
      #       <architecture_constraints>: $ARCH_CONSTRAINTS (the architect's required
      #         test surfaces; empty when the architect is disabled)
      #       <success_criteria>: $SUCCESS_CRITERIA_BLOCK + slice UAT path (intent-level)
      #       <lang_directive>: $LANG_DIRECTIVE
      #     Curated skill (quality bar) — instruct the agent to Read
      #     .claude/skills/np-test-strategy/SKILL.md and satisfy its Verification bar.
      #     RULES — the agent writes REAL, VALID test files for every required surface;
      #     it MUST NOT skip/stub/weaken assertions (Rule 10). Tests MAY be red now;
      #     the executor makes them green. The agent emits a JSON envelope whose
      #     tests_written paths you collect into $TDD_TESTS.
      #
      # (2) ONE Bash audit-stamp (same round) — test-writer is NOT Rule-9 audited:
      #       node .nubos-pilot/bin/np-tools.cjs loop-audit-tool-use "$TASK_ID" \
      #         --agent np-test-writer --tool-use-log '[]'
      #
      # (3) ONE Bash advance — pass the written test paths so they are recorded in
      #     the checkpoint (nubosloop.tdd_tests) and commit-task folds them into the
      #     commit even when files_modified did not enumerate them:
      #       node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
      #         --phase post-test-writer --tests "$TDD_TESTS"
      #
      # Rationale: ADR-0023 — TDD inside the loop. The mechanical verify gate
      # (Step 4) runs only AFTER the executor, so red-until-executor is expected
      # and not a failure. The np-critic-tests axis (Step 5) re-audits for any
      # skipped/vacuous assertions that slipped through.
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      TDD_TESTS=""
      if [ "$ROUND" -eq 1 ] && [ "$TEST_WRITER_ENABLED" = "true" ]; then
        # Off-host (ADR-0021): np-test-writer writes test files, so off-host needs
        # worktree isolation exactly like the executor (model-driven Write confined
        # + ff-merged back). When worktree isolation is off, it runs native.
        TEST_WRITER_KIND=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-test-writer --json 2>/dev/null \
          | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).kind||"native")}catch{console.log("native")}})')
        if [ "$TEST_WRITER_KIND" = "openai-compat" ] && [ "$WORKTREE_ISOLATION" = "true" ] && [ -n "$SLICE_CWD" ] && [ "$SLICE_CWD" != "." ]; then
          TW_PROMPT="${TMPDIR:-/tmp}/np-offhost-test-writer-${TASK_ID}.md"
          # … render files_to_read + architecture_constraints + success_criteria + skill + $LANG_DIRECTIVE into "$TW_PROMPT" …
          TW_OUT=$(node .nubos-pilot/bin/np-tools.cjs spawn-offhost \
            --agent np-test-writer --task-file "$TW_PROMPT" --task-id "$TASK_ID" \
            --cwd "$SLICE_CWD" --allow-bash --no-audit)
          TDD_TESTS=$(echo "$TW_OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(JSON.parse(s).content||"{}");console.log((j.tests_written||[]).join(", "))}catch{console.log("")}})')
        else
          true  # → execute group (1): native Agent spawn; collect tests_written from the envelope into $TDD_TESTS.
        fi
        node .nubos-pilot/bin/np-tools.cjs loop-audit-tool-use "$TASK_ID" --agent np-test-writer --tool-use-log '[]'
        node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" --phase post-test-writer --tests "$TDD_TESTS"
      fi

      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # ACTION CONTRACT — Step 3: Executor (R1) / Build-Fixer (R≥2)
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # Execute EXACTLY:
      #
      # (1) ONE Agent tool-call (real, not bash) — R1: np-executor, R≥2: np-build-fixer:
      #       Agent(subagent_type="$EXECUTOR_AGENT", model="$EXECUTOR_MODEL", prompt=<…>)
      #     Prompt fields:
      #       <files_to_read>: task plan, slice plan, prior slice SUMMARYs, CONTEXT.md
      #       <consensus_pattern>: $CONSENSUS_PATTERN (with [VERIFIED]/[PROVISIONAL]/[CACHED])
      #       <architecture_constraints>: $ARCH_CONSTRAINTS — the per-task architect's
      #         decided structure + constraints (empty when agents.architect is off).
      #         The executor builds against this shape; it is intent-level, not a code spec.
      #       <tdd_tests>: $TDD_TESTS — test files np-test-writer wrote (R1, empty when off).
      #         The executor MUST make them green WITHOUT deleting, skipping, or weakening
      #         any assertion. They are in scope alongside files_modified (recorded in the
      #         checkpoint at post-test-writer) and commit-task commits them with the diff.
      #       <success_criteria>: when $CONF_INJECT_CRITERIA = true, include the milestone
      #         acceptance target — $SUCCESS_CRITERIA_BLOCK plus the slice UAT path
      #         (.nubos-pilot/milestones/M<NNN>/slices/S<NNN>/S<NNN>-UAT.md). Frame it as
      #         "what done-right means (intent, ADR-0019) — NOT a build spec, NOT a scope
      #         expansion". Omit the field entirely when the flag is false.
      #       <prior_findings>: critic findings JSON   (R≥2 only)
      #       <verify_excerpt>: tail of $VERIFY_LOG    (R≥2 only)
      #       <lang_directive>: $LANG_DIRECTIVE
      #       <skills>: $AGENT_SKILLS_EXECUTOR
      #       <economy_mode>: $ECONOMY_MODE — when $ECONOMY_PREVENTION = true (lite/full/
      #         ultra) instruct the agent to APPLY the np-executor "Climb the ladder"
      #         discipline before writing (prevention-first). When $ECONOMY_MODE = off,
      #         instruct it to SKIP the ladder (no economy pressure this run).
      #     RULES — Agent MUST: edit ONLY paths in files_modified plus the <tdd_tests>
      #     paths (D-04 scope guard; the TDD tests are the sole sanctioned addition) —
      #     success_criteria are the acceptance target, NEVER a licence to touch other files,
      #     run `node np-tools.cjs knowledge-search "<q>" --task $TASK_ID --agent <its own agent name>`
      #     via Bash ≥1× (Rule 9 — --task writes the audit evidence ledger, --agent
      #     credits it to this spawn; the ledger is matched per agent, so omitting
      #     --agent leaves the audit unsatisfied),
      #     NOT call commit-task. Capture tool_use stream for audit (group (3) below).
      #
      # (2) Checkpoint transition (Bash, runs AFTER Agent returns):
      #       node .nubos-pilot/bin/np-tools.cjs checkpoint transition "$TASK_ID" verifying
      #
      # (3) Tool-use audit-stamp (Bash) — see Step 4 below; this is the
      #     post-executor evidence required by Layer-C guard
      #     `loop-post-executor-missing-spawn-audit`.
      #
      # Rationale: ADR-0010 Layer-C — verify-green stamped without an actual
      # Agent spawn is the canonical bypass; the audit-stamp is what makes the
      # gate's "the executor actually ran" check non-fakeable.
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if [ "$ROUND" -eq 1 ]; then
        EXECUTOR_AGENT="np-executor"
      else
        EXECUTOR_AGENT="np-build-fixer"
      fi
      # Model resolution. Default (tier_routing off): the executor always runs at
      # the `frontier` profile — every task gets the strongest model. Opt-in
      # tier-routing (config `workflow.tier_routing: true`) instead honours the
      # planner's per-task `tier` under the project's configured `model_profile`
      # (default `balanced`), so trivial→haiku / standard→sonnet / large→opus —
      # ECC-style cost-aware routing. Round-2+ build-fixer always stays frontier:
      # fixing a failing task wants the strongest model regardless of routing.
      if [[ "$TIER_ROUTING" == "true" && "$ROUND" -eq 1 ]]; then
        EXECUTOR_MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model "$TASK_TIER")
      else
        EXECUTOR_MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model "$EXECUTOR_AGENT" --profile frontier)
      fi

      # ━━━ Off-host executor (ADR-0021) — config-driven via agent_routing ━━━
      # If $EXECUTOR_AGENT routes to an openai-compat provider, run it through
      # the nubos-pilot dispatch loop (spawn-offhost) instead of the host Agent
      # tool. Off-host REQUIRES worktree isolation: the existing per-wave worktree
      # (created at §Worktree-Isolation above) confines model-driven Write/Edit/
      # Bash, and the slice-end ff-merge is what lands the work on the parent
      # branch. The worktree lives under .nubos-pilot/worktrees/, so checkpoint /
      # search-evidence / metrics still resolve to the project root — only file
      # ops are confined. We do NOT force a worktree out of band: doing so would
      # bypass the merge-back gate (commits stranded) and the orchestrator's
      # cwd=worktree convention (commit-task would find nothing). The orchestrator
      # runs the canonical Step-4 loop-audit-tool-use with the returned tool-log,
      # so spawn-offhost is called --no-audit to avoid double-stamping the round.
      EXECUTOR_KIND=$(node .nubos-pilot/bin/np-tools.cjs resolve-model "$EXECUTOR_AGENT" --json 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).kind||"native")}catch{console.log("native")}})')
      if [ "$EXECUTOR_KIND" = "openai-compat" ]; then
        if [ "$WORKTREE_ISOLATION" != "true" ] || [ -z "$SLICE_CWD" ] || [ "$SLICE_CWD" = "." ]; then
          echo "[np:execute-phase] off-host executor ($EXECUTOR_AGENT) requires workflow.worktree_isolation=true so model-driven edits are confined and ff-merged back. Enable it (config-set workflow.worktree_isolation true) and re-run." >&2
          exit 1
        fi
        # Write the SAME rendered executor prompt you would have handed the Agent
        # tool (task plan + slice context + consensus + success criteria +
        # language directive + skill block) to this file:
        OFFHOST_PROMPT="${TMPDIR:-/tmp}/np-offhost-${TASK_ID}-r${ROUND}.md"
        # … render prompt to "$OFFHOST_PROMPT" …
        OFFHOST_OUT=$(node .nubos-pilot/bin/np-tools.cjs spawn-offhost \
          --agent "$EXECUTOR_AGENT" --task-file "$OFFHOST_PROMPT" \
          --task-id "$TASK_ID" --cwd "$SLICE_CWD" --allow-bash --no-audit)
        # Harvest the tool-name log for the Layer-C audit stamp (Step 4).
        EXECUTOR_TOOL_LOG=$(echo "$OFFHOST_OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify((JSON.parse(s).toolLog||[]).map(t=>t.name)))}catch{console.log("[]")}})')
      else
        # → execute group (1) per ACTION CONTRACT above (native host Agent spawn);
        # EXECUTOR_TOOL_LOG is harvested from the spawn's tool_use stream.
        true
      fi
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      node .nubos-pilot/bin/np-tools.cjs checkpoint transition "$TASK_ID" verifying

      # === Step 4: Mechanical Checks + spawn-evidence audit (orchestrator-side) ===
      # The orchestrator (NOT the agent) runs the task's <verify> command.
      # This block is executable on purpose: it used to be a comment, so
      # `VERIFY_EXIT=$?` caught the exit code of the VERIFY_LOG assignment and
      # was always 0 — verify-red never fired, the build-fixer path was dead
      # code, and loop-commit's `verify_exit_code === 0` precondition was
      # vacuously true. Do not turn any of this back into prose.
      VERIFY_LOG="${TMPDIR:-/tmp}/np-verify-${TASK_ID}-r${ROUND}.log"
      VERIFY_CMD=$(node .nubos-pilot/bin/np-tools.cjs task-verify-cmd "$TASK_ID") || exit 1
      : > "$VERIFY_LOG"
      # pass@k reliability (opt-in via loop.verify_runs, default 1): run the SAME
      # verify command $VERIFY_RUNS times and collect one exit code per run.
      # D3: re-read the toggle HERE. It is also resolved in the Initialize fence,
      # but that is a different shell process — the variable arrived unset and the
      # old `${VERIFY_RUNS:-1}` silently downgraded pass@k to pass@1. config-get
      # returns the schema default (1) for an unset key, so this is the SSOT read;
      # anything non-numeric is a config bug and must be loud, never defaulted.
      VERIFY_RUNS=$(node .nubos-pilot/bin/np-tools.cjs config-get loop.verify_runs 2>/dev/null || echo 1)
      case "$VERIFY_RUNS" in
        ''|*[!0-9]*|0)
          echo "[np:execute-phase] loop.verify_runs must be a positive integer, got: '$VERIFY_RUNS'" >&2
          exit 1 ;;
      esac
      VERIFY_CODES=""
      i=1
      while [ "$i" -le "$VERIFY_RUNS" ]; do
        # D2: `bash -c` alone reports only the LAST line's status, so a multi-line
        # verify block (TVC-1/TVC-17 support these) swallowed every earlier red
        # line: `bash -c "$(printf 'false\ntrue\n')"` exits 0. -e aborts on the
        # first failure, -o pipefail keeps a piped check (`npm test | tee`) honest.
        # The redirect (not a pipe) keeps $? the shell's own status — RC below is
        # correct as written; do not convert this into a pipeline.
        bash -eo pipefail -c "$VERIFY_CMD" >>"$VERIFY_LOG" 2>&1
        RC=$?
        VERIFY_CODES="${VERIFY_CODES:+$VERIFY_CODES,}$RC"
        i=$((i + 1))
      done
      if [ "$VERIFY_RUNS" -gt 1 ]; then
        REL=$(node .nubos-pilot/bin/np-tools.cjs verify-reliability --codes "$VERIFY_CODES")
        VERIFY_EXIT=$(echo "$REL" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).aggregate_exit_code))')
        # Append the human verdict so a FLAKY task tells the build-fixer why it is red.
        echo "$REL" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).description))' >> "$VERIFY_LOG"
      else
        VERIFY_EXIT="$VERIFY_CODES"
      fi
      # aggregate_exit_code is 0 only when EVERY run passed (pass^k); a flaky task
      # (some pass, some fail) aggregates to red and flows through the normal
      # spawn-build-fixer path below — no new critic category, no spurious stuck.
      # Stamp executor spawn-evidence into the audit log. EXECUTOR_TOOL_LOG is
      # the tool-name JSON array harvested from the spawn's tool_use stream
      # (e.g. '["Read","knowledge-search","Edit","Bash"]'). For AUDITED_AGENTS
      # this drives Rule 9 enforcement: a `knowledge-search` entry is credited
      # only when the spawn ran the CLI with --task (which writes the evidence
      # ledger) — a fabricated log entry fails as rule-9-search-tool-unverified.
      # The round number is sourced automatically from the checkpoint by
      # loop-audit-tool-use. The post-executor gate (Layer C) refuses to advance
      # unless this evidence stamp exists for the current round.
      node .nubos-pilot/bin/np-tools.cjs loop-audit-tool-use "$TASK_ID" \
        --agent "$EXECUTOR_AGENT" --tool-use-log "$EXECUTOR_TOOL_LOG"

      POST_EXEC=$(node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
        --phase post-executor \
        --verify-exit-code "$VERIFY_EXIT" --verify-output-path "$VERIFY_LOG")
      POST_EXEC_NEXT=$(echo "$POST_EXEC" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).next_action))')

      # Verify-red short-circuits to build-fixer next round (skip critics).
      if [ "$POST_EXEC_NEXT" = "spawn-build-fixer" ]; then
        ROUND=$((ROUND+1))
        continue
      fi

      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # ACTION CONTRACT — Step 5: Critic (verify-green only, one spawn)
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # SKIP-GUARD: loop-post-critics-missing-critic-audit (needs 1 critic audit).
      # NO synthetic --critic-outputs JSON without a real Agent spawn.
      #
      # Execute EXACTLY these four steps, in order:
      #
      # (1) Bash — pre-create the report path:
      #       mkdir -p "${TMPDIR:-/tmp}/nubos-pilot/critic-reports"
      #       CRITIC_REPORT_PATH="${TMPDIR:-/tmp}/nubos-pilot/critic-reports/critic-${TASK_ID}-r${ROUND}.json"
      #
      # (2) ONE Agent tool-call (real, not bash) — np-critic, sonnet by default:
      #       Agent(subagent_type="np-critic", prompt=<…>)
      #     Prompt fields:
      #       <files_to_read>
      #         - <task plan path>
      #         - <slice UAT path>
      #         - <milestone CONTEXT path>
      #         - <verify output path>
      #         - agents/np-critic-style.md
      #         - agents/np-critic-tests.md
      #         - agents/np-critic-acceptance.md
      #         - agents/np-critic-economy.md   ← ONLY when $ECONOMY_CRITIC = true (mode full/ultra)
      #           (resolved once in the init block via `economy-mode --json`; omit this line
      #            entirely when $ECONOMY_CRITIC = false — default mode lite has prevention
      #            on but the critic off). When $ECONOMY_MODE = ultra, ALSO append to the
      #            prompt: "Economy mode: ultra — lower the shrinkable bar per the Ultra
      #            section of np-critic-economy.md." Never inject the module at off/lite.
      #       <report_path>$CRITIC_REPORT_PATH</report_path>
      #     Agent MUST: Write the full findings JSON to $CRITIC_REPORT_PATH,
      #     emit ONLY the verdict-envelope as final message (~150 bytes):
      #       { critic, task_id, round, verdict, blockers_count, report_path, run_id }
      #
      # (3) Bash audit-stamp (MANDATORY, AFTER the Agent returns):
      #       node .nubos-pilot/bin/np-tools.cjs loop-audit-tool-use "$TASK_ID" \
      #         --agent np-critic --tool-use-log '[]'
      #     --tool-use-log may be '[]' (critic isn't AUDITED_AGENT for Rule 9);
      #     supplying the real tool list is preferred for np:dashboard.
      #
      # (4) Bash route (reads findings JSON from disk, NOT the envelope):
      #       node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
      #         --phase post-critics --critic-outputs-path "$CRITIC_REPORT_PATH"
      #
      # Rationale: ADR-0010 §L5 (Verdict-Only Contract, 2026-05-05) — verbose
      # findings stay on disk; ADR-0010 Trust-Layer L3 — synthetic critic JSON
      # without (3) audit-stamp is mechanically blocked.
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      mkdir -p "${TMPDIR:-/tmp}/nubos-pilot/critic-reports"
      CRITIC_REPORT_PATH="${TMPDIR:-/tmp}/nubos-pilot/critic-reports/critic-${TASK_ID}-r${ROUND}.json"
      # Off-host critic (ADR-0021): if np-critic routes to an openai-compat
      # provider, run it read-only via spawn-offhost. It CANNOT write to $TMPDIR
      # (off-host Write is cwd-confined), so it emits the findings object
      # { "critic":"critic", "findings":[…], "criteria"?:[…] } as its FINAL
      # MESSAGE; the orchestrator writes that to $CRITIC_REPORT_PATH.
      # The `critic` axis is NOT re-checked here: mergeCriticOutputs is now the
      # single fail-closed guard (critic-output-unknown-axis / -is-envelope /
      # -no-findings) and both paths share it. This block used to carry its own
      # hardcoded axis list, which drifted from SUPPORTED_CRITIC_AXES and would
      # have rejected a legitimate `economy` critic.
      CRITIC_KIND=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-critic --json 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).kind||"native")}catch{console.log("native")}})')
      if [ "$CRITIC_KIND" = "openai-compat" ]; then
        OFFHOST_CRITIC_PROMPT="${TMPDIR:-/tmp}/np-offhost-critic-${TASK_ID}-r${ROUND}.md"
        # … render the critic prompt (same files_to_read as group (2)) PLUS:
        #   "Emit ONLY the findings JSON object as your final message." …
        OFFHOST_CRITIC_OUT=$(node .nubos-pilot/bin/np-tools.cjs spawn-offhost \
          --agent np-critic --task-file "$OFFHOST_CRITIC_PROMPT" --read-only ${SLICE_CWD:+--cwd "$SLICE_CWD"})
        echo "$OFFHOST_CRITIC_OUT" | CRITIC_REPORT_PATH="$CRITIC_REPORT_PATH" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let env,f;try{env=JSON.parse(s);f=JSON.parse(env.content)}catch{console.error("off-host critic: final message is not the findings JSON object");process.exit(1)}if(!f||typeof f!=="object"){console.error("off-host critic: final message is not a JSON object");process.exit(1)}require("fs").writeFileSync(process.env.CRITIC_REPORT_PATH,JSON.stringify(f))})' || exit 1
      else
        # → execute group (2) per ACTION CONTRACT above (native Agent spawn writes $CRITIC_REPORT_PATH).
        true
      fi
      node .nubos-pilot/bin/np-tools.cjs loop-audit-tool-use "$TASK_ID" --agent np-critic --tool-use-log '[]'
      POST_CRIT=$(node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
        --phase post-critics --critic-outputs-path "$CRITIC_REPORT_PATH")
      NEXT_ACTION=$(echo "$POST_CRIT" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).next_action))')

      # D4: catch the failure at its source. When `loop-run-round --phase
      # post-critics` fails (loop-post-critics-round-shifted, critic-schwarm
      # spawn-evidence missing, -invalid-json, -empty-outputs) $POST_CRIT is
      # empty, JSON.parse throws, and $NEXT_ACTION is "". That empty string used
      # to fall clean through the dispatch below and re-enter the while-loop at an
      # UNCHANGED $ROUND — an unbounded executor+critic spawn loop (measured: 8
      # iterations, ROUND stayed 1). A routing decision we could not read is never
      # a reason to keep spawning.
      if [ -z "$NEXT_ACTION" ]; then
        echo "[np:execute-phase] $TASK_ID round $ROUND: post-critics produced no next_action — the loop-run-round call failed or emitted invalid JSON. Aborting wave without mutating task state." >&2
        echo "  raw post-critics output: ${POST_CRIT:-<empty>}" >&2
        exit 1
      fi

      case "$NEXT_ACTION" in
        commit)        break ;;
        executor)      ROUND=$((ROUND+1)); continue ;;
        researcher)    ROUND=$((ROUND+1)); continue ;;
        askuser)       # ADR-0010 Trust-Layer L3: persisted re-entry — without
                       # this stamp the next while-iteration would loop forever
                       # because the critic emits the same `question-to-user`
                       # finding. Pull the spec from POST_CRIT.routing, stamp
                       # it on the checkpoint (so /np:resume-work can recover),
                       # block on the user, then stamp the reply.
                       ASKUSER_SPEC=$(echo "$POST_CRIT" | node -e 'process.stdin.on("data",d=>{const j=JSON.parse(d); const askq=(j.routing&&j.routing.askuser)||[]; console.log(JSON.stringify(askq[0]||{}))}')
                       node .nubos-pilot/bin/np-tools.cjs loop-state-record "$TASK_ID" \
                         --json "{\"pending_askuser_spec\":$ASKUSER_SPEC,\"last_action\":\"awaiting-user\"}"
                       USER_REPLY=$(node .nubos-pilot/bin/np-tools.cjs askuser --json "$ASKUSER_SPEC")
                       node .nubos-pilot/bin/np-tools.cjs loop-state-record "$TASK_ID" \
                         --json "{\"user_reply\":$(printf %s "$USER_REPLY" | node -e 'process.stdin.on("data",d=>console.log(JSON.stringify(String(d).trim())))'),\"pending_askuser_spec\":null,\"last_action\":\"user-replied\"}"
                       # Gap #2 from the 2026-05-05 review: bump bash ROUND to
                       # match the checkpoint round (which post-critics already
                       # advanced when next_action=askuser). The Layer-C audit
                       # for the next executor re-spawn now has to be FRESH
                       # (round=N+1); the old N-stamped audit no longer
                       # satisfies the gate. Without this bump the bash counter
                       # would lag the checkpoint and maxRounds-stuck could
                       # mis-fire.
                       ROUND=$((ROUND+1))
                       continue ;;
        plan-checker)  # Locked-decision-violation or infrastructure-mismatch:
                       # the plan or the environment is wrong, the executor
                       # cannot fix it. Mirror the stuck-dialog and let the
                       # operator pick a recovery path (Gap #5 — doctrine
                       # consistency: every plan-bug class gets the user
                       # pulled into the discussion, no silent exit 2).
                       PLAN_ASK=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
                         "type": "select",
                         "header": "Plan-Bug erkannt",
                         "question": "Task '"$TASK_ID"' hat eine plan-checker-Route ausgelöst (locked-decision-violation oder infrastructure-mismatch). Der Executor kann das nicht selbst fixen — der Plan oder das Environment muss korrigiert werden. Was tun?",
                         "options": [
                           {"label": "Plan neu prüfen (plan-checker)",   "description": "Task wird als plan-bug markiert, plan-checker korrigiert PLAN.md, Task neu gestartet. Greift bei locked-decision-violation und Plan-Inkonsistenzen."},
                           {"label": "Task als stuck markieren",          "description": "Task wird als stuck in STATE.md persistiert, Wave wird abgebrochen. /np:resume-work nach manueller Klärung."},
                           {"label": "Manuell fixen, dann resumen",       "description": "Workflow pausiert hier. Du editierst Code/Plan/Dockerfile und rufst /np:execute-phase '"$PHASE"' nochmal auf (passt für infrastructure-mismatch)."}
                         ]
                       }')
                       case "$PLAN_ASK" in
                         "Plan neu prüfen"*)
                           node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
                             --phase stuck --reason "user-requested-replan" --findings-path "$CRITIC_REPORT_PATH"
                           echo "[np:execute-phase] $TASK_ID flagged for plan-checker. Run /np:plan-phase $PHASE --repromote, then re-run /np:execute-phase $PHASE." >&2
                           exit 4 ;;
                         "Task als stuck"*)
                           node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
                             --phase stuck --reason "plan-checker-user-stuck" --findings-path "$CRITIC_REPORT_PATH"
                           echo "[np:execute-phase] $TASK_ID marked stuck (user choice from plan-checker dialog)." >&2
                           exit 3 ;;
                         "Manuell fixen"*)
                           node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
                             --phase stuck --reason "manual-fix-pending" --findings-path "$CRITIC_REPORT_PATH"
                           echo "[np:execute-phase] $TASK_ID paused for manual fix. Resume via /np:execute-phase $PHASE when ready." >&2
                           exit 0 ;;
                         *)
                           # Without this, an unmatched answer fell out of the case
                           # and re-entered the while-loop at the same $ROUND —
                           # an unbounded spawn loop. Never guess the intent.
                           echo "[np:execute-phase] unrecognised plan-checker dialog answer: '$PLAN_ASK' — aborting wave without mutating task state." >&2
                           exit 1 ;;
                       esac ;;
        stuck)         # Hitting maxRounds = "this task may be mis-planned, discuss".
                       # Don't exit — askuser, give the operator four concrete options
                       # to recover. The operator-facing options match the failure modes
                       # we've actually seen in production.
                       STUCK_ASK=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
                         "type": "select",
                         "header": "Task stuck",
                         "question": "Task '"$TASK_ID"' hat '"$LOOP_MAX_ROUNDS"' Runden im Critic-Loop ohne convergence durchlaufen. Wahrscheinlich ist der Plan falsch oder unvollständig. Was tun?",
                         "options": [
                           {"label": "Weitermachen (+5 Runden)",       "description": "Loop-Cap wird um 5 erhöht, Critic bekommt nochmal 5 Chancen. Sinnvoll wenn der Critic sichtbaren Progress macht."},
                           {"label": "Task neu planen (plan-checker)", "description": "Task wird als plan-bug markiert, plan-checker wird aufgerufen, PLAN.md wird korrigiert, Task neu gestartet."},
                           {"label": "Task als stuck markieren",        "description": "Task wird als stuck in STATE.md persistiert, Wave wird abgebrochen. /np:resume-work nach manueller Klärung."},
                           {"label": "Manuell fixen, dann resumen",    "description": "Workflow pausiert hier. Du editierst Code/Plan und rufst /np:execute-phase '"$PHASE"' nochmal auf."}
                         ]
                       }')
                       case "$STUCK_ASK" in
                         "Weitermachen"*)
                           LOOP_MAX_ROUNDS=$((LOOP_MAX_ROUNDS + 5))
                           # T3: persist override on the checkpoint so post-critics
                           # honors it AND /np:resume-work survives a crash with the
                           # extended cap. Bash-only mutation is lost on resume.
                           node .nubos-pilot/bin/np-tools.cjs loop-state-record "$TASK_ID" \
                             --json "{\"max_rounds_override\":$LOOP_MAX_ROUNDS}"
                           echo "[np:execute-phase] $TASK_ID Loop-Cap auf $LOOP_MAX_ROUNDS erweitert per askuser (persistiert)." >&2
                           continue ;;
                         "Task neu planen"*)
                           node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
                             --phase stuck --reason "user-requested-replan" --findings-path "$CRITIC_REPORT_PATH"
                           echo "[np:execute-phase] $TASK_ID flagged for plan-checker. Run /np:plan-phase $PHASE --repromote, then re-run /np:execute-phase $PHASE." >&2
                           exit 4 ;;
                         "Task als stuck"*)
                           node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
                             --phase stuck --reason "max-rounds-user-stuck" --findings-path "$CRITIC_REPORT_PATH"
                           echo "[np:execute-phase] $TASK_ID marked stuck after $LOOP_MAX_ROUNDS rounds (user choice)." >&2
                           exit 3 ;;
                         "Manuell fixen"*)
                           node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
                             --phase stuck --reason "manual-fix-pending" --findings-path "$CRITIC_REPORT_PATH"
                           echo "[np:execute-phase] $TASK_ID paused for manual fix. Resume via /np:execute-phase $PHASE when ready." >&2
                           exit 0 ;;
                         *)
                           # See the plan-checker default above: a fall-through here
                           # re-entered the while-loop at the same $ROUND forever.
                           echo "[np:execute-phase] unrecognised stuck-dialog answer: '$STUCK_ASK' — aborting wave without mutating task state." >&2
                           exit 1 ;;
                       esac ;;
        *)             # D4: the arm this dispatch never had. The two `*)` arms
                       # above guard the INNER askuser dialogs only — the OUTER
                       # case fell through `esac` for any value it could not
                       # route, straight back into the while-loop at the same
                       # $ROUND. Every unroutable next_action is a bug in
                       # loop-run-round or a new route nobody wired here; both
                       # are loud failures, never "spawn again and hope".
                       echo "[np:execute-phase] $TASK_ID round $ROUND: unroutable next_action '$NEXT_ACTION' from post-critics — no dispatch arm handles it. Aborting wave without mutating task state." >&2
                       exit 1 ;;
      esac
    done

    # Defensive: if the while loop exited without NEXT_ACTION=commit (shouldn't
    # happen — loop-evaluate emits stuck at maxRounds), stamp stuck and bail.
    if [ "$NEXT_ACTION" != "commit" ]; then
      node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
        --phase stuck --reason "loop-exited-without-commit"
      exit 3
    fi

    # === Step 7: atomic commit ===
    # --cwd targets the slice worktree. Without it commitTask inherited the
    # orchestrator's process.cwd(), so with worktree_isolation=true the edits
    # lived in the worktree while the commit landed on the calling branch; the
    # ff-merge below then found an ancestor ("Already up to date") and the
    # worktree was removed — isolation silently never happened.
    node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" --phase commit \
      --learning-pattern "$CONSENSUS_PATTERN" --learning-outcome verified
    COMMIT_OUT=$(node .nubos-pilot/bin/np-tools.cjs commit-task "$TASK_ID" ${SLICE_CWD:+--cwd "$SLICE_CWD"})
    COMMIT_STATUS=$?
    printf '%s' "$COMMIT_OUT"
    case "$COMMIT_OUT" in *'"committed":true'*) SLICE_COMMITTED_ANY=true ;; esac

    EXECUTOR_END=$(node .nubos-pilot/bin/np-tools.cjs metrics end-timestamp)
    EXECUTOR_STATUS=ok
    [ "$COMMIT_STATUS" -ne 0 ] && EXECUTOR_STATUS=error
    node .nubos-pilot/bin/np-tools.cjs metrics record \
      --agent "$EXECUTOR_AGENT" --tier sonnet --resolved-model "$EXECUTOR_MODEL" \
      --phase "$PHASE" --plan "$SLICE_FULL_ID" --task "$TASK_ID" \
      --started "$EXECUTOR_START" --ended "$EXECUTOR_END" \
      --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
      --retry-count "$((ROUND-1))" --status "$EXECUTOR_STATUS" --runtime "$RUNTIME"

    if [ "$COMMIT_STATUS" -ne 0 ]; then
      echo "[np:execute-phase] commit-task failed for $TASK_ID — aborting wave $SLICE_FULL_ID." >&2
      if [ "$WORKTREE_ISOLATION" = "true" ]; then
        echo "  Worktree $SLICE_CWD left in place for inspection. Clean up with: /np:reset-slice $TASK_ID" >&2
      fi
      exit "$COMMIT_STATUS"
    fi
  done
  # Wait for all parallel Nubosloop instances in this wave to finish before next wave.

  # After every task in the slice committed: aggregate per-task summaries into
  # the slice-level S<NNN>-SUMMARY.md so /np:validate-phase can audit it.
  SLICE_NUM=$(echo "$WAVE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).wave))")
  node .nubos-pilot/bin/np-tools.cjs init execute-milestone finalize-slice "$PHASE" "$SLICE_NUM" >/dev/null

  # Worktree merge-back (ADR-0008 D-8.7): fast-forward-only merge the slice
  # branch back onto the invoking workspace's current branch. Non-FF (e.g.
  # because the base branch advanced during execution) fails hard — that
  # surfaces the drift to the user rather than silently rewriting task SHAs.
  if [ "$WORKTREE_ISOLATION" = "true" ]; then
    FF_ALLOW_EMPTY=""
    [ "$SLICE_COMMITTED_ANY" = "true" ] || FF_ALLOW_EMPTY="--allow-empty"
    FF_RESULT=$(node .nubos-pilot/bin/np-tools.cjs worktree-ff-merge "$SLICE_FULL_ID" $FF_ALLOW_EMPTY 2>&1)
    FF_STATUS=$?
    if [ "$FF_STATUS" -ne 0 ]; then
      echo "[np:execute-phase] ff-merge for $SLICE_FULL_ID failed — worktree left in place for inspection:" >&2
      echo "  $FF_RESULT" >&2
      echo "  To resolve: cd into $SLICE_CWD, rebase onto current base, then re-run this workflow." >&2
      exit "$FF_STATUS"
    fi
    node .nubos-pilot/bin/np-tools.cjs worktree-remove "$SLICE_FULL_ID" >/dev/null
    echo "[np:execute-phase] worktree $SLICE_FULL_ID merged + removed." >&2
  fi
done

# Milestone done — regenerate every slice summary so retroactive / resumed
# runs also end with a complete audit surface.
node .nubos-pilot/bin/np-tools.cjs init execute-milestone finalize-milestone "$PHASE" >/dev/null
```

## Auto-Chain — verify-work (opt-in via `--verify-work`)

When `auto_verify == true` (set by `--verify-work` at invocation), this workflow chains into `/np:verify-work $PHASE` as soon as `finalize-milestone` returns. The chain is unconditional on success — same hard-fail contract as a manual `/np:verify-work` call (exit 1 on any `Fail` SC). Without the flag the workflow stops here and the operator runs verify-work manually.

```bash
if [[ "$AUTO_VERIFY" == "true" ]]; then
  echo "[np:execute-phase] --verify-work set — chaining into /np:verify-work $PHASE." >&2
  /np:verify-work "$PHASE"
else
  echo "[np:execute-phase] done. Next: /np:verify-work $PHASE (or pass --verify-work next time to auto-chain)." >&2
fi
```

The chain runs AFTER `finalize-milestone` — verify-work needs every slice's `S<NNN>-SUMMARY.md` aggregated, plus every task commit landed. Running verify earlier would race the audit surface.

After verify-work returns, point the operator at `/np:validate-phase $PHASE` to run the UAT per slice (validate is intentionally NOT auto-chained — it has its own runtime cost and asks for a separate decision point).

## Scope Guardrail

<!-- scope_guardrail -->
**Do:**
- Dispatch all tasks in a slice **in parallel** — one Nubosloop instance per task.
- Move to next slice **only after** every task in the current slice committed (or `stuck`/`plan-checker` aborted the wave).
- Start one checkpoint per task before kicking off the loop.
- Run `loop-run-round --phase preflight` BEFORE every Round-1 executor spawn — never skip the cache lookup.
- Spawn `agents/np-executor.md` on Round 1, `agents/np-build-fixer.md` on Round ≥ 2 — once per round, with only that task's `files_modified` in scope (D-04, no scope expansion).
- Spawn the single Critic agent (`np-critic`) once per round, after a verify-green post-executor. It writes the full findings JSON to `$CRITIC_REPORT_PATH` and emits a small verdict envelope as its final message (ADR-0010 §L5 Verdict-Only Contract).
- Pre-create `${TMPDIR:-/tmp}/nubos-pilot/critic-reports/` before the critic spawn so the agent's `Write` cannot fail on a missing parent directory.
- Pass `--critic-outputs-path "$CRITIC_REPORT_PATH"` to `loop-run-round --phase post-critics` so the full findings JSON is read from disk rather than replayed through the spawn's final message.
- Run `loop-run-round --phase post-executor` AFTER mechanical checks; honor `next_action: spawn-build-fixer` (verify-red short-circuit, skip critics this round).
- Run `loop-run-round --phase post-critics` AFTER critics return, to obtain the routing `next_action`.
- Run `loop-audit-tool-use` per round per spawn — for executor/build-fixer this drives Rule 9 enforcement, AND for `np-critic` this is the spawn-evidence required by the Layer-C audit-trail gate (`loop-post-executor-missing-spawn-audit` / `loop-post-critics-missing-critic-audit`). After the Single-Critic Revision (ADR-0010, 2026-05-05) the per-round audit count is **two** in rounds ≥ 2 (`np-build-fixer` + `np-critic`) and **`swarm.research.k` + 2** in round 1 (k × `np-researcher` + `np-executor` + `np-critic`). All audits in the active round are mandatory before the corresponding `loop-run-round --phase post-{researcher|executor|critics}` invocation.
- Route every commit through `node .nubos-pilot/bin/np-tools.cjs commit-task` so `classifyCommittablePaths` runs (gitignored entries are split into a `files_ignored` audit list; mixed paths commit only the tracked subset; all-ignored soft-skips with `skip_reason: artifacts-gitignored` and exit 0).
- Hard-stop the wave when `commit-task` returns non-zero, OR a task hits `stuck`/`plan-checker`. **Soft-skip is exit 0 — wave continues.**

**Don't:**
- Build `TASK_IDS` from `waves[].tasks` — that list includes finished tasks. Use `dispatchable_task_ids`, and skip a wave whose `complete` is `true`. Re-running a `done` task burns a full Nubosloop for nothing; `init … execute-task` refuses it with `execute-milestone-task-not-dispatchable`, and `--allow-redo` is for a deliberate re-run only.
- Hand-edit milestone or slice `status` in `roadmap.yaml`. Init lifts the milestone `pending → in-progress`, and the rollup keeps slice status derived from the task states on every transition. A milestone whose slices are all `done` stays `in-progress` on purpose — only `/np:verify-work` may set a terminal status, because terminal means verification ran. If the persisted status looks wrong, run `np-tools rollup <N>`; never patch the YAML.
- Run tasks across slices in parallel — slices are serial.
- Run intra-slice tasks serially — they're parallel by planner contract.
- Skip the Nubosloop and call `commit-task` directly after the executor (single-pass executor → commit is forbidden — ADR-0010).
- Spawn the Critic agent BEFORE the post-executor verify-green check — verify must pass first; the critic only runs on verify-green.
- Use `np-executor` on Round ≥ 2 — use `np-build-fixer` (it gets prior critic findings + verify output excerpt).
- Skip `loop-audit-tool-use` for ANY spawn (researcher / executor / build-fixer / `np-critic`). Skipping the executor audit silences Rule 9; skipping the critic audit means the orchestrator cannot prove the critic actually ran, and the post-critics gate refuses. Synthesizing `--critic-outputs` JSON without spawning the real `np-critic` agent is the canonical bypass — Layer C blocks it mechanically.
- Bypass the Verdict-Only Contract by inlining the full findings JSON in the spawn's final message or by reconstructing `$CRITIC_REPORT_PATH` content from the envelope. Both defeat the cost-control purpose of ADR-0010 §L5; the critic is required to `Write` the findings file itself, and the orchestrator is required to read that file via `--critic-outputs-path` rather than the envelope.
- Extend a task's scope beyond `files_modified` — D-04 violations route to `plan-checker`, not post-hoc PLAN.md mutations.
- Invoke `git commit`, `git add`, or any bare git command from this workflow or the spawned agent (CLAUDE.md §Git operations).
- Bundle two tasks into one commit (ADR-0004 atomicity).
- Skip the checkpoint start step — it's the crash-safety primitive `resume-work` depends on.
- Pass `--no-verify` or `--force` anywhere in the pipeline.
- **Introduce ad-hoc pre-flight checks beyond the two sanctioned guards** (orphan-checkpoint, empty-milestone). Container-status (`docker ps`), runtime-version probes (`php -v`, `node -v`), DB-connectivity, port-binding — none of these belong in the orchestrator's pre-flight. Tasks edit code; environment failures surface inside the Nubosloop as `verify-red` (→ `spawn-build-fixer`) or as `np-critic-acceptance` `information-missing` findings (→ researcher / plan-checker). They are **never** workflow-level halts.
- **Declare a "hard blocker" because of infrastructure state.** Container down, PHP version skew, missing image, exited service — all of these are routing signals inside the loop, not reasons to abort the wave. The wave only halts on `commit-task` non-zero, `stuck` after `loop.maxRounds`, or `plan-checker` (locked-decision-violation). Infrastructure mismatch routes via critic findings to researcher/plan-checker; if it's truly out-of-scope for any task in the milestone, the operator handles it separately and re-runs the workflow.
<!-- /scope_guardrail -->

## Output

- One git commit per completed task (`task(<milestone-id>-<slice-id>-T<NNNN>): <name>`).
- Per-task checkpoint lifetime: `start` → (`transition verifying`)+ → `pre-commit` (set by `loop-run-round --phase commit`) → `deleteCheckpoint` (inside commit-task on success).
- Per-task `nubosloop` state block on the checkpoint envelope: `last_phase`, `last_action`, `round`, `findings`, `committed_at` / `stuck_at` — surfaced on `np:dashboard`.
- Auto-`learning-log` entry per committed task (when `auto_log_learning=true`, default) — feeds future Round-1 cache hits.
- STATE.md updated via `startTask`'s coordinated lock-cycle (D-08).
- Per slice: updated `S<NNN>-SUMMARY.md` aggregated from task summaries (triggered after the last task in the wave).
- `roadmap.yaml` status kept in sync by the rollup: the milestone leaves `pending` at init (report `milestone_status_started` to the user when non-null), and each slice tracks its tasks. When every slice reaches `done` the milestone stays `in-progress` — report that verification is the remaining step, not that the milestone is finished.
- Verified work surface for `/np:validate-phase $PHASE`.

## Definition of Done

This workflow exits successfully only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 1 (Do the whole thing) — every task in every slice ran its Nubosloop to `next_action=commit` and committed; no partial slices, no `stuck` left silent.
- Rule 3 (Do it with tests) — every commit ships verify-green; mechanical checks per round are a hard gate; `commit-task` refuses commits without a `verifying` → `pre-commit` transition.
- Rule 4 (Do it with documentation) — `update-docs` ran for every committed task; stale module docs surface as a `np-critic-acceptance` finding and route the loop back, not forward.
- Rule 9 (Tool-use audit) — `loop-audit-tool-use` confirms every audited spawn invoked a knowledge-search tool ≥ 1× — canonically the `knowledge-search` CLI (`node np-tools.cjs knowledge-search "<q>" --task <id> --agent <name>`, run via Bash); the accepted set is the `SEARCH_TOOLS` constant in `lib/nubosloop.cjs`. Evidence is credited **per agent** — a search recorded without `--agent`, or by a different agent in the same round, does not satisfy this spawn. Violations — including a `knowledge-search` claim with no matching evidence ledger — route as `rule-9-violation` findings into `loop-evaluate`.
- Rule 10 (Test before shipping) — verify-green is a hard gate per round, not advice.
- Rule 12 (Boil the ocean) — no task left in `stuck` state; the orchestrator escalates via askuser rather than silently downgrading or retrying past `loop.maxRounds`.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
