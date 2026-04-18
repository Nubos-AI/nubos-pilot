---
command: np:code-review
description: Source-file review on a completed phase. Reads files_to_read from --files flag or phase SUMMARY.md key_files. Spawns np-code-reviewer (opus) to produce REVIEW.md with critical/warning/info findings at depth quick|standard|deep. One atomic docs commit. Supports --auto flag (chains to /np:code-review-fix after review).
---

# np:code-review

Produces `{phase_dir}/{padded}-REVIEW.md` via a single `np-code-reviewer` (opus)
spawn that reviews phase source files at depth `quick|standard|deep`.
Runs AFTER `/np:execute-phase` has landed code — the audit needs either
a phase `SUMMARY.md` with `key_files:` or an explicit `--files=...`
override to know what to review.

The single Task-spawn site is wrapped in the Plan 09-05 metrics +
resolve-model pattern (D-06, D-01). `RUNTIME` is detected once at the
top of the bash block and re-used by the `metrics record` call. All
interactive prompts route through `np-tools.cjs askuser` per INST-03.

File paths passed via `--files=...` are validated through a
realpath + repo-root-prefix guard (Pitfall 7 / T-10-03-01 mitigation)
to reject path-traversal attempts before they reach the agent.

## Initialize

```bash
PHASE="$1"
if [[ -z "$PHASE" ]]; then
  echo "Usage: /np:code-review <phase-number> [--files=f1,f2] [--depth=quick|standard|deep] [--auto]" >&2
  exit 2
fi

INIT=$(node np-tools.cjs init code-review "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
RUNTIME=$(node -e "console.log(require('./lib/runtime/index.cjs').detect().runtime)")
```

Parse JSON for: `phase`, `padded`, `phase_dir`, `review_path`,
`review_fix_path`, `summary_present`, `summary_path`, `has_review`,
`depth`, `agents.code_reviewer`.

```bash
PADDED=$(echo "$INIT" | jq -r '.padded')
PHASE_DIR=$(echo "$INIT" | jq -r '.phase_dir')
REVIEW_PATH=$(echo "$INIT" | jq -r '.review_path')
SUMMARY_PRESENT=$(echo "$INIT" | jq -r '.summary_present')
SUMMARY_PATH=$(echo "$INIT" | jq -r '.summary_path')
HAS_REVIEW=$(echo "$INIT" | jq -r '.has_review')
DEPTH=$(echo "$INIT" | jq -r '.depth')
PLAN_ID="${PADDED}-code-review"
TASK_ID="${PADDED}-code-review"
```

## Argument Parsing

```bash
FILES_ARG=""
DEPTH_OVERRIDE=""
AUTO_MODE="false"
for arg in "$@"; do
  case "$arg" in
    --files=*) FILES_ARG="${arg#--files=}" ;;
    --depth=*) DEPTH_OVERRIDE="${arg#--depth=}" ;;
    --auto)    AUTO_MODE="true" ;;
  esac
done

if [[ -n "$DEPTH_OVERRIDE" ]]; then
  case "$DEPTH_OVERRIDE" in
    quick|standard|deep) DEPTH="$DEPTH_OVERRIDE" ;;
    *) echo "Warning: invalid --depth='$DEPTH_OVERRIDE' (expected quick|standard|deep). Keeping DEPTH=$DEPTH." >&2 ;;
  esac
fi
```

## Path-Traversal Guard

Every path from `--files=...` is validated against the repository root
before reaching the agent (T-10-03-01 mitigation). `realpath -m` is
preferred for correctness; on macOS without `coreutils` a string-match
fallback is used.

