---
command: np:code-review-fix
description: Auto-fixer that consumes REVIEW.md, applies fixes finding-by-finding as per-finding atomic commits (D-21 exception), writes REVIEW-FIX.md. Supports --auto iteration cap 3, --fix-scope=critical|warning|info|all filter. Spawns np-code-fixer (sonnet). Final commit is the REVIEW-FIX.md docs commit.
---

# np:code-review-fix

Consumes `{phase_dir}/{padded}-REVIEW.md` (produced by `/np:code-review`) and
applies fixes via a `np-code-fixer` (sonnet) spawn that emits per-finding
`fix(...)` commits INSIDE the agent (D-21 exception to ADR-0004) and
writes `REVIEW-FIX.md` with `status: all_fixed | partial | none_fixed`.

The workflow's own final commit is the REVIEW-FIX.md docs commit — it
is NOT re-emitted for the per-finding fixes. See the Commit section for
the exact atomic-commit ownership contract between workflow and agent.

The single Task-spawn site is wrapped in the Plan 09-05 metrics +
resolve-model pattern (D-06, D-01). `RUNTIME` is detected once at the
top of the bash block. All prompts route through `np-tools.cjs askuser`
(INST-03 invariant).

Gate logic: before spawning the fixer, the workflow reads REVIEW.md's
frontmatter via `lib/frontmatter.cjs.extractFrontmatter`, validates the
schema (`files_reviewed_list` + `status` + `depth` + `findings`) and
short-circuits if `status` is `clean` or `skipped` (T-10-03-06
mitigation, Pitfall 2 defense-in-depth). A malformed REVIEW.md triggers
an exit before any fix attempt — producer/consumer FM drift is surfaced
at this layer, not hidden by the agent.

## Initialize

```bash
PHASE="$1"
if [[ -z "$PHASE" ]]; then
  echo "Usage: /np:code-review-fix <phase-number> [--fix-scope=critical|warning|info|all] [--auto] [--iteration=N]" >&2
  exit 2
fi

INIT=$(node np-tools.cjs init code-review "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
RUNTIME=$(node -e "console.log(require('./lib/runtime/index.cjs').detect().runtime)")
```

Parse JSON for: `phase`, `padded`, `phase_dir`, `review_path`,
`review_fix_path`, `agents.code_fixer`. Note: the init dispatcher
`code-review` covers both reviewer and fixer workflows — same payload
shape, different fields consumed.

```bash
PADDED=$(echo "$INIT" | jq -r '.padded')
PHASE_DIR=$(echo "$INIT" | jq -r '.phase_dir')
REVIEW_PATH=$(echo "$INIT" | jq -r '.review_path')
REVIEW_FIX_PATH=$(echo "$INIT" | jq -r '.review_fix_path')
PLAN_ID="${PADDED}-code-review-fix"
TASK_ID="${PADDED}-code-review-fix"
```

## Argument Parsing

```bash
FIX_SCOPE="all"
AUTO_MODE="false"
ITERATION=1
for arg in "$@"; do
  case "$arg" in
    --fix-scope=*) FIX_SCOPE="${arg#--fix-scope=}" ;;
    --auto)        AUTO_MODE="true" ;;
    --iteration=*) ITERATION="${arg#--iteration=}" ;;
  esac
done

case "$FIX_SCOPE" in
  critical|warning|info|all) ;;
  *) echo "Warning: invalid --fix-scope='$FIX_SCOPE' (expected critical|warning|info|all). Using 'all'." >&2
     FIX_SCOPE="all" ;;
esac

if ! [[ "$ITERATION" =~ ^[0-9]+$ ]]; then
  echo "Warning: invalid --iteration='$ITERATION' (expected non-negative integer). Using 1." >&2
  ITERATION=1
fi
```

## Pre-Flight Gates

<pre_flight>

### Gate 1 — REVIEW.md presence

REVIEW.md MUST exist before fixing. Do NOT auto-run code-review — the
user's explicit review intent is the contract.

