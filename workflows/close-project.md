---
command: np:close-project
description: Aggregate verification of every milestone in the project. Runs the verifier on each M<NNN>, writes PROJECT-SUMMARY.md, and sets project_status=completed in roadmap.yaml when all milestones pass.
argument-hint: 
---

# /np:close-project

<objective>
Project-level closing step. Aggregates every milestone's `M<NNN>-VERIFICATION.md` and `M<NNN>-VALIDATION.md`, reports blockers, and on success records `project_status: completed` in `.nubos-pilot/roadmap.yaml` plus a flat `PROJECT-SUMMARY.md`. The project is then eligible for archive via `/np:new-project` (archive-then-init flow) or via `archive-project do`.

This workflow is the answer to "verify every milestone at the end of the project" — it is the single sammelcheck. Per-milestone verification still happens at execution time via `/np:verify-work <N>` and `/np:validate-phase <N>`; this workflow does not re-run them, it aggregates their output.
</objective>

## Initialize

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT=$(node .nubos-pilot/bin/np-tools.cjs init close-project)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative. Obey it for user-facing output, askuser prompts, and any prose in `PROJECT-SUMMARY.md`. Milestone IDs, SC ids, file paths, and YAML keys stay canonical English. Supersedes CLAUDE.md.

Parse JSON for: `project_exists`, `completion.status`, `completion.milestones[]`, `completion.blockers[]`, `summary_path`, `text_mode`, `text_mode_source`.

**Askuser routing.** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below is a spec, not a literal command. Pick the path once at Initialize:
- **Claude Code** (native `AskUserQuestion` tool is available): parse the JSON spec and call `AskUserQuestion` directly. `select` → `multiSelect: false`; `multiselect` → `multiSelect: true`; `confirm` → `options: [{label: "Yes"}, {label: "No"}]`; `input` → ask free-form in chat. Use a short `header` (≤12 chars).
- **`text_mode == true`** (INIT payload): skip every askuser block and render questions as plain-text numbered lists. Opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.
- **Other runtime with TTY** (Codex, Gemini, …): execute the shell `askuser` block verbatim.

## Pre-Flight

If `project_exists == false`, hard-stop:

```bash
echo "[np:close-project] No PROJECT.md found — nothing to close." >&2
exit 1
```

## Aggregate report

Render the completion status to the main chat. Each milestone gets one block:

```
M001 — <name>
  Verification: <verified|failed|deferred|missing> — <sc_count> SC, <failed> failed, <pending> pending
  Validation:   <missing|N uncovered, N under-sampled>
  Roadmap:      <done|pending>
```

Followed by:

```
Blockers (<N>):
  - M001: 1 SC failed
  - M003: VALIDATION.md missing
  …
```

If `completion.status == complete` and `completion.blockers` is empty, jump to **Write summary**. Otherwise:

## Resolve blockers

For each blocker, give the user a targeted ask:

- `M<NNN>: VERIFICATION.md missing` → suggest `/np:verify-work <NNN>`.
- `M<NNN>: VALIDATION.md missing` → suggest `/np:validate-phase <NNN>`.
- `M<NNN>: N SC failed` → load `M<NNN>-VERIFICATION.md`, list the failing SCs, ask the user to either fix the code (re-spawn execute-phase) or accept the failure via askuser.
- `M<NNN>: N requirement(s) UNCOVERED` → suggest re-running `/np:validate-phase <NNN>` after adding tests.

Use askuser to confirm whether the user wants to proceed (with blockers recorded) or abort:

```bash
CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "select",
  "header": "Close project?",
  "question": "Es gibt Blocker. Wie möchtest du fortfahren?",
  "options": [
    {"label": "Abort",                  "description": "Aktuelle Blocker zuerst beheben (empfohlen)."},
    {"label": "Close with blockers",    "description": "PROJECT-SUMMARY.md schreibt Blocker-Liste; project_status bleibt active."},
    {"label": "Force complete",         "description": "project_status=completed setzen trotz Blocker. Im Manifest forced=true."}
  ]
}')
```

Map the choice:
- `Abort` → `exit 1`
- `Close with blockers` → summary only, **do not** mark completed → use `write-summary` below, and stop there.
- `Force complete` → full close with `--force` (recorded as `forced=true` in the manifest when archived).

## Ask about archiving — before running anything

Closing and archiving used to be separate invocations, which is why projects routinely got closed and never archived. Decide it here, while nothing has been written yet:

