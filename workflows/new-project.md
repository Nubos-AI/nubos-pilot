---
command: np:new-project
description: Greenfield project scaffold — scans existing workspace, runs bootstrap interview (5 questions), scaffolds the baseline artifacts, then chains into obligatory project discovery and initial codebase scan.
argument-hint: [--apply <answers.json>]
---

# np:new-project

Initialize a new nubos-pilot project in five phases:

1. **Phase -1 — Detect & Archive** (when `.nubos-pilot/PROJECT.md` already exists, offer archive-then-init)
2. **Phase 0 — Workspace Scan** (context capture)
3. **Phase 1 — Bootstrap Interview** (5 structural questions → scaffold with M001)
4. **Phase 2 — Project Discovery** (obligatory, chains into `np:discuss-project --bootstrap`)
5. **Phase 3 — Additional Milestones** (AI proposes from Discovery, user reviews; appends M002, M003, …)

Optionally runs an initial codebase scan at the end when the workspace
contains existing source (`np:scan-codebase`). Everything lands under
`.nubos-pilot/`; no source files are ever modified.

## Philosophy

<philosophy>
The most leveraged moment in any project is the first interview, and the
first interview must be grounded in what actually exists. A bare interview
produces generic PROJECT.md stubs; a grounded one captures the specific
project under specific constraints. This workflow therefore scans *first*,
uses the scan to enrich the interview, and then makes the deeper
discovery step obligatory — no more jumping into phases with a skeleton
PROJECT.md.

Runtime-agnostic throughout: scanner is deterministic Node code; interview
uses the askuser gateway; discovery is delegated to `np:discuss-project`
which dispatches the documenter agent through whatever host is active.
</philosophy>

## Scope Guardrail

<scope_guardrail>
This workflow ONLY touches `.nubos-pilot/` and creates its first phase
directory. It NEVER:

- modifies files outside `.nubos-pilot/`
- writes when `.nubos-pilot/PROJECT.md` already exists **unless** the
  user has explicitly chosen "archive current, scaffold new" via the
  Phase -1 askuser gate (the existing project is moved to
  `.nubos-pilot/archive/<slug>-<YYYYMMDD>/`, not overwritten)
- mutates application source code
- spawns long-running tasks without user consent (batched codebase scan
  offers pause between batches)
</scope_guardrail>

## Downstream Awareness

<downstream_awareness>
This workflow writes:
- `.nubos-pilot/PROJECT.md` (section bodies later filled by discovery)
- `.nubos-pilot/REQUIREMENTS.md` (REQ-01 placeholder)
- `.nubos-pilot/roadmap.yaml` (schema_version: 2, first milestone M001 with empty slices[])
- `.nubos-pilot/STATE.md`
- `.nubos-pilot/milestones/M001/{M001-CONTEXT.md, M001-ROADMAP.md, M001-META.json}`
- (optional) `.nubos-pilot/milestones/M002/ …` via Phase 3 AI-proposed
  review (or the manual bulk-loop fallback)
- (optional) `.nubos-pilot/codebase/` via chained `np:scan-codebase`

`np:discuss-project` (Phase 2) chains automatically — not skippable.
Phase 3 reads populated PROJECT.md + REQUIREMENTS.md, proposes a
milestone sequence, and lets the user accept / edit / discard before any
write. Each accepted milestone is delegated to the `new-milestone`
subcommand, which auto-numbers M<NNN> and honors the D-29 invariant
(PROJECT.md is never rewritten). Phase 3 skips cleanly when PROJECT.md
still has `_TBD` placeholders.
`np:scan-codebase` chains when the workspace contains >= 1 source file.
</downstream_awareness>

## Phase -1: Detect & Archive

Before scanning or interviewing, ask the tool whether a project already
exists in this workspace. If yes, decide whether to archive it first or
abort.

```bash
DETECT=$(node .nubos-pilot/bin/np-tools.cjs init new-project --detect)
if [[ "$DETECT" == @file:* ]]; then DETECT=$(cat "${DETECT#@file:}"); fi
EXISTS=$(echo "$DETECT" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const p=JSON.parse(s);process.stdout.write(String(p.detection && p.detection.existing_project===true))})')
STATUS=$(echo "$DETECT" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const p=JSON.parse(s);process.stdout.write(String((p.detection&&p.detection.completion&&p.detection.completion.status)||"no-project"))})')
```