```bash
if [[ ! -f "$REVIEW_PATH" ]]; then
  echo "Error: $REVIEW_PATH not found. Run /np:code-review $PHASE first." >&2
  exit 1
fi
```

### Gate 2 — REVIEW.md frontmatter schema + status gate

Load the REVIEW.md frontmatter once via `lib/frontmatter.cjs` and
validate the fields downstream consumers depend on. If any required
field is missing, exit with a clear error — producer/consumer FM drift
is T-10-03-06 and MUST NOT be silently fixed here.

```bash
FM_JSON=$(REVIEW_PATH="$REVIEW_PATH" node -e "
  const fs = require('node:fs');
  const { extractFrontmatter } = require('./lib/frontmatter.cjs');
  const raw = fs.readFileSync(process.env.REVIEW_PATH, 'utf-8');
  const { frontmatter } = extractFrontmatter(raw);
  process.stdout.write(JSON.stringify(frontmatter || {}));
" 2>/dev/null || echo '{}')

STATUS=$(echo "$FM_JSON" | jq -r '.status // empty')
DEPTH=$(echo "$FM_JSON" | jq -r '.depth // empty')
HAS_FILES_LIST=$(echo "$FM_JSON" | jq -r 'has("files_reviewed_list") // false')
HAS_FINDINGS=$(echo "$FM_JSON" | jq -r 'has("findings") // false')

MISSING=""
[[ -z "$STATUS" ]]               && MISSING="$MISSING status"
[[ -z "$DEPTH" ]]                && MISSING="$MISSING depth"
[[ "$HAS_FILES_LIST" != "true" ]] && MISSING="$MISSING files_reviewed_list"
[[ "$HAS_FINDINGS" != "true" ]]   && MISSING="$MISSING findings"

if [[ -n "$MISSING" ]]; then
  echo "Error: REVIEW.md frontmatter missing required fields:$MISSING" >&2
  echo "  Expected schema (owned by np-code-reviewer):" >&2
  echo "    status: clean | issues_found | skipped" >&2
  echo "    depth: quick | standard | deep" >&2
  echo "    files_reviewed_list: [path, ...]" >&2
  echo "    findings: { critical: N, warning: N, info: N, total: N }" >&2
  echo "  Re-run /np:code-review $PHASE to regenerate." >&2
  exit 1
fi
```

Short-circuit on non-actionable statuses:

```bash
case "$STATUS" in
  clean|skipped)
    echo "Nothing to fix — REVIEW.md status=$STATUS."
    exit 0
    ;;
  issues_found)
    : # proceed
    ;;
  *)
    echo "Warning: unknown REVIEW.md status='$STATUS' (expected clean|skipped|issues_found). Proceeding with fix attempt." >&2
    ;;
esac
```

### Gate 3 — Existing REVIEW-FIX.md

If a prior fix report is present, let the user choose between re-running,
viewing the current report, or skipping (Pattern S-3).

```bash
if [[ -f "$REVIEW_FIX_PATH" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Existing REVIEW-FIX",
    "question": "REVIEW-FIX.md already exists for Phase '"$PHASE"'. What would you like to do?",
    "options": [
      {"label": "Re-run — replace the current fix report", "description": "Re-runs np-code-fixer and overwrites the existing file + emits additional per-finding fix commits if new fixes apply."},
      {"label": "View — display current fix report and exit", "description": "Reads the file and exits without changes."},
      {"label": "Skip — keep current fix report and exit", "description": "Leaves the file untouched."}
    ]
  }')
  case "$CHOICE" in
    "View"*) cat "$REVIEW_FIX_PATH"; exit 0 ;;
    "Skip"*) exit 0 ;;
  esac
fi
```

</pre_flight>

## Philosophy

<philosophy>
A fix workflow that re-emits bulk commits loses the one thing atomic
commits buy: the ability to `git revert` a single bad fix without
clobbering the others. The D-21 exception to ADR-0004 exists for
exactly this reason — the agent owns per-finding `fix(...)` commits
because the agent is the one that knows which file changes map to
which REVIEW.md finding ID. The workflow's job is the envelope: gate
the inputs, resolve the model, wrap the spawn in metrics, and commit
the final REVIEW-FIX.md artifact ONCE.

