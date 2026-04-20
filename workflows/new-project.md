---
command: np:new-project
description: Greenfield project scaffold — scans existing workspace, runs bootstrap interview (5 questions), scaffolds the baseline artifacts, then chains into obligatory project discovery and initial codebase scan.
argument-hint: [--apply <answers.json>]
---

# np:new-project

Initialize a new nubos-pilot project in three phases:

1. **Phase 0 — Workspace Scan** (context capture)
2. **Phase 1 — Bootstrap Interview** (5 structural questions → scaffold)
3. **Phase 2 — Project Discovery** (obligatory, chains into `np:discuss-project --bootstrap`)

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
- writes when `.nubos-pilot/PROJECT.md` already exists (refuses with
  `project-already-initialized`)
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
- (optional) `.nubos-pilot/codebase/` via chained `np:scan-codebase`

`np:discuss-project` (Phase 2) chains automatically — not skippable.
`np:scan-codebase` chains when the workspace contains >= 1 source file.
</downstream_awareness>

## Phase 0: Workspace Scan

Probe the workspace for context before asking anything:

```bash
SCAN=$(node -e '
  const { scan } = require("./lib/workspace-scan.cjs");
  const r = scan({ cwd: process.cwd(), batchSize: 1000 });
  process.stdout.write(JSON.stringify({
    file_count: r.stats.file_count,
    langs: r.language_distribution,
    manifests: Object.keys(r.manifests),
    docs: Object.keys(r.docs),
    readme_head: r.docs["README.md"]
      ? r.docs["README.md"].content.split("\\n").slice(0, 20).join("\\n")
      : null,
    git: r.git,
  }));
')
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

```bash
ANS_PROJECT_NAME=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","prompt":"Project name?"}')
ANS_CORE_VALUE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","prompt":"Core value — one sentence that must stay true if everything else fails?"}')
ANS_CONSTRAINTS=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","prompt":"Primary constraints (comma-separated)?"}')
ANS_FIRST_MS=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","prompt":"First milestone name?"}')
ANS_FIRST_PHASE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","prompt":"First phase name?"}')
```

When Phase 0 produced a suggestion, include it as the prompt default in
the askuser call (e.g. `"prompt":"Project name? (suggested: T-AI)"`).

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

```bash
set +e
node .nubos-pilot/bin/np-tools.cjs init new-project --apply "$ANSWERS"
APPLY_STATUS=$?
set -e

if [ "$APPLY_STATUS" -ne 0 ]; then
  CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
    "type": "select",
    "prompt": "Project already initialized. Choose:",
    "options": [
      "Abort (recommended)",
      "Delete existing .nubos-pilot/ and retry (destructive)"
    ]
  }')
  case "$CHOICE" in
    *destructive*|*Delete*)
      rm -rf ./.nubos-pilot
      node .nubos-pilot/bin/np-tools.cjs init new-project --apply "$ANSWERS"
      ;;
    *)
      exit 1
      ;;
  esac
fi
```

## Phase 2: Project Discovery (obligatory)

Do not let the user skip this. Chain into `np:discuss-project --bootstrap`:

```bash
BOOTSTRAP=1 /np:discuss-project
```

The user answers the six adaptive discovery questions (Target Users,
Domain, What-This-Is, Non-Goals, Success Criteria, Strategic Decisions),
reviews proposed requirements, and ends with a fully populated PROJECT.md.

If the user tries to exit mid-discovery, warn:

```
PROJECT.md still has _TBD placeholders. Downstream phases will treat
the project as under-specified. Continue discovery? (yes / no, I will
finish later)
```

Record the skip in STATE.md so the next `np:next` reminds the user.

## Phase 3 (conditional): Initial Codebase Scan

If Phase 0 reported `file_count > 0` with code files (not only manifests
and docs), offer to run the initial scan now:

```bash
RUN_SCAN=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "confirm",
  "prompt": "Run initial codebase scan now (np:scan-codebase)?",
  "default": true
}')

if [[ "$RUN_SCAN" == "true" ]]; then
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
  .nubos-pilot/codebase/               (if initial scan ran)

Milestone: M001 — <milestone_name>

Next:
  - /np:discuss-phase 1 to capture decisions for M001
  - /np:plan-phase 1 to break M001 into slices + tasks
  - /np:update-docs after any code change (agents will do this automatically)
```

## Errors

| Code | Trigger | User action |
|------|---------|-------------|
| `project-already-initialized` | `PROJECT.md` exists | Abort or re-run with destructive option |
| `invalid-slug` | milestone/phase name has no `[a-z0-9]` content | Re-run with a different name |
| `answers-missing-field` | empty answer | Re-run and fill all 5 fields |
| `discuss-project-bootstrap-requires-project` | Discovery invoked before scaffold | Restart workflow |