```bash
ARCHIVE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "confirm",
  "header": "Archive?",
  "question": "Projekt nach dem Abschluss archivieren? Verschiebt PROJECT.md, ROADMAP.md, milestones/, notes/, metrics/, checkpoints/ und PROJECT-SUMMARY.md nach .nubos-pilot/archive/. memory/, config.json, state/ und bin/ bleiben live."
}')
```

## Close

One verb, one invocation. It runs summary → mark-completed → archive in the only order that works, because the archiver moves `PROJECT-SUMMARY.md` and therefore needs it written first:

```bash
node .nubos-pilot/bin/np-tools.cjs close-project close        # No to archiving
node .nubos-pilot/bin/np-tools.cjs close-project close --archive   # Yes
```

Add `--force` when the user chose `Force complete`. Other flags: `--carry-over a,b` / `--no-carry-over` (defaults carry `knowledge/learnings.json` + `knowledge/solutions`), `--allow-unknown` (see the failure note below).

`close` re-checks blockers itself and refuses with `close-project-blocked` unless `--force` was passed, writing nothing on refusal. Unknown or valueless flags are rejected rather than ignored, so a typo cannot silently skip the archive.

**Exit codes.** A clean run exits 0. If the archive step fails, the command writes its full JSON payload to stdout (`closed: true`, `archived: false`, `archive_error`) and **exits non-zero**. Do not treat that as a failed close — read the payload. The close stands: summary written, `project_status: completed`. Report `archive_error` verbatim, tell the user to retry with `archive-project do` once resolved, and do **not** re-run `close` or flip `project_status` back. The most common cause is `archive-unknown-state-artifact`: the project holds a top-level entry under `.nubos-pilot/` that the archiver does not classify; it must be added to `ARCHIVED_ITEMS` or `PRESERVED_TOP_LEVEL`, or waived with `--allow-unknown`.

## Granular verbs (fallback only)

`write-summary` and `mark-completed` run the two halves separately. Use `write-summary` alone for the `Close with blockers` branch — it is the only verb that writes nothing but the summary.

`mark-completed` applies the same blocker gate as `close` and refuses with `close-project-blocked` unless `--force` is passed. Prefer `close`, which also writes the summary in the right order; reach for `mark-completed` only when the summary already exists and just the status flip is missing.

```bash
node .nubos-pilot/bin/np-tools.cjs close-project write-summary
node .nubos-pilot/bin/np-tools.cjs close-project mark-completed [--force]
```

## Output

- `.nubos-pilot/PROJECT-SUMMARY.md` written.
- (on success) `roadmap.yaml.project_status = completed`.
- User sees the aggregate report + next-step suggestion:

```
Project closed.

Summary: .nubos-pilot/PROJECT-SUMMARY.md
Status:  <complete|complete-with-blockers>
Next:
  - close-project close --archive   (close + archive in one step, asks first)
  - /np:new-project to scaffold a successor (will offer to archive this one)
  - or archive-project do   (carries knowledge/learnings.json + knowledge/solutions by default)
```

When `--archive` ran, additionally report `archive.archive_dir` and — if non-empty — `archive.skipped_unknown`, so an `--allow-unknown` run never silently leaves artefacts behind.

## Scope Guardrail

**Do:** read every M<NNN> VERIFICATION/VALIDATION, render aggregate, write `PROJECT-SUMMARY.md`, optionally flip `project_status`, and archive **only** when the user explicitly answered Yes to the archive question.
**Don't:** re-run `verify-work` or `validate-phase` (those are separate workflows); never modify milestone artefacts; never archive unasked — no `--archive` on the user's behalf, no `archive-project do` as a "cleanup" step.

## Definition of Done

This workflow exits successfully only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 1 (Do the whole thing) — every milestone in `roadmap.yaml` is represented in `PROJECT-SUMMARY.md` (no skipped milestones).
- Rule 5 (Genuinely impress) — blockers are surfaced verbatim with file paths so the user can fix them deterministically; no "good enough" silent passes.
- Rule 10 (Test before shipping) — `project_status: completed` is only set when no blocker remains OR the user explicitly chose Force complete, in which case the archive manifest records `forced=true` and the real `blockers_at_archive`; a forced close is never laundered into a clean one.
- Rule 11 (Ship the complete thing) — `PROJECT-SUMMARY.md` is fully populated on exit; no `_TBD` placeholders. When the user chose to archive, the archive is complete too: a non-empty `skipped_unknown` is reported to the user, never swallowed, and a failed archive is surfaced with its error code rather than reported as a clean close.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