```bash
SAFE_FILES=()
if [[ -n "$FILES_ARG" ]]; then
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
  if [[ -z "$REPO_ROOT" ]]; then
    echo "Error: unable to resolve repository root via 'git rev-parse --show-toplevel'." >&2
    exit 1
  fi
  IFS=',' read -ra FILES_ARR <<< "$FILES_ARG"
  if command -v realpath >/dev/null 2>&1; then
    for F in "${FILES_ARR[@]}"; do
      [[ -z "$F" ]] && continue
      RP=$(realpath -m "$F" 2>/dev/null || true)
      case "$RP" in
        "$REPO_ROOT"/*) SAFE_FILES+=("$F") ;;
        *) echo "Skipping path outside repo: $F" >&2 ;;
      esac
    done
  else
    echo "WARN: realpath not available (macOS users: brew install coreutils). Falling back to string-match guard." >&2
    for F in "${FILES_ARR[@]}"; do
      [[ -z "$F" ]] && continue
      case "$F" in
        */../*|../*|/*) echo "Skipping unsafe path: $F" >&2 ;;
        *) SAFE_FILES+=("$F") ;;
      esac
    done
  fi
fi
```

## Pre-Flight Gates

<pre_flight>

### Gate 1 — SUMMARY.md must exist

A retroactive code review requires a completed phase. If no SUMMARY.md
is present, the phase has not been executed yet and there is nothing to
review.

```bash
if [[ "$SUMMARY_PRESENT" != "true" ]]; then
  echo "Error: Phase $PHASE has no SUMMARY.md at $SUMMARY_PATH." >&2
  echo "The phase must be executed (/np:execute-phase) before it can be reviewed." >&2
  exit 1
fi
```

### Gate 2 — REVIEW.md already exists

If a prior review is present, let the user choose between re-running,
viewing the current review, or skipping.

```bash
if [[ "$HAS_REVIEW" == "true" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Existing REVIEW",
    "question": "REVIEW.md already exists for Phase '"$PHASE"'. What would you like to do?",
    "options": [
      {"label": "Re-run — replace the current review", "description": "Re-runs np-code-reviewer and overwrites the existing file."},
      {"label": "View — display current review and exit", "description": "Reads the file and exits without changes."},
      {"label": "Skip — keep current review and exit", "description": "Leaves the file untouched."}
    ]
  }')
  case "$CHOICE" in
    "View"*) cat "$REVIEW_PATH"; exit 0 ;;
    "Skip"*) exit 0 ;;
  esac
fi
```

### Gate 3 — Determine review scope

Scope precedence: `--files` override (already path-guarded above) wins;
otherwise the phase `SUMMARY.md` frontmatter `key_files:` block is the
source of truth. If neither produces any files, abort with a clear
error — do NOT fall back to an arbitrary git diff. SUMMARY.md is
mandatory per Gate 1 and its `key-files:` block is authoritative.

```bash
if [[ ${#SAFE_FILES[@]} -eq 0 ]]; then
  EXTRACTED=$(SUMMARY_PATH="$SUMMARY_PATH" node -e "
    const fs = require('node:fs');
    const { extractFrontmatter } = require('./lib/frontmatter.cjs');
    const raw = fs.readFileSync(process.env.SUMMARY_PATH, 'utf-8');
    const { frontmatter } = extractFrontmatter(raw);
    const kf = (frontmatter && frontmatter['key-files']) || (frontmatter && frontmatter.key_files) || {};
    const out = [];
    if (Array.isArray(kf.created)) for (const p of kf.created) out.push(String(p));
    if (Array.isArray(kf.modified)) for (const p of kf.modified) out.push(String(p));
    if (out.length) process.stdout.write(out.join('\n'));
  " 2>/dev/null || true)

  if [[ -n "$EXTRACTED" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && SAFE_FILES+=("$line")
    done <<< "$EXTRACTED"
  fi
fi

if [[ ${#SAFE_FILES[@]} -eq 0 ]]; then
  echo "Error: no files to review." >&2
  echo "  Provide --files=f1,f2,... OR add key-files.created / key-files.modified to $SUMMARY_PATH." >&2
  exit 1
fi
```

</pre_flight>

## Philosophy

