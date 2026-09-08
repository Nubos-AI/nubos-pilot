---
command: np:verify-work
description: Two-pass goal-backward verification after execution. Verifier agent classifies deterministic evidence; Pass-2 askUser loop resolves needs_user_confirm flags.
argument-hint: <milestone-number>
---

# /np:verify-work

<objective>
Verify that a just-executed milestone actually satisfies the ROADMAP `success_criteria`. Pass 1 = verifier subagent emits Pass/Fail/Defer with evidence; Pass 2 = workflow askUser resolves any `needs_user_confirm` items. Final artifact: `<milestone_dir>/<milestone_id>-VERIFICATION.md`.

Slice-level acceptance (UAT) is validated separately by `/np:validate-phase <N>` which reads each slice's `S<NNN>-UAT.md`.
</objective>

## Initialize

```bash
PHASE="$1"
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT=$(node .nubos-pilot/bin/np-tools.cjs init verify-work init "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_VERIFIER=$(node .nubos-pilot/bin/np-tools.cjs agent-skills verifier 2>/dev/null)
MILESTONE_ID=$(echo "$INIT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).milestone_id))')

# agents.verifier kill-switch. When false the whole verifier stage is a no-op:
# no np-verifier spawn, no VERIFICATION.md, no schema hard-gate. The milestone's
# success_criteria stay unverified — the operator opted into that. Checked here,
# before any spawn, so `false` costs nothing. Exit 0 (not a failure — it is a
# deliberate skip) with a loud stderr line so it is never silent.
VERIFIER_ENABLED=$(node .nubos-pilot/bin/np-tools.cjs config-get agents.verifier 2>/dev/null || echo true)
if [ "$VERIFIER_ENABLED" = "false" ]; then
  echo "[np:verify-work] agents.verifier=false — verification skipped (no-op). No ${MILESTONE_ID}-VERIFICATION.md written; success_criteria remain unverified until you re-enable the verifier and re-run." >&2
  exit 0
fi

# Pass-2 re-investigation bounds are files (see "Pass 2" below). Clear any left
# by an earlier invocation so each run gets its single re-investigation per SC.
rm -f "${TMPDIR:-/tmp}"/np-verify-reinvestigated-"${MILESTONE_ID}"-*
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative. Obey it for user-facing output, askuser
prompts, and pass it into the np-verifier spawn prompt so VERIFICATION.md
prose (Pass/Fail findings, root-cause notes) follows the project language.
Test-case IDs, file paths, and stack traces stay canonical. Supersedes
CLAUDE.md.

Parse: `milestone`, `milestone_id`, `milestone_dir`, `milestone_name`, `success_criteria`, `draft_results`, `verification_path`, `slice_uat`, `verifier_tier`, `text_mode`, `text_mode_source`, `agent_skills`.

**Askuser routing.** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below (including the Pass-2 `needs_user_confirm` gate) is a spec, not a literal command. Pick the path once at Initialize:
- **Claude Code** (native `AskUserQuestion` tool is available): parse the JSON spec and call `AskUserQuestion` directly. `select` → `multiSelect: false`; `multiselect` → `multiSelect: true`; `confirm` → `options: [{label: "Yes"}, {label: "No"}]`; `input` → ask free-form in chat. Use a short `header` (≤12 chars).
- **`text_mode == true`** (INIT payload): skip every askuser block and render questions as plain-text numbered lists. Opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.
- **Other runtime with TTY** (Codex, Gemini, …): execute the shell `askuser` block verbatim.

## Skills (Nubos library)

Instruct the verifier (in its spawn prompt) to load the matching Nubos skill before classifying — the skill's "Verification bar" is the standard the SC is judged against, not just the SC's own wording:

| SC type | Skill to use |
|---|---|
| Visual polish, layout, hierarchy, motion | `np-impeccable` (`.claude/skills/np-impeccable/SKILL.md`) |
| Accessibility, semantic HTML, keyboard/contrast | `np-web-design-guidelines`, `np-accessibility-audit` |
| Component architecture, design-system fit | `np-design` |
| API / endpoint / contract behaviour | `np-api-design` |
| Security, auth, input handling, secrets, crypto | `np-secure-code-review` (and `np-threat-model` if a new trust boundary) |
| Authorization — roles, permissions, ownership, access rules | `np-access-control` |
| Encryption, hashing, TLS, key/secret management | `np-encryption` |
| Personal/sensitive data handling, retention, logging | `np-data-privacy` |
| Schema / migration / data correctness | `np-data-modeling` |
| Error handling, retries, failure modes | `np-error-handling` |
| Resilience under dependency failure — timeout, circuit-breaker, fallback | `np-resilience-patterns` |
| Caching correctness / invalidation | `np-caching-strategy` |
| Async job / queue / worker behaviour — idempotency, ordering, DLQ | `np-queue-design` |
| Module/service boundary, coupling, contract integrity | `np-service-boundary` |
| Performance, latency, query/loop cost | `np-performance` |
| LLM / agent / retrieval behaviour | `np-llm-app-architecture`, `np-rag-design` |

For borderline Pass/Fail calls in Pass 2 (deterministic evidence inconclusive **and** the SC carries real consequences), pressure-test with **`np-council`** before flipping `needs_user_confirm` → `Pass`/`Fail`. An SC with no matching skill is judged on evidence alone.

## Output-Schema (pre-spawn injection)

The verifier MUST produce `M<NNN>-VERIFICATION.md` conforming to the `verification` output schema (frontmatter `schema_version: 2`, required counts, body `### SC-N: …` blocks with `Status / Classified by / Evidence`, no `[object Object]` titles). Inject the schema into the spawn prompt so the agent sees the contract verbatim:

```bash
VERIFICATION_SCHEMA=$(node .nubos-pilot/bin/np-tools.cjs output-lint prompt --schema verification)
```

Pass `$VERIFICATION_SCHEMA` as a literal section in the np-verifier spawn prompt (heading "## Output Schema — verification"). The agent has the schema in front of it before writing.

## Pass 1 — verifier agent

Spawn `agents/np-verifier.md` (tier: sonnet, READ-ONLY tools) with:

- `<files_to_read>` = `[M<NNN>-ROADMAP.md, M<NNN>-CONTEXT.md, every S<NNN>-PLAN.md, every S<NNN>-SUMMARY.md, every T<NNNN>-PLAN.md + T<NNNN>-SUMMARY.md, all task commits via git log --grep='^task(M<NNN>-']`
- `success_criteria` list from `$INIT`.
- `$VERIFICATION_SCHEMA` (the rendered schema-prompt — agent treats it as a hard contract, not advice).

The agent emits a structured verdict per SC: Pass | Fail | Needs-User-Confirm | Defer (never invents a SC, never edits source).

**Off-host (ADR-0021):** when `np-verifier` routes to an `openai-compat` provider, run it via `spawn-offhost --read-only` instead of the host spawn. The verifier never edits source and **emits** its per-SC verdict as the final message — exactly the contract the native path already consumes — so it needs no worktree, no Bash, no Write. Pass `--output-schema verification` for the dispatch-level lint hook, then feed the returned `.content` (the emitted verdict) into the SAME Pass-1 `emit-draft` / Pass-2 `record-sc` persistence below; `VERIFICATION.md` is produced exactly as for the native agent.

```bash
VERIFIER_KIND=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-verifier --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).kind||"native")}catch{console.log("native")}})')
if [ "$VERIFIER_KIND" = "openai-compat" ]; then
  VERIFIER_PROMPT="${TMPDIR:-/tmp}/np-offhost-verifier-${MILESTONE_ID}.md"
  # … render the SAME spawn prompt (files_to_read + success_criteria +
  #   $VERIFICATION_SCHEMA) PLUS $LANG_DIRECTIVE into "$VERIFIER_PROMPT" …
  VERIFIER_OUT=$(node .nubos-pilot/bin/np-tools.cjs spawn-offhost \
    --agent np-verifier --task-file "$VERIFIER_PROMPT" --read-only \
    --output-schema verification --phase "$PHASE")
  # The emitted verdict is `.content` of $VERIFIER_OUT — it drives emit-draft / record-sc below.
fi
# else → native host spawn per the block above.
```

Persist the deterministic draft:

```bash
node .nubos-pilot/bin/np-tools.cjs init verify-work emit-draft "$PHASE"
```

## Pass 2 — user-driven gate for needs_user_confirm

For each result flagged `needs_user_confirm` by Pass 1, ask the user:

`record-sc` accepts exactly `Pass | Fail | Defer | Pending` (`_VALID_SC_STATUSES`
in `bin/np-tools/verify-work.cjs`). `Re-investigate` is a **workflow action**, not
an SC status — it must never reach the consumer, or the CLI throws
`Invalid SC status` and the whole Pass-2 loop dies on a legitimate answer.