`STATUS` must be bound here. It gates the force-archive branch below, and an unbound
`STATUS` makes that branch unconditional — every archive then runs `--force`, which also
silently bypasses the active-worktree guard.

If `EXISTS == "false"`, skip the rest of this phase and proceed to Phase 0.

If `EXISTS == "true"`, parse `detection.completion.status`
(`complete | incomplete | no-project`) and `detection.completion.blockers[]`.
Render a short summary:

```
A project already exists in .nubos-pilot/ — <project_name>.
  Status:     <complete|incomplete>
  Milestones: <N> (<M verified, K with blockers>)
  Blockers:   <first 3 blockers, then "…N more">
```

Then askuser for direction:

```bash
CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "select",
  "header": "Existing project",
  "question": "Wie möchtest du fortfahren?",
  "options": [
    {"label": "Archive and start fresh",        "description": "Aktuelles Projekt nach archive/<slug>-<date>/ verschieben, dann neu scaffolden."},
    {"label": "Close project first, then ask",  "description": "Erst /np:close-project ausführen (Aggregat-Verifikation), danach neu fragen."},
    {"label": "Abort",                          "description": "Nichts ändern. /np:new-milestone falls nur ein neuer Milestone gebraucht wird."}
  ]
}')
```

Map the choice:

- `Abort` → `exit 0` with hint `/np:new-milestone` if user wants an extension instead.
- `Close project first` → run `/np:close-project`, then re-run `/np:new-project` from the top.
- `Archive and start fresh` → if `completion.status != complete`, warn and confirm:

  ```bash
  if [[ "$STATUS" != "complete" ]]; then
    WARN=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
      "type": "confirm",
      "header": "Archive incomplete?",
      "question": "Projekt ist nicht abgeschlossen — trotzdem archivieren?"
    }')
    [[ "$WARN" =~ ^([Yy]([Ee][Ss])?|[Jj][Aa]?|[Tt]rue|1)$ ]] || exit 0
    FORCE_FLAG="--force"
  fi

  node .nubos-pilot/bin/np-tools.cjs archive-project do $FORCE_FLAG
  ```

  Carry-over is on by default: `knowledge/learnings.json` and
  `knowledge/solutions` are copied into the archive AND kept in
  `.nubos-pilot/`, so the new project starts with the old project's
  institutional knowledge. Do not pass `--carry-over` to get this — the
  defaults already do it, and an explicit path that matches nothing now
  refuses with `archive-carry-not-found` rather than silently dropping the
  store. Use `--no-carry-over` to start truly green, or
  `--carry-over <state-dir-relative-path>,...` to override the set.
  Memory records (`memory/`) need no carry-over at all: `memory/` is preserved
  in place (never moved into the archive), so the new project keeps reading the
  same vector store.

After a successful archive, continue with Phase 0 in a fresh workspace.

## Phase 0: Workspace Scan

Probe the workspace for context before asking anything:

```bash
SCAN=$(node .nubos-pilot/bin/np-tools.cjs workspace-scan --summary --batch-size 1000)
```

Show findings to the user and offer pre-filled suggestions:

```
Workspace inventory:
- Files: <file_count>
- Top languages: <top 3>
- Manifests found: <list>
- README detected: <yes/no>
- Git repo: <yes/no, N commits>

I can suggest defaults from this scan. Review and adjust.
```

Use the scan to propose:
- `project_name` — from directory basename; edit if off
- `primary_constraints` — derived from manifests (e.g. "Node 22" from
  `package.json.engines.node`)
- `core_value` — best-effort extraction from README first paragraph

## Phase 1: Bootstrap Interview

The 5 structural questions. All prompts go through the askuser gateway.

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT=$(node .nubos-pilot/bin/np-tools.cjs init new-project)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative. Obey it for all askuser prompt texts,
user-facing output, and any narrative prose written into PROJECT.md /
REQUIREMENTS.md (field names and YAML keys stay canonical English).
Supersedes CLAUDE.md.

