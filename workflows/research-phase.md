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
(`agents/np-planner.md`) and then by plan-checker. The planner turns
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
    "prompt": "RESEARCH.md already exists for this phase. How do you want to proceed?",
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
  if [[ "$CONFIRM" != "yes" && "$CONFIRM" != "true" ]]; then
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

## Step 4: Spawn the Researcher Subagent

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
```

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

The researcher writes exactly one file: `$RESEARCH_PATH`. It may invoke
`WebFetch` / `mcp__context7__*` when `$MODE == online`, or fall back to
`Read` / `Grep` / `Glob` only when `$MODE == offline`.

## Step 5: Validate the Research Coverage Section (D-22)

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
  "prompt": "Research artifact written. What next?",
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
    git commit --no-verify -m "docs($MILESTONE_ID): research milestone $PHASE ($MODE mode)"
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

Auto-advance state lives on `workflow.auto_advance` (boolean). Set
from `/np:autonomous`; cleared when the loop exits or the user aborts.

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
