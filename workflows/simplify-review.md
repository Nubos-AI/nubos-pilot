---
command: np:simplify-review
description: Read-only economy audit of a git diff, the working tree, or the whole repo (--repo) — flags over-engineering, stdlib-reinvention, native-duplication, and shrinkable logic via the np-simplifier agent. Never edits or commits; emits a deletion-oriented report. Manual twin of the Economy critic axis (agents.economy full/ultra).
argument-hint: "[<git-range> | --repo]  (default: working tree + staged vs HEAD)"
---

# /np:simplify-review

<objective>
Catalogue what could be deleted, reused, or condensed in a change set — the "wrote-too-much" review. A read-only `np-simplifier` agent scans the diff against the Economy rubric (`agents/np-critic-economy.md`) and emits one finding per removable construct plus a `net: -<N> lines possible.` summary. This command NEVER edits source and NEVER commits; it hands a report to the user. It is the manual counterpart of the in-loop Economy critic (`/np:execute-phase` with `agents.economy` set to `full` or `ultra`), and both apply the identical rubric and safety boundaries.
</objective>

## Initialize

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
RANGE="$*"
if [[ "$RANGE" == "--repo" || "$RANGE" == "--all" ]]; then
  SCOPE_MODE="repo"
  FILES=$(git ls-files)
  SCOPE_DESC="whole repository (tracked files)"
  if [[ -z "$FILES" ]]; then
    echo "No tracked files in scope ($SCOPE_DESC). Nothing to review."
    exit 0
  fi
elif [[ -n "$RANGE" ]]; then
  SCOPE_MODE="diff"
  DIFF=$(git diff --no-color "$RANGE")
  SCOPE_DESC="$RANGE"
else
  SCOPE_MODE="diff"
  DIFF=$(git diff --no-color HEAD)
  SCOPE_DESC="working tree + staged vs HEAD"
fi
if [[ "$SCOPE_MODE" == "diff" && -z "$DIFF" ]]; then
  echo "No changes in scope ($SCOPE_DESC). Nothing to review."
  exit 0
fi
```

Capture is read-only — neither `git diff` nor `git ls-files` stages, edits, or commits anything. There are two scope modes:

- **diff** (default) — a range (`HEAD~5..HEAD`, a branch name, `--staged`, …) is passed through verbatim; with no argument the scope is uncommitted + staged work against `HEAD`. This is the "review what just changed" mode.
- **repo** (`--repo` / `--all`) — audits the whole tracked tree, not just a diff. `git ls-files` hands the agent the file roster; the agent walks the existing source for standing over-engineering (single-use abstractions, hand-rolled stdlib, duplicated native features, condensable logic) that predates any one change. Slower and noisier than diff mode — use it for a periodic cleanup pass, not every review.

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).** `$LANG_DIRECTIVE` is authoritative for the report's prose and the final summary line. Finding lines (`<file>:L<line>: <tag> …`), file paths, and code snippets stay canonical. Supersedes CLAUDE.md.

## Review

Spawn ONE read-only reviewer — `Agent(subagent_type="np-simplifier", prompt=<…>)`, sonnet by default. The prompt MUST carry:

- `<files_to_read>` listing `agents/np-critic-economy.md` (the canonical rubric — ladder, categories, severity bar, safety boundaries), plus `.nubos-pilot/codebase/INDEX.md` and `.nubos-pilot/RULES.md` when present (stdlib / native-feature / existing-helper context).
- The review scope, by mode:
  - **diff mode** — pass the captured `$DIFF` as the scope; the agent reviews only the changed hunks.
  - **repo mode** — pass `$SCOPE_DESC` plus the `$FILES` roster from `git ls-files`, and instruct the agent to walk the tracked source itself (`Read`/`Grep`/`Glob`) under the same rubric. The agent should skip vendored, generated, and lock files and prioritise the largest hand-written modules. Because there is no diff, findings cite the source line as `<file>:L<line>` from the file it read.
- `$SCOPE_MODE` and `$SCOPE_DESC` so the agent knows whether it is auditing a change set or the standing codebase.
- `$LANG_DIRECTIVE` so the prose follows the project language.

The agent is READ-ONLY (`tools: Read, Bash, Grep, Glob` — no Write/Edit). It returns a plain-text report: one line per finding in the shape `<file>:L<line>: <tag> <what>. <replacement>.` (tags `delete:` / `stdlib:` / `native:` / `shrink:`), ending with `net: -<N> lines possible.` or `Lean already. Ship.`

## Report

Print the agent's report verbatim to the user. Do not edit files, do not stage, do not commit — this command only catalogues. Close with the next-step hint:

```
Reductions are suggestions, not applied. To act on them: edit by hand, or run
/np:execute-phase with agents.economy set to full (or ultra) so the Economy critic
enforces the same bar inside the adversarial loop.
```

## Scope Guardrail

<scope_guardrail>
**Do:**
- Capture the scope read-only — `git diff` in diff mode, `git ls-files` in `--repo` mode (no staging, no `-w` rewrites, no commit).
- Spawn exactly one `np-simplifier` agent; pass it `agents/np-critic-economy.md` as the rubric so the manual command and the in-loop critic never diverge.
- Print the report verbatim; respect `$LANG_DIRECTIVE` for prose only.

**Don't:**
- Edit, stage, or commit anything — this is a read-only audit. No `git add`, no `commit`, no `Write`/`Edit` of source.
- Flag tests, input validation, error handling, security/access-control, or required edge cases as removable (the rubric's safety boundaries; completeness wins over economy).
- Emit low-confidence "could be cleaner" noise — high-confidence, concrete replacements only.
</scope_guardrail>

## Output

- A plain-text economy report to the user (findings + `net: -<N> lines possible.` or `Lean already. Ship.`).
- No filesystem changes, no commits, no state mutation — read-only by contract.

## Definition of Done

This workflow audits a diff for economy and reports. The Definition of Done, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 3 (Do it with tests) — the report NEVER proposes deleting or weakening test code; coverage is completeness, not bloat.
- Rule 5 (Aim to genuinely impress) — every finding cites file, line, the exact construct, and a concrete replacement; no vague "could be simpler" entries.
- Rule 8 (Never present a workaround when the real fix exists) — reductions favour the root-cause-simple form over obscure golfed one-liners.

Any violation = the review is incomplete; surface it and exit non-zero. The orchestrator does not relax these.

## Related Workflows

- **`/np:verify-work <N>`** — correctness/acceptance verification (the orthogonal axis; economy never judges correctness).
- **`/np:execute-phase`** — runs the Economy critic in-loop when `agents.economy` is `full` or `ultra`, enforcing this exact rubric during execution.