Fix-scope filtering (`--fix-scope=critical|warning|info|all`) is
deliberately a coarse filter, not a per-finding whitelist. A
per-finding whitelist would require the user to read REVIEW.md ahead of
time, which defeats the auto-fix value proposition. Severity-level
filtering is the right granularity: "only fix critical issues; I'll
triage warnings manually."

The `--auto` iteration loop (cap 3) drives in-session
auto-fix attempts. Each iteration re-reviews the SAME
`files_reviewed_list` captured in REVIEW.md's frontmatter — scope
does NOT drift across iterations. When `status === clean` is reached,
the loop exits early. When iteration 3 still returns `partial`,
remaining issues stay documented in REVIEW-FIX.md for manual triage.

Why no workflow-level fix-commit bundling? Because `git log --grep` is
how users navigate fix history, and a bundled `fix(): apply N fixes`
commit destroys the grep signal. Per-finding commits with the finding
ID (e.g., `fix(10-03-T02): CR-042 rename shadowed variable`) are
searchable, revertable, and reviewable — the atomic-commit tax is
worth the observability dividend.
</philosophy>

## REVIEW.md → np-code-fixer Contract

The fixer agent (`np-code-fixer`) owns BOTH the per-finding fix
commits AND the final `docs(...)` REVIEW-FIX.md commit. This workflow
does NOT re-commit after the agent returns. The contract:

1. Agent reads `$REVIEW_PATH` frontmatter (same schema validated in
   Gate 2).
2. Agent filters findings by `--fix-scope` (critical|warning|info|all).
3. For each finding in scope: agent applies the fix, runs
   `node np-tools.cjs commit "fix(${PADDED}): ${FINDING_ID} <one-line>" --files <path>`
   exactly once per finding (T-10-02-02 mitigation — never raw
   `git commit` shell strings).
4. Agent writes `$REVIEW_FIX_PATH` with frontmatter:
   `status: all_fixed | partial | none_fixed`, `findings_in_scope: N`,
   `fixed: N`, `skipped: N`, `iteration: $ITERATION`.
5. Agent emits the final `docs(${PADDED}): add code review fix report`
   commit for REVIEW-FIX.md itself.

If the agent produces REVIEW-FIX.md but skips the final docs commit
(malfunction), the workflow's post-validation below will re-emit it
from outside the agent — but that is a fallback, not the primary path.

## Main Flow

### Step 1 — Code fixer (np-code-fixer, sonnet)

```bash
START=$(node np-tools.cjs metrics start-timestamp)
MODEL=$(node np-tools.cjs resolve-model np-code-fixer --profile balanced)
# Spawn agent=np-code-fixer model=$MODEL
#   input: review_path=$REVIEW_PATH, review_fix_path=$REVIEW_FIX_PATH,
#          phase=$PHASE, padded=$PADDED, phase_dir=$PHASE_DIR,
#          fix_scope=$FIX_SCOPE, auto=$AUTO_MODE, iteration=$ITERATION
#   output: $REVIEW_FIX_PATH + 0..N per-finding fix(...) commits
#           (D-21 exception — commits happen INSIDE the agent, not
#           after the Task returns) + final docs(...) REVIEW-FIX.md
#           commit emitted by the agent itself
Task(
  subagent_type="np-code-fixer",
  model="$MODEL",
  prompt="<files_to_read>$REVIEW_PATH</files_to_read><config>review_path=$REVIEW_PATH,review_fix_path=$REVIEW_FIX_PATH,phase=$PHASE,padded=$PADDED,phase_dir=$PHASE_DIR,fix_scope=$FIX_SCOPE,auto=$AUTO_MODE,iteration=$ITERATION</config>"
)
END=$(node np-tools.cjs metrics end-timestamp)
node np-tools.cjs metrics record \
  --agent np-code-fixer --tier sonnet --resolved-model "$MODEL" \
  --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
  --started "$START" --ended "$END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count 0 --status ok --runtime "$RUNTIME"
```