**Askuser routing.** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below is a spec, not a literal command. Pick the path once at Initialize:
- **Claude Code** (native `AskUserQuestion` tool is available): parse the JSON spec and call `AskUserQuestion` directly. `select` → `multiSelect: false`; `multiselect` → `multiSelect: true`; `confirm` → `options: [{label: "Yes"}, {label: "No"}]`; `input` → ask free-form in chat. Use a short `header` (≤12 chars).
- **`text_mode == true`** (INIT payload): skip every askuser block and render questions as plain-text numbered lists. Opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.
- **Other runtime with TTY** (Codex, Gemini, …): execute the shell `askuser` block verbatim.

```bash
ANS_PROJECT_NAME=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","question":"Project name?"}')
ANS_CORE_VALUE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","question":"Core value — one sentence that must stay true if everything else fails?"}')
ANS_CONSTRAINTS=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","question":"Primary constraints (comma-separated)?"}')
ANS_FIRST_MS=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","question":"First milestone name?"}')
ANS_FIRST_PHASE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","question":"First phase name?"}')
```

When Phase 0 produced a suggestion, include it as the prompt default in
the askuser call (e.g. `"question":"Project name? (suggested: T-AI)"`).

## Apply scaffold

Write the five answers to a tmp JSON file and call the subcommand:

```bash
ANSWERS=$(mktemp -t np-new-project-answers.XXXXXX)
trap 'rm -f "$ANSWERS"' EXIT

node -e '
  const fs = require("fs");
  fs.writeFileSync(process.env.ANSWERS, JSON.stringify({
    project_name: process.env.ANS_PROJECT_NAME,
    core_value: process.env.ANS_CORE_VALUE,
    primary_constraints: process.env.ANS_CONSTRAINTS,
    first_milestone_name: process.env.ANS_FIRST_MS,
    first_phase_name: process.env.ANS_FIRST_PHASE,
  }));
' ANSWERS="$ANSWERS" \
  ANS_PROJECT_NAME="$ANS_PROJECT_NAME" ANS_CORE_VALUE="$ANS_CORE_VALUE" \
  ANS_CONSTRAINTS="$ANS_CONSTRAINTS" ANS_FIRST_MS="$ANS_FIRST_MS" \
  ANS_FIRST_PHASE="$ANS_FIRST_PHASE"

node .nubos-pilot/bin/np-tools.cjs init new-project --apply "$ANSWERS"
```

The six discovery-related PROJECT.md fields (`project_description`,
`domain_text`, `target_users_text`, `non_goals_text`,
`success_criteria_text`, `strategic_decisions_text`) are written as
`_TBD — filled by /np:discuss-project._` placeholders. Phase 2 fills them.

## Re-Init Guard

Phase -1 has already handled the existing-project case via archive. If
`--apply` still fails with `project-already-initialized` (race or
manual edit), the user must resolve it before retrying:

```bash
set +e
node .nubos-pilot/bin/np-tools.cjs init new-project --apply "$ANSWERS"
APPLY_STATUS=$?
set -e

if [ "$APPLY_STATUS" -ne 0 ]; then
  CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Re-init blocked",
    "question": "PROJECT.md ist seit Phase -1 wieder aufgetaucht. Wie weiter?",
    "options": [
      {"label": "Abort",                       "description": "Empfohlen. Konflikt erst manuell auflösen."},
      {"label": "Archive again",               "description": "archive-project do --force ausführen, dann erneut --apply."}
    ]
  }')
  case "$CHOICE" in
    *Archive*)
      node .nubos-pilot/bin/np-tools.cjs archive-project do --force
      node .nubos-pilot/bin/np-tools.cjs init new-project --apply "$ANSWERS"
      ;;
    Abort)
      echo "[np:new-project] aborted per user choice — resolve the PROJECT.md conflict manually, then re-run." >&2
      exit 1
      ;;
    *)
      echo "[np:new-project] unrecognised answer: '$CHOICE' — aborting rather than guessing at a re-init strategy." >&2
      exit 1
      ;;
  esac
fi
```

## Phase 2: Project Discovery (MANDATORY — no skip path)

