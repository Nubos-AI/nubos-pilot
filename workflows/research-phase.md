---
command: np:research-phase
description: Milestone-level technical research — spawn the researcher subagent, produce M<NNN>-RESEARCH.md, fall back to local-only sources when WebFetch + Context7 are both unavailable.
argument-hint: <milestone-number>
---

# np:research-phase

Milestone-level technical research. Spawns the `researcher` subagent (`agents/np-researcher.md`, tier=sonnet) with milestone context and produces `{milestone_dir}/{milestone_id}-RESEARCH.md`.

Standalone research command. For most workflows, use `/np:plan-phase` which
integrates research automatically. This command is the audit-friendly entry
point: it runs research **in isolation** and commits its artifact before
planning starts.

## Philosophy

<philosophy>
Research is investigation, not confirmation. The researcher's job is to
surface what the ecosystem actually uses — not to rationalise a library
choice the planner already made. Every claim in RESEARCH.md carries a
confidence tag (`[VERIFIED]`, `[CITED: url]`, `[ASSUMED]`); the planner and
plan-checker weight downstream decisions accordingly. An incomplete
RESEARCH.md with honest scope-markers beats a complete one with unverified
claims (see Phase-5 D-22 — the `## Research Coverage` section is the
mechanism that lets the planner discount library-version claims made
without WebFetch / Context7).
</philosophy>

## Scope Guardrail

<scope_guardrail>
This workflow ONLY writes `{milestone_dir}/{milestone_id}-RESEARCH.md`. It NEVER:

- edits `roadmap.yaml` or `.nubos-pilot/ROADMAP.md`
- touches STATE.md
- mutates another phase's directory
- re-runs discuss-phase or plan-phase on the user's behalf

When the researcher returns a `## CHECKPOINT REACHED` block, the workflow
surfaces it and exits — it does NOT attempt to resume mid-research
automatically. Resumption is a Phase 6 executor concern.
</scope_guardrail>

## Downstream Awareness

<downstream_awareness>
`{milestone_dir}/{milestone_id}-RESEARCH.md` is consumed by the planner
(`agents/np-planner.md`) and then by plan-checker — both receive the path in the
`<files_to_read>` block that `/np:plan-phase` builds from
`init plan-milestone init`'s `milestone_research_path` + `has_research`. That
plumbing is what makes this artefact worth producing: an agent reads what its
prompt names, so a RESEARCH.md that is not in the block is spend with no effect
(ADR-0032). The planner turns
"Standard Stack" entries into literal task actions ("Install `jose@6.0.10`")
and "Common Pitfalls" into verification steps. If the offline path was
taken, plan-checker grep-matches `## Research Coverage` and emits a
`missing-coverage-annotation` finding when the section is absent — that is
why Step 4 below validates the section presence after spawn.
</downstream_awareness>

## Answer Validation

<answer_validation>
Before exiting, confirm:

1. `{milestone_dir}/{milestone_id}-RESEARCH.md` exists and is non-empty.
2. If `MODE == offline`, the file contains a literal `## Research Coverage`
   heading (D-22).
3. If the user declined the offline-confirm prompt, RESEARCH.md was NOT
   written (D-23) and the abort message surfaced verbatim.

All confirmations route through `node .nubos-pilot/bin/np-tools.cjs askuser --json '{...}'`.
Never a bare prompt-tool invocation — Phase-3 D-03 rename rule
enforced by `bin/check-workflows.cjs` (the guard rejects any line that
mentions the forbidden Claude-Code prompt-tool identifier outside a
`np-tools.cjs` wrapper).
</answer_validation>

## Step 0: Parse Phase Argument

The phase number is the positional argument to `/np:research-phase <N>`.

```bash
PHASE="$1"
if [[ -z "$PHASE" ]]; then
  echo "Usage: /np:research-phase <phase-number>" >&2
  exit 2
fi
```

## Step 1: Single-Call Init

