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
  case "$CHOICE" in
    "Abort") exit 0 ;;
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

**Do:** trust `init resume-work`'s classification verbatim; route each
status to its corresponding handler.
**Don't:** invent a fourth status; skip the askUser gate on orphan;
silently overwrite STATE.

## Output

- One of: executor re-spawn, user-driven orphan resolution, or next-step
  hint. STATE.md changes only via the chosen handler.
