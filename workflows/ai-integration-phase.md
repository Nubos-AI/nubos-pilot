---
command: np:ai-integration-phase
description: Generate AI-SPEC.md for AI/ML phases via 4-agent chain (np-framework-selector → np-ai-researcher → np-domain-researcher → np-eval-planner) with a completeness validation gate.
---

# np:ai-integration-phase

Produces `{phase_dir}/{padded}-AI-SPEC.md` by running a strict-serial 4-agent chain.
Inserts between `/np:discuss-phase` and `/np:plan-phase`. Locks domain
context, framework selection, implementation patterns, and evaluation
strategy BEFORE the planner creates tasks.

Every Task-spawn site is wrapped in the Plan 09-05 metrics + resolve-model
pattern (D-06, D-01). `RUNTIME` is detected once at the top of the bash
block and re-used by every `metrics record` call.

## Initialize

```bash
PHASE="$1"
if [[ -z "$PHASE" ]]; then
  echo "Usage: /np:ai-integration-phase <phase-number>" >&2
  exit 2
fi

INIT=$(node np-tools.cjs init ai-integration-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
RUNTIME=$(node -e "console.log(require('./lib/runtime/index.cjs').detect().runtime)")
```

Parse JSON for: `phase`, `padded`, `phase_dir`, `ai_spec_path`,
`has_ai_spec`, `template_path`, `agents.framework_selector`,
`agents.ai_researcher`, `agents.domain_researcher`, `agents.eval_planner`.

```bash
PADDED=$(echo "$INIT" | jq -r '.padded')
PHASE_DIR=$(echo "$INIT" | jq -r '.phase_dir')
AI_SPEC_PATH=$(echo "$INIT" | jq -r '.ai_spec_path')
HAS_AI_SPEC=$(echo "$INIT" | jq -r '.has_ai_spec')
TEMPLATE_PATH=$(echo "$INIT" | jq -r '.template_path')
PLAN_ID="${PADDED}-ai-integration"
TASK_ID="${PADDED}-ai-integration"
```

## Pre-Flight Gates

<pre_flight>

### Gate 1 — AI-SPEC.md already exists

If `has_ai_spec == true`:

```bash
if [[ "$HAS_AI_SPEC" == "true" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Existing AI-SPEC",
    "question": "AI-SPEC.md already exists for Phase '"$PHASE"'. What would you like to do?",
    "options": [
      {"label": "Update — re-run with existing as baseline", "description": "Re-runs the 4-agent chain against the current spec."},
      {"label": "View — display current AI-SPEC and exit",   "description": "Reads the file and exits without changes."},
      {"label": "Skip — keep current AI-SPEC and exit",      "description": "Leaves the file untouched."}
    ]
  }')
  case "$CHOICE" in
    "View"*) cat "$AI_SPEC_PATH"; exit 0 ;;
    "Skip"*) exit 0 ;;
  esac
fi
```

</pre_flight>

## Philosophy

<philosophy>
AI-SPEC.md locks the four things AI projects most often ship wrong: the
framework choice (too early / for the wrong reason), the domain rubrics
(assumed without asking an expert), the implementation pattern (copy-paste
from outdated docs), and the evaluation strategy (retrofitted after code
is merged). Running this workflow BEFORE `/np:plan-phase` surfaces those
decisions as explicit artifacts the planner and plan-checker can then
enforce.
</philosophy>

## Main Flow

The 4 agents run in strict serial order. Each spawn is wrapped in the
Plan-09-05 metrics pattern. A failure in any step aborts the chain — the
next agent reads the partial AI-SPEC.md that prior agents wrote.

### Step 0 — Initialize AI-SPEC.md from template

```bash
if [[ "$HAS_AI_SPEC" != "true" ]]; then
  cp "$TEMPLATE_PATH" "$AI_SPEC_PATH"
fi
```

### Step 1 — Framework selection (np-framework-selector, opus)

```bash
START=$(node np-tools.cjs metrics start-timestamp)
MODEL=$(node np-tools.cjs resolve-model np-framework-selector --profile balanced)
# Spawn agent=np-framework-selector model=$MODEL
#   input: phase_number=$PHASE, ai_spec_path=$AI_SPEC_PATH, context=$PHASE_DIR/$PADDED-CONTEXT.md
#   output: section 2 of AI-SPEC.md (framework scoring + selected)
END=$(node np-tools.cjs metrics end-timestamp)
node np-tools.cjs metrics record \
  --agent np-framework-selector --tier opus --resolved-model "$MODEL" \
  --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
  --started "$START" --ended "$END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count 0 --status ok --runtime "$RUNTIME"
```

### Step 2 — AI researcher (np-ai-researcher, sonnet)