## Validation Gate

After the fixer returns, verify REVIEW-FIX.md exists and has a
`status:` field. If missing, the agent likely failed mid-run; per-
finding commits that already landed stay in git log for review.

```bash
if [[ ! -f "$REVIEW_FIX_PATH" ]]; then
  echo "Warning: REVIEW-FIX.md not written at $REVIEW_FIX_PATH." >&2
  echo "Agent may have failed mid-run; any fix(...) commits already emitted are in git log." >&2
  echo "Check: git log --oneline --grep=\"fix($PADDED)\"" >&2
  exit 1
fi

FIX_STATUS=$(REVIEW_FIX_PATH="$REVIEW_FIX_PATH" node -e "
  const fs = require('node:fs');
  const { extractFrontmatter } = require('./lib/frontmatter.cjs');
  const raw = fs.readFileSync(process.env.REVIEW_FIX_PATH, 'utf-8');
  const { frontmatter } = extractFrontmatter(raw);
  process.stdout.write((frontmatter && frontmatter.status) || '');
" 2>/dev/null)

if [[ -z "$FIX_STATUS" ]]; then
  echo "Warning: REVIEW-FIX.md missing status field in frontmatter." >&2
fi
```

## Commit

**D-21 EXCEPTION TO ADR-0004:** per-finding `fix(...)` commits were
already emitted by `np-code-fixer` during its execution. The agent
also owns the final `docs(...)` commit for REVIEW-FIX.md. This
workflow does NOT re-commit the fix report on the agent's behalf —
routing through `git log --oneline` after the spawn will show the
complete commit chain:

```
docs(10-XX): add code review fix report   <- agent-owned final commit
fix(10-XX): CR-042 rename shadowed var    <- per-finding commit
fix(10-XX): CR-041 add null check          <- per-finding commit
...
```

Fallback path — if the agent wrote REVIEW-FIX.md but did NOT commit it
(e.g., agent crashed between Write and commit), emit the missing docs
commit from the workflow:

```bash
if ! git diff --cached --quiet "$REVIEW_FIX_PATH" 2>/dev/null || \
   git status --porcelain "$REVIEW_FIX_PATH" 2>/dev/null | grep -q .; then
  echo "Note: REVIEW-FIX.md is uncommitted — agent did not emit final docs commit."
  echo "Emitting fallback docs commit from workflow (D-21 fallback path)."
  node np-tools.cjs commit "docs(${PADDED}): add code review fix report" --files "$REVIEW_FIX_PATH"
fi
```

## --auto Iteration Hint

If `--auto` AND FIX_STATUS is `partial`, display a prose directive to
re-run the review + fix cycle. Do NOT shell-out automatically
(ADR-0001 no-daemon, in-session loop only). The downstream user
invokes `/np:code-review $PHASE --auto` → `/np:code-review-fix $PHASE
--auto --iteration=2` etc., capped at 3 per the agent's contract.

```bash
if [[ "$AUTO_MODE" == "true" ]] && [[ "$FIX_STATUS" == "partial" ]]; then
  NEXT=$((ITERATION + 1))
  if [[ $NEXT -le 3 ]]; then
    echo ""
    echo "--auto: fix status=partial. Next iteration ($NEXT/3):"
    echo "  /np:code-review $PHASE --auto"
    echo "  /np:code-review-fix $PHASE --auto --iteration=$NEXT"
  else
    echo ""
    echo "--auto: iteration cap 3 reached with status=partial."
    echo "Remaining issues documented in $REVIEW_FIX_PATH — triage manually."
  fi
fi
```

## Scope Guardrail

<scope_guardrail>
**Do:**
- Spawn `np-code-fixer` exactly once per invocation (single-pass fix).
- Validate REVIEW.md frontmatter schema in Gate 2 BEFORE spawning the
  fixer (T-10-03-06 producer/consumer drift mitigation).