<philosophy>
A code review is not a bug-finding tool — it is a contract-verification
pass. The reviewer's job is to answer ONE question: did the
implementation deliver against its plan (CLAUDE.md, ADRs, PROJECT
constraints, phase `requirements:`) without introducing critical
defects along the way? Findings are graded critical / warning / info so
downstream `/np:code-review-fix` can gate on severity. A review that
produces a 30-item warning list is usually a planning failure, not an
execution failure — the planner should tighten the spec next round.
Scope is the phase, not the whole repo; the `--files` override exists
for targeted re-reviews after a fix pass, not for repo-wide audits.

**Depth semantics** (resolved via init payload or `--depth=` override):

| Depth | Scope | Typical use |
|-------|-------|-------------|
| `quick` | surface-level: obvious bugs, missing error handling, broken imports | post-fix re-review, large scopes (>50 files) |
| `standard` | default: correctness + security + plan-contract alignment | normal per-phase review |
| `deep` | exhaustive: performance, edge cases, threat-model vs implementation | security-sensitive phases, pre-release audits |

The reviewer agent branches on `$DEPTH` internally; this workflow only
selects which value to pass. `--depth` override beats the init-payload
default (`standard`). Invalid values trigger a warning and keep the
init default rather than crashing — the review should still run.

**Scope precedence** (implemented in the Pre-Flight Gates above):

1. `--files=a,b,c` override (path-guarded) — highest priority
2. SUMMARY.md `key-files.created` + `key-files.modified` (agent-owned
   frontmatter produced by `/np:execute-phase`)
3. Error — no fall-through to git diff. A git-diff fallback would
   produce noisy reviews of unrelated files; the SUMMARY.md
   `key-files:` contract from Phase 9 plan-phase → Phase 9
   execute-phase is authoritative.
</philosophy>

## REVIEW.md Frontmatter Contract

The reviewer agent (`np-code-reviewer`) owns the REVIEW.md frontmatter.
The workflow does NOT author or mutate that block. This workflow's
contract is: (1) ensure the agent has the right input, (2) commit the
output file atomically. The agent contract is documented in
`agents/np-code-reviewer.md`; the keys most relevant to the
downstream `/np:code-review-fix` consumer are:

- `status: clean | issues_found | skipped` — drives fix-workflow gate
- `depth: quick | standard | deep` — echoes the value this workflow passed
- `files_reviewed: N` and `files_reviewed_list: [f1, f2, …]` — enables
  scope-persistence across `--auto` re-review iterations
- `findings.critical / findings.warning / findings.info` counts + bodies

If the agent produces a file without these keys, the commit still
proceeds (the workflow is not a schema validator), but
`/np:code-review-fix` will refuse to consume it — that workflow's FM
gate is the defense-in-depth layer (T-10-03-06 mitigation).

## Main Flow

Single serial spawn — the reviewer is self-contained (file reading,
finding severity, REVIEW.md writing all happen inside
`np-code-reviewer`). The agent writes `REVIEW_PATH` with its own
frontmatter schema (agent-owned, not workflow-owned). See
`agents/np-code-reviewer.md` for the REVIEW.md FM contract.

### Step 1 — Code reviewer (np-code-reviewer, opus)