All phase context is gathered in one call to
`node .nubos-pilot/bin/np-tools.cjs init research-phase <N>`. The subcommand returns a JSON
payload; larger payloads are written to a tmp file and referenced via
`@file:<path>`.

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT=$(node .nubos-pilot/bin/np-tools.cjs init research-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
RUNTIME=$(node .nubos-pilot/bin/np-tools.cjs detect-runtime)
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative. Obey it for user-facing output and
askuser prompts, and pass it into the np-researcher spawn prompt so
RESEARCH.md prose (not URLs, citations, or code snippets) follows the
project language. This supersedes CLAUDE.md.

`RUNTIME` is resolved once here and reused by the metrics-record call at the
researcher spawn site (Step 4) per D-06 workflow-writer pattern.

**Askuser routing.** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below is a spec, not a literal command. Pick the path once at Initialize:
- **Claude Code** (native `AskUserQuestion` tool is available): parse the JSON spec and call `AskUserQuestion` directly. `select` → `multiSelect: false`; `multiselect` → `multiSelect: true`; `confirm` → `options: [{label: "Yes"}, {label: "No"}]`; `input` → ask free-form in chat. Use a short `header` (≤12 chars).
- **`text_mode == true`** (INIT payload): skip every askuser block and render questions as plain-text numbered lists. Opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.
- **Other runtime with TTY** (Codex, Gemini, …): execute the shell `askuser` block verbatim.

The payload shape:

```json
{
  "_workflow": "research-phase",
  "phase": 5,
  "milestone": 5,
  "milestone_id": "M005",
  "milestone_dir": "/abs/.nubos-pilot/milestones/M005",
  "milestone_research_path": "/abs/.nubos-pilot/milestones/M005/M005-RESEARCH.md",
  "goal": "…",
  "requirements": ["PLAN-03", "…"],
  "has_research": false,
  "tools_available": {
    "WebFetch": true,
    "Context7": false
  },
  "agent_skills": { "np-researcher": ["…"] }
}
```

Extract fields:

```bash
MILESTONE_ID=$(echo "$INIT" | jq -r '.milestone_id')
MILESTONE_DIR=$(echo "$INIT" | jq -r '.milestone_dir')
HAS_RESEARCH=$(echo "$INIT" | jq -r '.has_research')
WEBFETCH_AVAILABLE=$(echo "$INIT" | jq -r '.tools_available.WebFetch')
CONTEXT7_AVAILABLE=$(echo "$INIT" | jq -r '.tools_available.Context7')
CONTEXT_PATH="$MILESTONE_DIR/$MILESTONE_ID-CONTEXT.md"
RESEARCH_PATH=$(echo "$INIT" | jq -r '.milestone_research_path')
PLAN_ID="${MILESTONE_ID}-research"
TASK_ID="${MILESTONE_ID}-researcher"
```

`PLAN_ID` / `TASK_ID` default to stable tokens for the metrics record at the
researcher spawn site (D-08 schema requires both fields; phase-level research
has no per-plan/per-task identity so the defaults act as phase-scoped labels).

## Step 2: Guard against Overwrite

When `has_research` is already `true`, ask the user how to proceed rather
than silently clobbering the existing file.

```bash
if [[ "$HAS_RESEARCH" == "true" ]]; then
  node .nubos-pilot/bin/np-tools.cjs askuser --json '{
    "type": "select",
    "question": "RESEARCH.md already exists for this phase. How do you want to proceed?",
    "options": ["Overwrite", "Append-update", "Abort"]
  }'
fi
```

On `Abort` the workflow exits 0 without touching anything. On
`Append-update` the researcher is spawned with `mode=append`; on
`Overwrite` with `mode=overwrite`.

## Step 3: Offline Fallback (D-21)

When both `WebFetch` and `Context7` report unavailable (both `false` in the
init payload), the researcher cannot verify library versions or fetch
external docs. Route the verbatim D-21 German confirm prompt through
`askUser`:

```bash
MODE=online
if [[ "$WEBFETCH_AVAILABLE" == "false" && "$CONTEXT7_AVAILABLE" == "false" ]]; then
  CONFIRM=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"confirm","question":"Kein Web-/Context7-Zugriff verfügbar — mit lokalen Quellen (Repo + Prior-Phase-CONTEXT.md) fortfahren?"}')
  if ! [[ "$CONFIRM" =~ ^([Yy]([Ee][Ss])?|[Jj][Aa]?|[Tt]rue|1)$ ]]; then
    echo "Research aborted. Run \`np:plan-phase $PHASE --skip-research\` to proceed without research."
    exit 0
  fi
  MODE=offline
fi
```

The German prompt text is **verbatim** from `agents/np-researcher.md` (Plan
05-03, D-21). The abort message on decline is **verbatim** from D-23. Do
not rephrase either string — downstream greps and plan-checker rules match
on exact content.

## Step 3.5: Researcher-Schwarm + Cache-Bypass (ADR-0011)

This workflow runs in **Schwarm mode** by default. The `init` payload (Step 1) carries a `swarm` block populated by `lib/researcher-swarm.cjs`:

- `swarm.k` — number of parallel researchers to spawn (default `3`, configurable via `swarm.research.k` in `.nubos-pilot/config.json`).
- `swarm.threshold` — Jaccard similarity threshold for the cache-lookup (default `0.9`).
- `swarm.min_occurrence` — minimum learning occurrence to count as a hit (default `3`).
- `swarm.spawn_specs[]` — per-spawn `{ index, seed_delta }` for deterministic prompt nudges that prevent group-think.
- `swarm.cache_hit` — populated when `lib/knowledge-adapter.cjs::match` returned a hit at threshold + minOccurrence.
- `swarm.bypass_swarm` — `true` when `cache_hit` is non-null. Skip the Researcher-Schwarm entirely.

**Behaviour:**

```bash
BYPASS=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).swarm.bypass_swarm))")
SWARM_K=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).swarm.k))")
```

- **`$BYPASS == "true"`** — skip Step 4 entirely. Render `RESEARCH.md` from `swarm.cache_hit.pattern` + `swarm.cache_hit.outcome` with provenance `[CACHED]` and a `<consensus_meta>` block citing the adapter (`local`), the fingerprint, and the occurrence count. Token cost ≈ 0.
- **`$BYPASS == "false"`** — Step 4 spawns `$SWARM_K` parallel `np-researcher` agents (one per `swarm.spawn_specs[]` entry, each carrying its `seed_delta` field). The orchestrator collects all `$SWARM_K` outputs, parses each into the structured shape (decisions, risks, patterns, open_questions, sources), and feeds them to `lib/researcher-swarm.cjs::mergeConsensus` for deterministic Mehrheit / Union / Schnittmenge merge.

The merged consensus is rendered to `RESEARCH.md` via `lib/researcher-swarm.cjs::renderConsensusToMarkdown` with a `<consensus_meta>` block listing `k`, `agreement_score`, and `flagged_decisions` for plan-checker audit.

## Step 4: Spawn the Researcher Swarm (parallel, schema-bound)

When `$BYPASS == "true"`, this step is skipped — the cache hit is rendered directly into `RESEARCH.md`.

Otherwise, prepare the per-spawn output paths and the output schema:

```bash
RESEARCH_DIR="${MILESTONE_DIR}/research"
mkdir -p "$RESEARCH_DIR"
SPAWN_SCHEMA=$(node .nubos-pilot/bin/np-tools.cjs output-lint prompt --schema researcher-output)
```

`$SPAWN_SCHEMA` is the binding contract for every spawn — passed verbatim as a `<schema_prompt>` section in each spawn's input. Drift in any spawn's output shape breaks the workflow at Step 4.5 (post-spawn lint), not at merge time.

The orchestrator spawns `$SWARM_K` parallel researchers in a single message (multiple Agent tool-use blocks per spawn-spec). Each spawn receives:

- The standard `<files_to_read>` block (M<NNN>-CONTEXT.md, REQUIREMENTS.md, codebase docs).
- The milestone goal + requirements.
- A single `<seed_delta>` line from `swarm.spawn_specs[i].seed_delta`. No researcher knows the others exist.
- `<schema_prompt>` = `$SPAWN_SCHEMA` — the `researcher-output` contract.
- `<output_path>` = `$RESEARCH_DIR/spawn-<i>.md` — the spawn's exclusive write target. **Spawns do not write to `$RESEARCH_PATH`** (the milestone-level RESEARCH.md); that file is produced by the reconciler (Step 5.5).

The spawn call is intentionally abstract — no runtime-specific syntax. The
Phase 8 runtime adapters (`claude-code`, `codex`, `gemini`, `opencode`)
bind the string `Spawn agent=np-researcher …` to whichever mechanism that
runtime supports (`Task(…)` for Claude Code, shell subprocess for Codex,
etc.). Keeping this abstract here means the workflow stays runtime-neutral.

Before spawning, resolve the researcher model via `np-tools.cjs resolve-model`
and capture the start timestamp for the metrics record (D-06 workflow-writer
pattern). An empty `$RESEARCHER_MODEL` string signals the runtime adapter to
omit the `model:` parameter at spawn (Phase 8 D-22 inherit-pattern).

```bash
RESEARCHER_START=$(node .nubos-pilot/bin/np-tools.cjs metrics start-timestamp)
RESEARCHER_MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-researcher --profile balanced)
RESEARCHER_KIND=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-researcher --kind 2>/dev/null || echo native)
```

**Off-host (ADR-0021):** when `np-researcher` routes to an `openai-compat` provider, run the `$SWARM_K` spawns via `spawn-offhost` instead of the abstract host spawn. Two specifics for this audited agent:

- **Synthetic canonical task-id.** `np-researcher` is Rule-9-audited and `dispatchOffHost` requires a `M<NNN>-S<NNN>-T<NNNN>` id for the search-evidence ledger + audit. Research is milestone-level (no real slice/task), so mint the synthetic id `${MILESTONE_ID}-S000-T0000` (the `S000-T0000` suffix is the documented "milestone-level, no slice/task" convention). The injected native `knowledge-search` tool satisfies Rule 9; the orchestrator stamps one `loop-audit-tool-use` per spawn.
- **Offline only.** The off-host toolset has **no `WebFetch`/`context7`** — an off-host researcher can only do `$MODE == offline` (knowledge-search) research. If `$MODE == online`, keep `np-researcher` native (or accept offline-only research for that spawn). This is a capability bound, surfaced loudly, not a silent degrade.

Each spawn writes its own `$RESEARCH_DIR/spawn-<i>.md` (inside the repo cwd), so it runs write-enabled (NOT `--read-only`), no `--allow-bash`, no worktree.

```bash
if [ "$RESEARCHER_KIND" = "openai-compat" ]; then
  OFFHOST_TASK_ID="${MILESTONE_ID}-S000-T0000"
  i=0
  while [ "$i" -lt "${SWARM_K:-3}" ]; do
    R_PROMPT="${TMPDIR:-/tmp}/np-offhost-researcher-${MILESTONE_ID}-${i}.md"
    # … render spawn-spec i (files_to_read + goal + requirements + seed_delta[i] +
    #   $SPAWN_SCHEMA + the EXACT output path $RESEARCH_DIR/spawn-${i}.md) PLUS
    #   $LANG_DIRECTIVE into "$R_PROMPT" …
    R_OUT=$(node .nubos-pilot/bin/np-tools.cjs spawn-offhost \
      --agent np-researcher --task-file "$R_PROMPT" --task-id "$OFFHOST_TASK_ID" --no-audit)
    R_LOG=$(echo "$R_OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify((JSON.parse(s).toolLog||[]).map(t=>t.name)))}catch{console.log("[]")}})')
    node .nubos-pilot/bin/np-tools.cjs loop-audit-tool-use "$OFFHOST_TASK_ID" --agent np-researcher --tool-use-log "$R_LOG"
    i=$((i+1))
  done
fi
```

When `$RESEARCHER_KIND = native`, use the abstract host spawn below (the Phase 8 runtime adapter binds it):

```text
Spawn agent=np-researcher tier=sonnet model=$RESEARCHER_MODEL mode=$MODE phase=$PHASE context=$CONTEXT_PATH output=$RESEARCH_PATH
```

After the spawn returns, close the metrics record with the 15-field D-08
schema. Token counts default to `0` when the host runtime does not surface
`Task()` usage to the workflow (non-Claude runtimes, or Claude without
usage-capture — Phase 10 will enrich this via runtime-adapter support per
RESEARCH §A5).

```bash
RESEARCHER_END=$(node .nubos-pilot/bin/np-tools.cjs metrics end-timestamp)
node .nubos-pilot/bin/np-tools.cjs metrics record \
  --agent np-researcher --tier sonnet --resolved-model "$RESEARCHER_MODEL" \
  --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
  --started "$RESEARCHER_START" --ended "$RESEARCHER_END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count "${RETRY_COUNT:-0}" --status "${STATUS:-ok}" --runtime "$RUNTIME"
```

The researcher reads:

- `$CONTEXT_PATH` (user decisions from `/np:discuss-phase`) when present
- the requirements + goal embedded in `$INIT`
- prior-phase `*-CONTEXT.md` files (for offline dependency signals)

Each spawn writes exactly one file: `$RESEARCH_DIR/spawn-<i>.md`. It may invoke
`WebFetch` / `mcp__context7__*` when `$MODE == online`, or fall back to
`Read` / `Grep` / `Glob` only when `$MODE == offline`.

## Step 4.5: Per-Spawn Output Lint — HARD-GATE between Step 4 and Step 5

> **This is NOT an optional post-check.** Step 5 (Deterministic Merge) MUST NOT run until every spawn passes lint. The script below `exit 1`s on any violation; the workflow is over at that point.

After ALL `$SWARM_K` Writes complete, lint each `spawn-<i>.md` against the `researcher-output` schema (ADR-0017 + ADR-0018). Any violation — missing frontmatter, missing section, missing `**Reasoning:**` field per entry, `[object Object]` titles — aborts the workflow with exit 1 and the orchestrator re-spawns `np-researcher` with the violation list as feedback (do NOT hand-edit the spawn output):

```bash
for i in $(seq 0 $((SWARM_K - 1))); do
  SPAWN_PATH="$RESEARCH_DIR/spawn-$i.md"
  if [[ ! -f "$SPAWN_PATH" ]]; then
    echo "[np:research-phase] missing spawn output $SPAWN_PATH — researcher $i did not write." >&2
    exit 1
  fi
  node .nubos-pilot/bin/np-tools.cjs output-lint check \
    --file "$SPAWN_PATH" \
    --schema researcher-output \
    --enforce \
    --text
  LINT_RC=$?
  if [[ "$LINT_RC" -ne 0 ]]; then
    echo "[np:research-phase] spawn-$i violates researcher-output schema — re-spawn np-researcher with the violation list as feedback. Do NOT hand-edit." >&2
    exit 1
  fi
done
```

This gate is the reason same-shape merging works downstream. Without it, mergeConsensus would silently bucket different formats into different keys (the historical "intersection ≈ 0" failure mode).

## Step 5: Deterministic Merge

Run `lib/researcher-swarm.cjs::mergeConsensus` over the parsed per-spawn outputs. The CLI helper does the parse + merge in one call and writes the deterministic proposal to `$RESEARCH_DIR/merge.md`:

```bash
PREPARE_PAYLOAD=$(node .nubos-pilot/bin/np-tools.cjs researcher-reconcile prepare "$PHASE")
if [[ "$PREPARE_PAYLOAD" == @file:* ]]; then PREPARE_PAYLOAD=$(cat "${PREPARE_PAYLOAD#@file:}"); fi
# Payload exposes: merged (final_decisions, contested, agreement.decisions, …), spawn_paths, merge_path, final_path, thresholds.
```

The `$PREPARE_PAYLOAD` JSON is the structured input the reconciler agent receives in Step 5.5. Its `merged` block is the deterministic mergeConsensus proposal — the reconciler treats it as a vote summary, not as the final answer.

## Step 5.5: Reconciler Stage (np-researcher-reconciler, ADR-0018)

Spawn `agents/np-researcher-reconciler.md` (tier=sonnet, READ-ONLY on inputs, single Write target = `$RESEARCH_PATH`). The reconciler sees:

- All `$SWARM_K` `spawn-<i>.md` outputs verbatim.
- The deterministic `merge.md` proposal.
- The structured `$PREPARE_PAYLOAD.merged` JSON (so it can read `from_spawns`, `reasoning_trace_agreement`, contested counts without re-parsing).
- The `$CONTEXT_PATH` for grounding (locked decisions, OD-N overrides).
- `<schema_prompt>` = `output-lint prompt --schema research-final` — the binding contract for its output.

```bash
RECONCILER_SCHEMA=$(node .nubos-pilot/bin/np-tools.cjs output-lint prompt --schema research-final)
RECONCILER_MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-researcher-reconciler --profile balanced)
RECONCILER_START=$(node .nubos-pilot/bin/np-tools.cjs metrics start-timestamp)
```

```text
Spawn agent=np-researcher-reconciler tier=sonnet model=$RECONCILER_MODEL phase=$PHASE
  spawn_paths=<from $PREPARE_PAYLOAD.spawn_paths>
  merge_path=<from $PREPARE_PAYLOAD.merge_path>
  merged_json=$PREPARE_PAYLOAD.merged
  context_path=$CONTEXT_PATH
  final_path=$RESEARCH_PATH
  schema_prompt=$RECONCILER_SCHEMA
```

**Off-host (ADR-0021):** when `np-researcher-reconciler` routes to an `openai-compat` provider, run it via `spawn-offhost` instead of the host spawn. The reconciler is NOT Rule-9-audited and writes only the single `$RESEARCH_PATH` (`M<NNN>-RESEARCH.md`) artefact under `.nubos-pilot/` (inside the repo cwd — never live code), so it runs off-host with the default cwd (Read/Grep/Glob over the spawn outputs + Write confined to cwd), **no `--allow-bash`, no worktree**. It writes `$RESEARCH_PATH` exactly as the native reconciler; no emit-and-persist contract is needed. spawn-offhost self-records.

```bash
RECONCILER_KIND=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-researcher-reconciler --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).kind||"native")}catch{console.log("native")}})')
if [ "$RECONCILER_KIND" = "openai-compat" ]; then
  RECONCILER_PROMPT="${TMPDIR:-/tmp}/np-offhost-reconciler-${MILESTONE_ID}.md"
  # … render the SAME reconciler input (spawn_paths + merge_path + merged_json +
  #   context_path + $RECONCILER_SCHEMA + the EXACT final_path=$RESEARCH_PATH) PLUS
  #   $LANG_DIRECTIVE into "$RECONCILER_PROMPT" …
  node .nubos-pilot/bin/np-tools.cjs spawn-offhost \
    --agent np-researcher-reconciler --task-file "$RECONCILER_PROMPT" \
    --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" >/dev/null
fi
# else → native host spawn per the block above.
```

The reconciler classifies each consensus decision's reasoning-trace as `identical | overlapping | orthogonal | unknown` (groupthink detection), picks each contested decision with documented reason, and writes `$RESEARCH_PATH` with `agreement_score` and `contested_count` in frontmatter.

```bash
RECONCILER_END=$(node .nubos-pilot/bin/np-tools.cjs metrics end-timestamp)
node .nubos-pilot/bin/np-tools.cjs metrics record \
  --agent np-researcher-reconciler --tier sonnet --resolved-model "$RECONCILER_MODEL" \
  --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
  --started "$RECONCILER_START" --ended "$RECONCILER_END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count 0 --status ok --runtime "$RUNTIME"
```

## Step 5.6: Reconciler Output Lint (hard-gate)

```bash
node .nubos-pilot/bin/np-tools.cjs output-lint check \
  --file "$RESEARCH_PATH" \
  --schema research-final \
  --enforce \
  --text
LINT_RC=$?
if [[ "$LINT_RC" -ne 0 ]]; then
  echo "[np:research-phase] reconciler output violates research-final schema — re-spawn np-researcher-reconciler with the violation list. Do NOT hand-edit." >&2
  exit 1
fi
```

## Step 5.7: Disagreement Hard-Gate (ADR-0018)

Read the reconciler's frontmatter and apply the threshold gate. Defaults: `min_agreement_score=0.5`, `max_contested=2`. Below threshold or above max → askuser:

```bash
GATE=$(node .nubos-pilot/bin/np-tools.cjs researcher-reconcile gate "$PHASE")
NEEDS=$(echo "$GATE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).needs_askuser))")

if [[ "$NEEDS" == "true" ]]; then
  CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Schwarm disagreement",
    "question": "Researcher-Schwarm konvergiert nicht (agreement_score zu niedrig oder zu viele Contested Decisions). Wie weiter?",
    "options": [
      {"label": "Re-spawn mit schärferer task_query",  "description": "Workflow stoppt; du formulierst task_query präziser und rufst /np:research-phase $PHASE erneut auf."},
      {"label": "Fortfahren mit Reconciler-Pick",       "description": "Reconciler-Verdict wird übernommen; agreement_score + contested_count stehen in der Frontmatter für plan-checker. Risikoprofil wird mitgeführt."},
      {"label": "Manuell entscheiden",                  "description": "Workflow zeigt jede Contested Decision einzeln, du wählst pro Punkt."}
    ]
  }')
  case "$CHOICE" in
    *"Re-spawn"*) exit 0 ;;
    *"Fortfahren"*) echo "[np:research-phase] continuing with reconciler picks, gate violations recorded in $RESEARCH_PATH frontmatter." >&2 ;;
    *"Manuell"*) echo "[np:research-phase] manual contested-decision review — see $RESEARCH_PATH ## Contested Decisions" >&2 ;;
    *)
      echo "[np:research-phase] unrecognised answer: '$CHOICE' — aborting rather than continuing past a contested-decision gate." >&2
      exit 1
      ;;
  esac
fi
```

The gate's `needs_askuser`, `score`, `contested_count`, and `violations[]` are all in the CLI payload for downstream audit.

## Step 5.8: Validate the Research Coverage Section (D-22)

When `MODE == offline`, RESEARCH.md MUST contain a literal
`## Research Coverage` heading (D-22 in CONTEXT.md). Missing the section
while running offline is a correctness bug — plan-checker will otherwise
over-weight library-version claims the researcher could not verify.

```bash
if [[ "$MODE" == "offline" ]]; then
  if ! grep -q '^## Research Coverage$' "$RESEARCH_PATH"; then
    echo "research-missing-coverage: $RESEARCH_PATH is missing the '## Research Coverage' section required for offline research (D-22)" >&2
    exit 1
  fi
fi
```

When `MODE == online` the section must NOT appear (D-22 inverse) — the
check-workflows guard in Phase 10 (plan-checker review command) will flag
unnecessary coverage annotations so the planner treats them as signal, not
noise.

## Step 5.9: Capture the Research into Vector Memory (ADR-0014)

`np-researcher` (§ Vector-Memory Pre-recall) and `np-planner` both query
`memory-query --type research` for prior-milestone decisions. Nothing ever wrote
a `research` record, so those queries returned `[]` on every project — the
pre-recall step was inert and the `[CACHED:*]` provenance logic ran on an empty
set. This step is the missing writer: it is the only place a `research` record is
produced, and it runs here because `$RESEARCH_PATH` is final and schema-linted
only after Steps 5.6–5.8.

**ACTION CONTRACT — capture research (guard-backed)**

- Runs after the output-lint and disagreement gates have passed. Never before:
  an unlinted RESEARCH.md must not enter memory.
- `--skip-if-disabled` makes this a no-op when `memory.enabled=false` (the
  default). A config that opts *in* but cannot resolve still fails loudly — that
  is a broken setup, not an opt-out.
- `--id` is the milestone id, so there is exactly one research record per
  milestone. Without it, `_normalizeRecord` assigns a `randomUUID` and every
  re-run would pile up a near-duplicate.
  **Known limitation:** the memory layer is append-only (`index/add/query/rebuild/stats`,
  no update path), and `index()` *skips* an id it already knows. So re-running
  `/np:research-phase` for a milestone does **not** refresh its record — the
  first captured research wins until `.nubos-pilot/memory/records.jsonl` is
  edited and `memory-rebuild` is run. Accepted over the alternative (silent
  duplicates at different vintages, both returned by the same query).
- `provenance` mirrors the reconciler's own confidence: a research artefact whose
  agreement gate fired is `ASSUMED`, a converged one is `VERIFIED`. Never promote
  a contested consensus to `VERIFIED` — `np-researcher` renders these back as
  `[CACHED:ASSUMED]` precisely so plan-checker keeps scrutinising them.

```bash
# Fail closed on missing inputs. A shell variable does not survive a fence
# boundary (D3): if $RESEARCH_PATH or $MILESTONE_ID arrived empty, memory-add
# would happily write a record with a randomUUID, an empty body and a title of
# ": research" — and stamp it VERIFIED, because the gate call would fail open to
# the else-branch. An empty artefact indexed as verified prior research is worse
# than no record at all: np-researcher would recall it as [CACHED:VERIFIED].
if [ -z "$PHASE" ] || [ -z "$MILESTONE_ID" ] || [ -z "$RESEARCH_PATH" ]; then
  echo "research-capture-unset-context: PHASE/MILESTONE_ID/RESEARCH_PATH must be set before Step 5.9 — refusing to index a research record with no identity." >&2
  exit 1
fi
if [ ! -s "$RESEARCH_PATH" ]; then
  echo "research-capture-empty-artifact: $RESEARCH_PATH is missing or empty — refusing to index it as research." >&2
  exit 1
fi

GATE_JSON=$(node .nubos-pilot/bin/np-tools.cjs researcher-reconcile gate "$PHASE")
NEEDS_ASK=$(echo "$GATE_JSON" | node -e "process.stdin.on('data', d => { try { console.log(JSON.parse(d).needs_askuser) } catch (e) { console.log('unknown') } })")
case "$NEEDS_ASK" in
  false) RESEARCH_PROVENANCE="VERIFIED" ;;
  true)  RESEARCH_PROVENANCE="ASSUMED" ;;
  *)
    # Unreadable gate verdict. VERIFIED is a claim we can no longer justify, so
    # take the conservative side rather than fail open into the else-branch.
    RESEARCH_PROVENANCE="ASSUMED"
    echo "[np:research-phase] gate verdict unreadable — capturing research as ASSUMED." >&2
    ;;
esac

node .nubos-pilot/bin/np-tools.cjs memory-add \
  --skip-if-disabled \
  --type research \
  --id "$MILESTONE_ID" \
  --phase "$PHASE" \
  --title "$MILESTONE_ID: $(node .nubos-pilot/bin/np-tools.cjs phase-meta "$PHASE" --field name 2>/dev/null || echo "$MILESTONE_ID research")" \
  --body-file "$RESEARCH_PATH" \
  --provenance "$RESEARCH_PROVENANCE" \
  --tags "milestone:$MILESTONE_ID,phase:$PHASE"
```

## Step 6: Handle Researcher Return Block

Classify the researcher's structured-return block:

- `## RESEARCH COMPLETE` — display the one-paragraph summary, suggest
  `/np:plan-phase $PHASE` as the next step.
- `## CHECKPOINT REACHED` — surface the checkpoint block to the user and
  exit (scope_guardrail: no auto-resume).
- `## RESEARCH INCONCLUSIVE` — display the attempts log, ask the user
  whether to retry with different context or mark the phase as
  research-skipped (`--skip-research` path in `/np:plan-phase`).

```bash
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "select",
  "question": "Research artifact written. What next?",
  "options": ["Plan phase", "Review RESEARCH.md", "Done"]
}'
```

## Step 7: Commit RESEARCH.md

Respects `.nubos-pilot/config.json`'s `commit_docs` flag (default `true`).
Skipped entirely when research was aborted via D-23.

```bash
COMMIT_DOCS=$(node -e 'try{
  const c=require("./.nubos-pilot/config.json");
  process.stdout.write(String(c.commit_docs !== false));
}catch(e){process.stdout.write("true");}')

if [[ "$COMMIT_DOCS" == "true" ]]; then
  git add "$RESEARCH_PATH"
  if ! git diff --cached --quiet; then
    git commit -m "docs($MILESTONE_ID): research milestone $PHASE ($MODE mode)"
  fi
else
  echo "commit_docs=false — RESEARCH.md remains staged-dirty" >&2
fi
```

## Naming Conventions (D-03)

Canonical tokens this workflow uses:

| Token                         | Value                        |
| ----------------------------- | ---------------------------- |
| Tools-binary CJS entry        | `np-tools.cjs`               |
| Slash-command for research    | `/np:research-phase`         |
| Researcher subagent name      | `researcher`                 |
| Milestone directory root      | `.nubos-pilot/milestones/…`  |
| Claude-Code `Task(…)` spawn   | abstract `Spawn agent=…`     |

Auto-advance state lives on `workflow.auto_advance` (boolean) in
`.nubos-pilot/config.json`. Orchestrators set or clear it directly —
there is no `/np:autonomous` slash-command today.

## Exit Codes

- `0` — research produced, or user aborted cleanly (D-23 decline,
  overwrite-abort).
- `1` — validation failure (e.g. `research-missing-coverage` on the
  offline path).
- `2` — usage error (missing phase argument).

## See Also

- `agents/np-researcher.md` — the spawned subagent's contract (tier, tools,
  D-21..D-23 protocol).