```bash
START=$(node np-tools.cjs metrics start-timestamp)
MODEL=$(node np-tools.cjs resolve-model np-ai-researcher --profile balanced)
# Spawn agent=np-ai-researcher model=$MODEL
#   input: ai_spec_path=$AI_SPEC_PATH (framework from step 1 already present)
#   output: sections 3 (Implementation) + 4b (Pydantic models) of AI-SPEC.md
END=$(node np-tools.cjs metrics end-timestamp)
node np-tools.cjs metrics record \
  --agent np-ai-researcher --tier sonnet --resolved-model "$MODEL" \
  --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
  --started "$START" --ended "$END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count 0 --status ok --runtime "$RUNTIME"
```

### Step 3 — Domain researcher (np-domain-researcher, sonnet)

```bash
START=$(node np-tools.cjs metrics start-timestamp)
MODEL=$(node np-tools.cjs resolve-model np-domain-researcher --profile balanced)
# Spawn agent=np-domain-researcher model=$MODEL
#   input: ai_spec_path=$AI_SPEC_PATH
#   output: section 1b (Domain Context) of AI-SPEC.md
END=$(node np-tools.cjs metrics end-timestamp)
node np-tools.cjs metrics record \
  --agent np-domain-researcher --tier sonnet --resolved-model "$MODEL" \
  --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
  --started "$START" --ended "$END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count 0 --status ok --runtime "$RUNTIME"
```

### Step 4 — Eval planner (np-eval-planner, opus)

```bash
START=$(node np-tools.cjs metrics start-timestamp)
MODEL=$(node np-tools.cjs resolve-model np-eval-planner --profile balanced)
# Spawn agent=np-eval-planner model=$MODEL
#   input: ai_spec_path=$AI_SPEC_PATH (domain rubrics from step 3 ground the dimensions)
#   output: sections 5 (Eval Dimensions), 6 (Guardrails), 7 (Monitoring)
END=$(node np-tools.cjs metrics end-timestamp)
node np-tools.cjs metrics record \
  --agent np-eval-planner --tier opus --resolved-model "$MODEL" \
  --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
  --started "$START" --ended "$END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count 0 --status ok --runtime "$RUNTIME"
```

## Validation Gate

After all 4 agents finish, grep the completed AI-SPEC.md for the required
section headers. Missing any → ask the user to re-run that step or accept
with warnings.

```bash
MISSING=""
for SECTION in "## 1b. Domain Context" "## 2. Framework Selection" "## 3. Implementation" "## 5. Eval Dimensions" "## 6. Guardrails"; do
  if ! grep -qF "$SECTION" "$AI_SPEC_PATH"; then
    MISSING="$MISSING\n  - missing: $SECTION"
  fi
done

if [[ -n "$MISSING" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "AI-SPEC validation — missing sections",
    "question": "Some required AI-SPEC sections are missing. What would you like to do?",
    "options": [
      {"label": "Re-run eval planner",  "description": "Spawn np-eval-planner once more with current AI-SPEC state."},
      {"label": "Accept with warnings", "description": "Proceed and surface the gaps in the commit message."},
      {"label": "Abort",                "description": "Exit without committing."}
    ]
  }')
  case "$CHOICE" in
    "Abort") exit 1 ;;
  esac
fi
```

## Commit

```bash
git add "$AI_SPEC_PATH"
git commit -m "docs(${PADDED}): generate AI-SPEC.md via 4-agent chain"
```

## Scope Guardrail

<scope_guardrail>
**Do:**
- Run the 4 agents in strict serial order (selector → ai → domain → eval).
- Emit a metrics record AFTER every Task spawn (D-06).
- Resolve every MODEL via `np-tools.cjs resolve-model` — no hardcoded IDs.
- Use `np-tools.cjs askuser` for every prompt (Phase-3 INST-03 invariant).
- Commit the final AI-SPEC.md when validation passes or the user accepts.

**Don't:**
- Invoke the host-specific prompt tool directly — always route through `np-tools.cjs askuser`.
- Parallelize the chain — later agents read what earlier agents wrote.
- Call any tools binary other than `np-tools.cjs` (the sole CLI entry per Plan 09-05 D-14).
- Reference legacy homedir payload paths — those directories do not exist
  in nubos-pilot projects.
- Skip any metrics record block — the Phase-10 np:stats consumer expects
  one record per Task spawn.
</scope_guardrail>

## Output

- `{phase_dir}/{padded}-AI-SPEC.md` — filled-in AI design contract
- 4 metrics records in `.nubos-pilot/metrics/phase-${PHASE}.jsonl`
- One git commit (when validation passes or user accepts with warnings)