> **ACTION CONTRACT — Phase 2 is not optional and has no "exit later" branch that lets downstream phases run cleanly.**
>
> Execute EXACTLY:
>
> 1. **Chain into `/np:discuss-project --bootstrap`:**
>    ```bash
>    BOOTSTRAP=1 /np:discuss-project
>    ```
>    User answers the six adaptive discovery questions (Target Users, Domain, What-This-Is, Non-Goals, Success Criteria, Strategic Decisions), reviews proposed requirements, ends with a fully populated PROJECT.md.
>
> 2. **IF the user attempts to exit mid-discovery, surface this exact warning via `askuser`:**
>    ```
>    PROJECT.md still has _TBD placeholders. Downstream phases (/np:discuss-phase,
>    /np:plan-phase, /np:execute-phase) will treat the project as under-specified.
>    Continue discovery? (yes / no, I will finish later)
>    ```
>
> 3. **IF the user picks "no, I will finish later":**
>    - Record `phase_2_skipped: true` + timestamp in STATE.md so `/np:next` reminds them on every resume.
>    - Emit a non-zero workflow exit with the user-facing message: `"Phase 2 skipped — re-run /np:new-project to resume discovery before any /np:discuss-phase call."`
>    - DO NOT continue to Phase 3. Discovery output is the prerequisite for milestone proposal; running Phase 3 with `_TBD` placeholders generates garbage milestones.
>
> 4. **IF the user picks "yes" (continue):** loop back to Step 1 of this contract until PROJECT.md has zero `_TBD` markers.

## Phase 3: Additional Milestones (AI-proposed, user-reviewed)

After Discovery, PROJECT.md and REQUIREMENTS.md are populated — this is
the richest context the workflow will ever have about the project. Use it:
the AI proposes a milestone sequence (M002, M003, …) derived from
Discovery, the user reviews, and accepted milestones are appended via the
`new-milestone --apply` subcommand. Each appended milestone starts empty
(`slices: []`) and is discussed/planned later via `/np:discuss-phase <N>`
and `/np:plan-phase <N>`.

### Step 3.1 — Skip guard

Phase 3 depends on populated Discovery content. If PROJECT.md still
contains `_TBD — filled by /np:discuss-project._` placeholders, skip
Phase 3 with a clear hint:

```bash
PROJECT_MD=".nubos-pilot/PROJECT.md"
if grep -q "_TBD — filled by /np:discuss-project._" "$PROJECT_MD"; then
  echo "Phase 3 skipped — PROJECT.md has unfilled sections. Finish /np:discuss-project, then append milestones via /np:new-milestone."
  MILESTONES_APPENDED=()
else
  # Step 3.2 onward …
fi
```

### Step 3.2 — Propose milestone sequence

Read `.nubos-pilot/PROJECT.md` and `.nubos-pilot/REQUIREMENTS.md` in full.
Derive a proposed milestone breakdown grounded in Discovery:

- **Anchor on Success Criteria** — each major success criterion maps to
  at least one milestone.
- **Respect Non-Goals** — never propose a milestone that crosses a
  declared Non-Goal.
- **Honor Strategic Decisions** — reflected in ordering / `depends_on`
  (e.g. "infra before features" → infra milestone first).
- **Target 3–6 milestones.** Pick a count that matches project scope;
  don't pad, don't hand-wave. A tiny project can legitimately have 0
  additional milestones (M001 is enough); say so explicitly in that case.
- **One clear goal per milestone**, one sentence, shippable as a unit.

Render the proposal in the main chat (NOT via askuser) so the user sees
the full list at once:

```
Based on PROJECT.md + REQUIREMENTS.md I propose these milestones
in addition to M001 — <first_milestone_name>:

  [1] <name> — <goal>
  [2] <name> — <goal>
  [3] <name> — <goal>
  …

Reasoning:
  - <name 1>: anchored in success criterion "<excerpt>"
  - <name 2>: …
```

If the AI concludes no further milestones are warranted, state that
explicitly and skip to Step 3.5 with an empty acceptance list.

### Step 3.3 — User review

```bash
REVIEW_CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "select",
  "question": "How do you want to proceed with the proposed milestones?",
  "options": [
    "Accept all as proposed",
    "Edit individually (accept/edit/remove per item)",
    "Discard proposal and enter my own list",
    "Keep only M001"
  ]
}')
```