```bash
START=$(node np-tools.cjs metrics start-timestamp)
MODEL=$(node np-tools.cjs resolve-model np-code-reviewer --profile balanced)
FILES_JSON=$(printf '%s\n' "${SAFE_FILES[@]}" | node -e '
  const chunks = [];
  process.stdin.on("data", (d) => chunks.push(d));
  process.stdin.on("end", () => {
    const lines = Buffer.concat(chunks).toString("utf-8").split("\n").filter((l) => l.length > 0);
    process.stdout.write(JSON.stringify(lines));
  });
')
# Spawn agent=np-code-reviewer model=$MODEL
#   input: files_to_read=$FILES_JSON (JSON array, whitespace-safe),
#          review_path=$REVIEW_PATH, depth=$DEPTH,
#          phase_dir=$PHASE_DIR, summary_path=$SUMMARY_PATH
#   output: $REVIEW_PATH with agent-owned REVIEW.md frontmatter
#           (status, depth, files_reviewed, files_reviewed_list,
#           findings.{critical,warning,info}, total)
Task(
  subagent_type="np-code-reviewer",
  model="$MODEL",
  prompt="<files_to_read>$FILES_JSON</files_to_read><config>phase=$PHASE,phase_dir=$PHASE_DIR,review_path=$REVIEW_PATH,depth=$DEPTH,summary_path=$SUMMARY_PATH</config>"
)
END=$(node np-tools.cjs metrics end-timestamp)
node np-tools.cjs metrics record \
  --agent np-code-reviewer --tier opus --resolved-model "$MODEL" \
  --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
  --started "$START" --ended "$END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count 0 --status ok --runtime "$RUNTIME"
```

## Validation Gate

After the reviewer finishes, verify REVIEW.md was written. If the file
is missing, the spawn failed silently and the user is prompted to
re-run or abort.

```bash
if [[ ! -f "$REVIEW_PATH" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "REVIEW.md missing",
    "question": "np-code-reviewer did not write REVIEW.md. What would you like to do?",
    "options": [
      {"label": "Re-run np-code-reviewer", "description": "Spawn the reviewer once more."},
      {"label": "Abort",                   "description": "Exit without committing."}
    ]
  }')
  case "$CHOICE" in
    "Abort") exit 1 ;;
  esac
fi
```

## Commit

```bash
node np-tools.cjs commit "docs(${PADDED}): add code review report" --files "$REVIEW_PATH"
```

## --auto Chain Hint

If `--auto` was passed, display a prose directive to the user — the
follow-up `/np:code-review-fix` invocation stays explicit (in-session
loop, no daemon per ADR-0001; cross-workflow chaining is the
`/np:execute-phase` orchestrator's concern, not this workflow's).

```bash
if [[ "$AUTO_MODE" == "true" ]]; then
  echo ""
  echo "--auto flag set. Next step: /np:code-review-fix $PHASE --auto"
  echo "  (re-runs review + fix until clean OR iteration cap 3 reached)"
fi
```

## Scope Guardrail

<scope_guardrail>
**Do:**
- Run `np-code-reviewer` exactly once per invocation (single-pass review).
- Emit a metrics record AFTER the Task spawn (D-06).
- Resolve MODEL via `np-tools.cjs resolve-model` — no hardcoded IDs.
- Use `np-tools.cjs askuser` for every prompt (INST-03 invariant).
- Validate `--files` paths through realpath + repo-root-prefix BEFORE
  passing them to the agent (T-10-03-01 path-traversal mitigation).
- Route the final commit through `np-tools.cjs commit` so
  `lib/git.cjs.assertCommittablePaths()` runs the gitignore-guard.
- Abort early when SUMMARY.md is missing; retroactive reviews are only
  meaningful against executed phases.

**Don't:**
- Spawn any additional agent beyond `np-code-reviewer`; the fix pass
  is a separate workflow (`/np:code-review-fix`) per atomic-commit
  discipline (ADR-0004, D-21 exception lives inside that workflow).
- Invoke host-specific prompt tools directly — always route through
  `np-tools.cjs askuser`.
- Shell out to `/np:code-review-fix` automatically on `--auto`; that
  would nest workflows and violate the atomic-commit model.
- Skip the metrics record block — the Phase-10 np:stats consumer
  expects one record per Task spawn.
- Use a git-diff fallback for scope; SUMMARY.md `key-files:` is the
  single source of truth (Gate 3).
</scope_guardrail>

## Platform Notes

<platform_notes>
**macOS:** `realpath -m` requires GNU coreutils. Install via
`brew install coreutils` if the path-traversal guard warns about
"realpath not available". The string-match fallback still rejects
obvious escapes (`../`, absolute paths) but cannot canonicalize
symlinks, so valid relative paths with traversal-like components may
also be rejected — prefer absolute paths under the repo root if the
fallback rejects a legitimate file.