- `bin/np-tools/research-phase.cjs` — init subcommand (payload shape, env
  var contract for tools_available).
- `tests/fixtures/research/offline-sample.md` — golden RESEARCH.md sample
  with the `## Research Coverage` section; consumed by plan-checker
  contract tests.
- `/np:plan-phase` — integrates research automatically; invoke this
  standalone workflow only when you want an audit-friendly research commit.
## Definition of Done

This workflow exits successfully only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 5 (Genuinely impress) — every claim in `RESEARCH.md` carries provenance + confidence; no vague prose. Contested decisions surface explicitly in `## Contested Decisions`, never papered over.
- Rule 9 (Search before building) — `learning-match` runs first; if a high-similarity hit exists the swarm is bypassed and the cache is cited.
- Rule 11 (Ship the complete thing) — researcher swarm runs `k=3` parallel spawns, each output linted against the `researcher-output` schema (Step 4.5, ADR-0017), then deterministic merge feeds the `np-researcher-reconciler` (Step 5.5, ADR-0018), whose output is linted against `research-final` (Step 5.6) and gated for disagreement (Step 5.7). The final `M<NNN>-RESEARCH.md` is what the planner consumes.
- Rule 12 (Boil the ocean) — open questions are listed exhaustively; no "we will revisit later" without a flag. When the reconciler verdict is `needs_re_spawn`, the workflow stops at the askuser hard-gate; silent continuation is forbidden.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