Routing:

- **Accept all** → `ACCEPTED` = full proposal, unchanged.
- **Edit individually** → iterate over proposals; for each ask
  `select` with options `Accept`, `Edit name/goal`, `Remove`. On `Edit`,
  two follow-up `input` prompts collect the revised name and goal
  (pre-filled via `prompt` default with the proposed value).
- **Discard proposal** → fall through to the legacy bulk-loop (Step 3.4b)
  exactly as it existed before Phase-3-AI.
- **Keep only M001** → `ACCEPTED` = empty, skip to Step 3.5.

After any of the first three paths, offer the bulk-loop as an optional
top-up:

```bash
ADD_MORE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "confirm",
  "question": "Add further milestones manually beyond the reviewed list?",
  "default": false
}')
```

### Step 3.4a — Apply accepted proposals

For each entry in `ACCEPTED` (AI-proposed + any user-revised), call
`new-milestone --apply` with a tmp answers file. Identical contract to
`/np:new-milestone`:

```bash
MILESTONES_APPENDED=()
for idx in "${!ACCEPTED_NAMES[@]}"; do
  MS_ANSWERS=$(mktemp -t np-new-project-ms.XXXXXX)
  node -e '
    const fs = require("fs");
    fs.writeFileSync(process.env.MS_ANSWERS, JSON.stringify({
      milestone_name: process.env.MS_NAME,
      milestone_goal: process.env.MS_GOAL,
      create_req_prefix: false,
    }));
  ' MS_ANSWERS="$MS_ANSWERS" \
    MS_NAME="${ACCEPTED_NAMES[$idx]}" \
    MS_GOAL="${ACCEPTED_GOALS[$idx]}"

  MS_RESULT=$(node .nubos-pilot/bin/np-tools.cjs init new-milestone --apply "$MS_ANSWERS")
  rm -f "$MS_ANSWERS"

  MS_ID=$(node -e '
    const r = JSON.parse(process.env.MS_RESULT);
    process.stdout.write(r.milestone_id);
  ' MS_RESULT="$MS_RESULT")
  MILESTONES_APPENDED+=("$MS_ID — ${ACCEPTED_NAMES[$idx]}")
done
```

`create_req_prefix` defaults to `false` for AI-proposed milestones —
Discovery already produced REQUIREMENTS.md sections. If the user wants a
dedicated REQ block for a specific milestone, `/np:new-milestone` can
add it later.

### Step 3.4b — Manual bulk-loop (fallback / top-up)

Entered from "Discard proposal" or from the `ADD_MORE=true` top-up gate.
Same behavior as the pre-AI bulk-loop: prompt for `milestone_name`,
`milestone_goal`, `create_req_prefix`; empty name exits.

```bash
while :; do
  ANS_MS_NAME=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
    "type": "input",
    "question": "Define another milestone now? Enter name or leave empty to finish."
  }')
  [ -z "$ANS_MS_NAME" ] && break

  ANS_MS_GOAL=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
    "type": "input",
    "question": "Milestone goal (one sentence)?"
  }')
  ANS_REQ_PREFIX=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
    "type": "confirm",
    "question": "Create a new Requirements section for this milestone?",
    "default": false
  }')

  MS_ANSWERS=$(mktemp -t np-new-project-ms.XXXXXX)
  node -e '
    const fs = require("fs");
    const prefix = process.env.ANS_REQ_PREFIX;
    fs.writeFileSync(process.env.MS_ANSWERS, JSON.stringify({
      milestone_name: process.env.ANS_MS_NAME,
      milestone_goal: process.env.ANS_MS_GOAL,
      create_req_prefix: prefix === "true" || prefix === "yes" || prefix === "y",
    }));
  ' ANS_MS_NAME="$ANS_MS_NAME" ANS_MS_GOAL="$ANS_MS_GOAL" \
    ANS_REQ_PREFIX="$ANS_REQ_PREFIX" MS_ANSWERS="$MS_ANSWERS"

  MS_RESULT=$(node .nubos-pilot/bin/np-tools.cjs init new-milestone --apply "$MS_ANSWERS")
  rm -f "$MS_ANSWERS"

  MS_ID=$(node -e '
    const r = JSON.parse(process.env.MS_RESULT);
    process.stdout.write(r.milestone_id);
  ' MS_RESULT="$MS_RESULT")
  MILESTONES_APPENDED+=("$MS_ID — $ANS_MS_NAME")
done
```