```bash
# Example — iterated by the workflow over each needs_user_confirm SC.
# $SC_ID is the criterion under review (e.g. "SC-3"); the marker path bounds the
# re-investigation across the ACTION CONTRACT's return into the Pass-1 fence.
SC_RETRY_MARKER="${TMPDIR:-/tmp}/np-verify-reinvestigated-${MILESTONE_ID}-${SC_ID}"
CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "select",
  "header": "SC-3: UX feels responsive",
  "question": "Ist dieses Kriterium erfüllt?",
  "options": [
    {"label": "Pass",           "description": "Kriterium ist erfüllt."},
    {"label": "Fail",           "description": "Kriterium ist nicht erfüllt — Defekt."},
    {"label": "Defer",          "description": "Absichtlich zurückgestellt, später prüfen."},
    {"label": "Re-investigate", "description": "Brauche mehr Evidence — spawn Verifier nochmal."}
  ]
}')

SC_STATUS=""
case "$CHOICE" in
  Pass|Fail|Defer) SC_STATUS="$CHOICE" ;;
  "Re-investigate")
    if [[ -f "$SC_RETRY_MARKER" ]]; then
      echo "[np:verify-work] $SC_ID already re-investigated once and is still inconclusive — answer Pass, Fail or Defer." >&2
      exit 1
    fi
    : > "$SC_RETRY_MARKER"
    ;;
  *)
    echo "[np:verify-work] unrecognised answer: '$CHOICE' — aborting rather than recording an invalid SC status." >&2
    exit 1
    ;;
esac

if [[ -n "$SC_STATUS" ]]; then
  node .nubos-pilot/bin/np-tools.cjs init verify-work record-sc "$PHASE" "$SC_ID" "$SC_STATUS"
fi
```

> **ACTION CONTRACT — `Re-investigate` branch:** when the case above takes the
> `Re-investigate` arm, `$SC_STATUS` is empty and **nothing is recorded**. Re-spawn
> `np-verifier` (Pass 1) scoped to `$SC_ID` alone with the user's stated evidence
> gap in the prompt, then re-enter this gate for that SC. `$SC_RETRY_MARKER`
> bounds it to a single re-investigation per SC — never loop the spawn. The marker
> lives on disk because this gate and the Pass-1 spawn are separate ```bash fences,
> i.e. separate shell processes: a shell variable would be back to unset on return.
> Initialize clears the markers, so each invocation gets its own single retry.

## Hard-gate — Schema lint

Before declaring success, the just-written `M<NNN>-VERIFICATION.md` is lint-checked against the `verification` schema. Drift in frontmatter, missing required keys, wrong `Milestone Status` enum, broken `### SC-N: …` blocks, or `[object Object]` titles abort the workflow loudly:

```bash
LINT_PATH="$(node .nubos-pilot/bin/np-tools.cjs init verify-work init "$PHASE" | grep verification_path || true)"
node .nubos-pilot/bin/np-tools.cjs output-lint check \
  --file "${MILESTONE_DIR}/${MILESTONE_ID}-VERIFICATION.md" \
  --schema verification \
  --enforce \
  --text
LINT_RC=$?
if [[ "$LINT_RC" -ne 0 ]]; then
  echo "[np:verify-work] VERIFICATION.md violates output schema — re-spawn np-verifier with violation feedback above, or fix the agent prompt. Do NOT edit the file by hand." >&2
  exit 1
fi
```

This gate fires at write-time, not at `/np:close-project` aggregation time. Drift breaks here, not 7 milestones later.

## Hard-stop on Fail

If any result ends with `status: Fail` after Pass 1 or Pass 2:

```bash
echo "[np:verify-work] Milestone $PHASE hat Fail-Ergebnisse — LOUD FAIL." >&2
exit 1
```

## Scope Guardrail

**Do:** spawn `agents/np-verifier.md` with read-only tools; persist SC updates via `record-sc`; exit non-zero on any Fail.
**Don't:** let the verifier edit source files; self-classify subjective criteria; mask a Fail as Defer.

## Output

- `<milestone_dir>/<milestone_id>-VERIFICATION.md` written.
- Milestone status recorded as `verified | failed | deferred`.
- Ready for `/np:validate-phase $PHASE` to validate each slice's UAT.
## Definition of Done

This workflow exits successfully only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 5 (Genuinely impress) — every success_criterion gets a Pass / Fail / Needs-User-Confirm verdict with deterministic evidence.
- Rule 10 (Test before shipping) — Pass requires commit SHA + test name + grep hit; manual evidence is Fail.
- Rule 11 (Ship the complete thing) — `M<NNN>-VERIFICATION.md` is fully populated on exit, no `null` rows.
- Rule 3 (Do it with tests / mechanical-check class) — `output-lint check --schema verification --enforce` is green; schema drift is a hard-stop, not a warning. ADR-0017.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