- Let the agent own per-finding `fix(...)` commits (D-21 exception).
- Let the agent own the final `docs(...)` REVIEW-FIX.md commit; this
  workflow's fallback path only fires when the agent skipped it.
- Emit a metrics record AFTER the Task spawn (D-06).
- Resolve MODEL via `np-tools.cjs resolve-model` — no hardcoded IDs.
- Use `np-tools.cjs askuser` for every prompt (INST-03 invariant).
- Short-circuit on REVIEW.md `status: clean | skipped` — no agent
  spawn, no commit, exit 0.
- Route every commit (agent-side or fallback) through
  `np-tools.cjs commit` so the gitignore-guard runs.

**Don't:**
- Auto-run `/np:code-review` from this workflow if REVIEW.md is
  missing — require explicit user intent before producing a review.
- Bundle per-finding fixes into a single commit — atomicity buys
  revertability per finding (D-21).
- Re-emit the docs commit unconditionally — the agent owns it; this
  workflow's fallback only fires on uncommitted REVIEW-FIX.md.
- Shell out to `/np:code-review` or `/np:code-review-fix` recursively
  on `--auto`; the iteration hint is prose, user-driven (ADR-0001).
- Invoke host-specific prompt tools directly — always route through
  `np-tools.cjs askuser`.
- Skip the metrics record block — the Phase-10 np:stats consumer
  expects one record per Task spawn.
</scope_guardrail>

## Output

- `{phase_dir}/{padded}-REVIEW-FIX.md` — agent-owned frontmatter
  (status, findings_in_scope, fixed, skipped, iteration) plus a
  per-finding applied/skipped table with commit hashes.
- 0..N `fix(${PADDED}): <FINDING_ID> <one-line>` commits (one per
  applied finding; D-21 exception to ADR-0004).
- 1 `docs(${PADDED}): add code review fix report` commit for
  REVIEW-FIX.md itself (agent-owned; workflow has a fallback).
- 1 metrics record in `.nubos-pilot/metrics/phase-${PHASE}.jsonl` for
  the single `np-code-fixer` Task spawn.

## Success Criteria

- [ ] REVIEW.md presence verified (explicit error if missing — no
      auto-run of /np:code-review)
- [ ] REVIEW.md frontmatter schema validated
      (files_reviewed_list + status + depth + findings present;
      T-10-03-06 mitigation / Pitfall 2)
- [ ] Short-circuit on REVIEW.md `status: clean | skipped` (exit 0,
      no spawn, no commit)
- [ ] `--fix-scope` validated to critical|warning|info|all (invalid
      warns and falls back to `all`)
- [ ] Existing REVIEW-FIX.md handled via 3-way askuser prompt
- [ ] Agent spawn wrapped in Pattern S-2 metrics block with
      `metrics record` within 30 lines of Task()
- [ ] Per-finding fix commits happen INSIDE np-code-fixer (D-21),
      NEVER re-emitted by this workflow
- [ ] Final REVIEW-FIX.md docs commit happens INSIDE np-code-fixer;
      workflow fallback only fires when agent skipped it
- [ ] `--auto` prints iteration hint (cap 3); does NOT shell-out
      recursively (ADR-0001)

## Related Workflows

- **`/np:code-review <phase>`** — produces the REVIEW.md that this
  workflow consumes. Run it first. Without REVIEW.md this workflow
  exits with an error.
- **`/np:review <phase>`** — cross-AI peer review; orthogonal to the
  code-review/fix pair. Runs a fan-out across external CLIs and does
  not interact with REVIEW.md.

## Platform Notes

<platform_notes>
**Windows:** This workflow uses bash features (arrays, variable
expansion, `jq`, process substitution). On Windows, it requires Git
Bash or WSL. Native PowerShell is not supported.

**`jq` dependency:** Gate 2 pipes the frontmatter JSON through `jq`
for field extraction. `jq` is present on nearly all dev machines
where nubos-pilot runs (it is the same dependency surface the
`/np:execute-phase` workflow relies on). If `jq` is missing, install
via `brew install jq` (macOS) or the distro's package manager.
</platform_notes>