### Step 3.5 — Done

Continue to Phase 4 with `MILESTONES_APPENDED` populated (possibly empty).

Notes:
- Every write goes through `np-tools.cjs init new-milestone --apply` —
  identical error surface (`answers-missing-field`, `roadmap-parse-error`).
  Any failure aborts the current loop and surfaces the error; prior
  milestones stay intact (atomic per-milestone).
- Text-mode routing (`INIT.text_mode == true`) applies to every askuser
  call above — render each prompt inline instead of shelling out.
- AI-proposed milestones start empty (`slices: []`). The user discusses
  each later via `/np:discuss-phase <N>` and plans via
  `/np:plan-phase <N>`; PROJECT.md is never rewritten (D-29).

## Phase 4 (conditional): Initial Codebase Scan

If Phase 0 reported `file_count > 0` with code files (not only manifests
and docs), offer to run the initial scan now:

```bash
RUN_SCAN=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "confirm",
  "question": "Run initial codebase scan now (np:scan-codebase)?",
  "default": true
}')

if [[ "$RUN_SCAN" =~ ^([Yy]([Ee][Ss])?|[Jj][Aa]?|[Tt]rue|1)$ ]]; then
  /np:scan-codebase
fi
```

Empty workspaces skip this cleanly.

## Optional Commit

```bash
if [ "$(node .nubos-pilot/bin/np-tools.cjs config-get workflow.commit_docs 2>/dev/null)" = "true" ]; then
  git add .nubos-pilot/
  git commit -m "chore: np:new-project scaffold + discovery"
fi
```

## Output

```
np:new-project complete.

Created:
  .nubos-pilot/PROJECT.md             (populated by discovery)
  .nubos-pilot/REQUIREMENTS.md
  .nubos-pilot/roadmap.yaml           (schema_version: 2)
  .nubos-pilot/STATE.md
  .nubos-pilot/milestones/M001/
    M001-CONTEXT.md
    M001-ROADMAP.md
    M001-META.json
    slices/
  .nubos-pilot/milestones/M002/ …     (if additional milestones added)
  .nubos-pilot/codebase/               (if initial scan ran)

Milestones:
  M001 — <milestone_name>
  <each entry from MILESTONES_APPENDED>

Next:
  - /np:discuss-phase 1 to capture decisions for M001
  - /np:plan-phase 1 to break M001 into slices + tasks
  - /np:discuss-phase <N> / /np:plan-phase <N> for each appended milestone
    (only after M001 ships; earlier milestones first)
  - /np:update-docs after any code change (agents will do this automatically)
```

## Errors

| Code | Trigger | User action |
|------|---------|-------------|
| `project-already-initialized` | `PROJECT.md` exists and user did not archive in Phase -1 | Re-run; pick "Archive and start fresh" or "Abort" |
| `archive-not-complete` | `archive-project do` without `--force` on incomplete project | Re-run with `--force` or run `/np:close-project` first |
| `archive-worktrees-present` | active `.nubos-pilot/worktrees/` entries exist | Clean up worktrees with `/np:worktree-list` and `/np:worktree-remove`, or pass `--force` |
| `invalid-slug` | milestone/phase name has no `[a-z0-9]` content | Re-run with a different name |
| `answers-missing-field` | empty answer | Re-run and fill all 5 fields |
| `discuss-project-bootstrap-requires-project` | Discovery invoked before scaffold | Restart workflow |
## Definition of Done

This workflow exits successfully only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 1 (Do the whole thing) — `.nubos-pilot/` skeleton contains `PROJECT.md`, `REQUIREMENTS.md`, `RULES.md`, `STATE.md`, `roadmap.yaml`, and `milestones/M001/` shell.
- Rule 4 (Do it with documentation) — `RULES.md` cites `COMPLETENESS.md` as foundation.
- Rule 11 (Ship the complete thing) — project boots `np:discuss-project` immediately on exit, no manual fixup.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