**Windows:** This workflow uses bash features (arrays, process
substitution). On Windows, it requires Git Bash or WSL. Native
PowerShell is not supported.
</platform_notes>

## Output

- `{phase_dir}/{padded}-REVIEW.md` — agent-owned frontmatter (status,
  depth, files_reviewed, files_reviewed_list, findings summary) plus
  severity-grouped finding bodies.
- 1 metrics record in `.nubos-pilot/metrics/phase-${PHASE}.jsonl` for
  the single `np-code-reviewer` Task spawn.
- One git commit when REVIEW.md is produced successfully.

## Success Criteria

- [ ] Phase validated via init payload before any agent spawn
- [ ] `--files` paths validated through realpath + repo-root-prefix
      (T-10-03-01 mitigation) before being passed to the agent
- [ ] File scope resolved from `--files` override OR SUMMARY.md
      `key-files:` — no git-diff fallback
- [ ] Existing REVIEW.md handled via 3-way askuser prompt (Re-run /
      View / Skip)
- [ ] Depth resolved with validation (quick|standard|deep); invalid
      `--depth=...` warns and keeps the init-payload default
- [ ] Empty scope results in explicit error (no silent agent spawn)
- [ ] Agent spawn wrapped in Pattern S-2 metrics block (D-06) with
      `metrics record` within 30 lines of the Task() call (Pitfall 9)
- [ ] `metrics record` includes `--runtime "$RUNTIME"` resolved at the
      top of the bash block via `lib/runtime/index.cjs.detect()`
- [ ] REVIEW.md missing after spawn triggers askuser Re-run / Abort
- [ ] Final commit routed through `np-tools.cjs commit` so
      `lib/git.cjs.assertCommittablePaths()` enforces the
      gitignore-guard (T-10-03-05 defense-in-depth)
- [ ] `--auto` flag prints a prose hint; it does NOT auto-invoke
      `/np:code-review-fix` (no-daemon invariant ADR-0001)

## Related Workflows

- **`/np:code-review-fix <phase> [--auto]`** — consumes REVIEW.md,
  spawns `np-code-fixer` (sonnet), emits per-finding fix commits
  inside the agent (D-21 exception to ADR-0004), then the final
  REVIEW-FIX.md docs commit. The `--auto` iteration loop (capped at
  3) re-reviews the same `files_reviewed_list` across iterations so
  scope is preserved.
- **`/np:review <phase>`** — cross-AI peer review that fans out a
  phase-scoped prompt to every installed external CLI
  (gemini/claude/codex/coderabbit/opencode/qwen/cursor) and
  concatenates their outputs into REVIEWS.md. Complementary to
  code-review: that workflow asks the agent "did the code deliver
  against the plan"; `/np:review` asks external AIs "would the plan
  itself hold up to adversarial review".
- **`/np:ui-review <phase>`** — 6-pillar UI audit (copy, visual,
  color, typography, spacing, experience). Spawns `np-ui-auditor`
  (haiku). Orthogonal to code-review; run both on any UI phase.
- **`/np:secure-phase <phase>`** and **`/np:validate-phase <phase>`**
  (Phase 10 Plan 10-04) — threat-model and test-coverage audits
  respectively. Chain after code-review for security-sensitive
  phases.

## Design Notes

No git-diff Tier-3 fallback: Phase 9 execute-phase guarantees a
populated `key-files:` block in every SUMMARY.md, making a git-diff
scope superfluous and noisy. No config-gate short-circuit: the
workflow is invoked explicitly by the user, so a flag to "skip when
invoked" would be redundant. Frontmatter-schema validation is
delegated to the downstream `/np:code-review-fix` FM-gate, which
refuses to consume a malformed REVIEW.md — this workflow's commit
step is intentionally permissive so agent issues surface as
reviewable diffs rather than hidden skips.
