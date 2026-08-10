---
command: np:resume-work
description: Classify session state (resume | orphan | clean) from STATE + checkpoints; re-spawn executor or prompt user for orphan handling.
---

# /np:resume-work

<objective>
Re-enter a paused session. Returns one of three states; the workflow acts
on each accordingly.
</objective>

## Initialize

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT=$(node .nubos-pilot/bin/np-tools.cjs init resume-work)
STATUS=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).status))")
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative. Obey it for user-facing output and
askuser prompts. When spawning the np-executor to continue a checkpoint,
pass `$LANG_DIRECTIVE` into the spawn prompt so resumed task summaries
follow the project language. Supersedes CLAUDE.md.

**Askuser routing.** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below is a spec, not a literal command. Pick the path once at Initialize:
- **Claude Code** (native `AskUserQuestion` tool is available): parse the JSON spec and call `AskUserQuestion` directly. `select` → `multiSelect: false`; `multiselect` → `multiSelect: true`; `confirm` → `options: [{label: "Yes"}, {label: "No"}]`; `input` → ask free-form in chat. Use a short `header` (≤12 chars).
- **`text_mode == true`** (INIT payload): skip every askuser block and render questions as plain-text numbered lists. Opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.
- **Other runtime with TTY** (Codex, Gemini, …): execute the shell `askuser` block verbatim.

## Step 0 — Session handoff gate (ADR-0025)

Runs **before** any status routing. The negative knowledge in a handoff —
section 5, the approaches this project already disproved — is worthless if the
next session starts coding before reading it. That is the whole failure this
gate exists to prevent, so it is checked first and it is not skippable.

```bash
HANDOFF_GATE=$(node .nubos-pilot/bin/np-tools.cjs resume-doc status)
```

- `none` — no handoff was written. Continue to Execution.
- `clear` — already acknowledged in an earlier session. Continue to Execution.
- `blocked` — an unread handoff exists. **Stop here** and do this, in order:

1. Read it: `node .nubos-pilot/bin/np-tools.cjs resume-doc read`
2. Summarise it back in 2–6 lines, in your own words, naming at least one entry
   from **Failed approaches** so it is demonstrable that the section was read.
3. Record the acknowledgement:

```bash
if [ "$HANDOFF_GATE" = "blocked" ]; then
  node .nubos-pilot/bin/np-tools.cjs resume-doc ack --summary-file /tmp/np-ack-$$.txt
fi
```

The summary is required and stored. An ack nobody had to write is a checkbox,
and a checkbox gets ticked without reading — which is the state this gate is
supposed to detect, not create.

**Do not** touch source files, spawn an executor, or mutate STATE while the gate
reads `blocked`. Reading the handoff is the only permitted action.

Optionally fold the disproved approaches into the learnings store, so a future
task ranks them below proven patterns instead of rediscovering them:

```bash
node .nubos-pilot/bin/np-tools.cjs resume-doc learnings --log
```

## Execution

### status: resume

STATE.current_task matches an in-progress checkpoint. Spawn
`agents/np-executor.md` with the checkpoint payload so it continues from
`resume_hint`:

```bash
if [ "$STATUS" = "resume" ]; then
  TASK_ID=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).task_id))")
  # Hand the task payload + checkpoint to agents/np-executor.md; on completion
  # the agent invokes `node .nubos-pilot/bin/np-tools.cjs commit-task "$TASK_ID"` as usual.
  echo "Resuming task $TASK_ID via agents/np-executor.md …"
fi
```

### status: orphan

Checkpoints exist but none match `STATE.current_task`:

```bash
if [ "$STATUS" = "orphan" ]; then
  CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Verwaiste Checkpoints",
    "question": "Es existieren Checkpoint-Dateien, aber STATE.current_task passt nicht. Wie vorgehen?",
    "options": [
      {"label": "Clean working tree (reset-slice)", "description": "Verwirft in-flight Änderungen und löscht den Checkpoint."},
      {"label": "Adopt orphan as current_task",      "description": "STATE wird auf den gefundenen Checkpoint gesetzt; Executor übernimmt."},
      {"label": "Abort",                              "description": "Exit, User entscheidet manuell."}
    ]
  }')
  ORPHAN_ID=$(echo "$INIT" | node -e "process.stdin.on('data', d => { const p = JSON.parse(d); console.log((p.checkpoint_ids || [])[0] || '') })")
  case "$CHOICE" in
    "Clean working tree (reset-slice)")
      # Was offered but never handled: the case matched only "Abort", so picking
      # this fell through and resume-work continued with the orphan untouched.
      node .nubos-pilot/bin/np-tools.cjs reset-slice "$ORPHAN_ID"
      echo "[np:resume-work] orphan $ORPHAN_ID cleared." >&2
      exit 0
      ;;
    "Adopt orphan as current_task")
      # `checkpoint start` on an existing checkpoint preserves started_at,
      # files_touched, resume_hint and the nubosloop block (bumping restart_count)
      # while pointing STATE.current_task at it — i.e. adoption without data loss.
      node .nubos-pilot/bin/np-tools.cjs checkpoint start "$ORPHAN_ID" >/dev/null
      echo "[np:resume-work] STATE.current_task adopted $ORPHAN_ID — re-run /np:resume-work to continue it." >&2
      exit 0
      ;;
    "Abort") exit 0 ;;
    *)
      echo "[np:resume-work] unrecognised orphan-dialog answer: '$CHOICE' — aborting rather than leaving the orphan silently in place." >&2
      exit 1
      ;;
  esac
fi
```

### status: clean

No active work. Point the user at the next milestone:

```bash
if [ "$STATUS" = "clean" ]; then
  echo "Session clean. Next: /np:plan-phase <N> or /np:execute-phase <N>." >&2
fi
```

## Scope Guardrail

**Do:** run the handoff gate first; trust `init resume-work`'s classification
verbatim; route each status to its corresponding handler.
**Don't:** invent a fourth status; skip the askUser gate on orphan; silently
overwrite STATE; proceed past a `blocked` handoff gate, or acknowledge a handoff
you did not read.

## Output

- The handoff gate result (`none` | `blocked` | `clear`), and when it was
  `blocked`, the stored acknowledgement.
- One of: executor re-spawn, user-driven orphan resolution, or next-step
  hint. STATE.md changes only via the chosen handler.
## Definition of Done

Session resume. Definition of Done, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 7 (Never leave a dangling thread) — orphan-checkpoint guard runs; user is prompted before any silent state loss.
- Rule 9 (Search before building) — an unread handoff is the cheapest search available; the gate is cleared by reading it, never bypassed.
- Rule 11 (Ship the complete thing) — execution continues from exact transition point or the workflow exits with explicit guidance.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
