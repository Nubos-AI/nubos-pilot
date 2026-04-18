# np:discuss-phase --power

Power-user mode for phase discussion. Generates a bulk question set into a
plain JSON file; the user edits it in their favourite editor (VS Code, vim,
JetBrains, Zed, Emacs …) and then says `refresh` or `finalize`.

> **Single-source-of-truth:** `QUESTIONS.json` is authoritative for in-progress
> state. `CONTEXT.md` is DERIVED only on `finalize`. `refresh` does NOT touch
> `CONTEXT.md`.

<philosophy>
Power mode exists for phases with many gray areas where chat-round-trip answering
is too slow. Instead of a synchronous interview, Claude seeds a bulk question
set; the user answers asynchronously in their editor; Claude processes all
answers in a single pass on `finalize`. The UX trade-off is bulk-speed in
exchange for losing the adaptive follow-up that standard discuss-phase offers —
use power mode only when that trade-off is explicit.
</philosophy>

<scope_guardrail>
Power mode MUST NOT widen the phase. The seeded question set reflects the
existing phase boundary as captured in ROADMAP.md and REQUIREMENTS.md. If a
user answer introduces a new requirement, Claude flags it on finalize; it does
not silently absorb it into CONTEXT.md.
</scope_guardrail>

<downstream_awareness>
CONTEXT.md produced by this workflow is the same shape that `np:research-phase`
and `np:plan-phase` consume. The planner reads the `<decisions>` and
`<canonical_refs>` sections without knowing whether they came from adaptive or
power mode. Schema parity is therefore mandatory — never invent keys that only
power mode emits.
</downstream_awareness>

<answer_validation>
On `finalize`, the subcommand rejects the transition if ANY question's `answer`
field is still `null` or an empty string. Pending IDs are returned to the user
via `NubosPilotError('power-finalize-incomplete', { pending_ids })` so the
editor round-trip is resumed without data loss.
</answer_validation>

## What This Workflow Does NOT Do

- **No HTML file generation.** A self-contained HTML companion is
  deliberately out of scope per CONTEXT D-05..D-08.
- **No browser File System Access API.** FSA is Chromium-only and useless in
  Codex / Gemini / OpenCode terminal runtimes.
- **No embedded CSS or JS bundle.** Zero frontend code in this phase.
- **No server, no port, no background process.** Pure file-on-disk state.
- **No auto-open.** JSON is edited in the user's preferred editor —
  nubos-pilot never launches a UI.

## Flow

### 1. Bootstrap

Single init call:

```bash
PHASE="$1"   # phase number passed by /np:discuss-phase --power N
INIT=$(node np-tools.cjs init discuss-phase-power init "$PHASE")
```

The subcommand writes `{phase_dir}/{padded}-QUESTIONS.json` with a seeded
question catalogue spanning the six CONTEXT areas (domain, decisions,
canonical_refs, code_context, specifics, deferred).

### 2. Instruct the user

Echo this prompt verbatim (D-06):

> Öffne `{padded}-QUESTIONS.json` in deinem Editor, setze `answer` pro Frage,
> speichere. Sag mir dann `refresh` oder `finalize`.

### 3. Command loop

Drive all prompts through `np-tools.cjs askuser --json` (no bare runtime
prompt calls anywhere in this workflow — SC-5):

```bash
while true; do
  CMD=$(node np-tools.cjs askuser --json '{"type":"select","question":"Command?","options":[{"label":"refresh"},{"label":"finalize"},{"label":"explain"},{"label":"exit"}]}')
  case "$CMD" in
    refresh)
      node np-tools.cjs init discuss-phase-power refresh "$PHASE"
      ;;
    finalize)
      node np-tools.cjs init discuss-phase-power finalize "$PHASE" && break
      ;;
    explain)
      QID=$(node np-tools.cjs askuser --json '{"type":"input","question":"Question ID? (e.g. Q-03)"}')
      node np-tools.cjs init discuss-phase-power explain "$PHASE" "$QID"
      ;;
    exit)
      node np-tools.cjs init discuss-phase-power exit "$PHASE" && break
      ;;
  esac
done
```

### 4. Verb semantics

| Verb       | Effect                                                                   | Touches CONTEXT.md? |
| ---------- | ------------------------------------------------------------------------ | ------------------- |
| `init`     | Writes `{padded}-QUESTIONS.json` with seeded questions.                  | No                  |
| `refresh`  | Re-reads JSON; emits stats JSON (totals per area).                       | **No** (Pitfall 1)  |
| `finalize` | Validates all answers; renders CONTEXT.md; marks `answers_status='finalized'`. | Yes                 |
| `explain`  | Returns a single question object with its `explain` body.                | No                  |
| `exit`     | Emits status JSON; leaves QUESTIONS.json on disk.                        | No                  |

### 5. Post-finalize

On success Claude reports:

```
CONTEXT.md written: {phase_dir}/{padded}-CONTEXT.md
Next step: /np:plan-phase {N}
```

## Error surface

| Error code                      | When                                                 | Recovery                                        |
| ------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| `power-questions-exist`         | `init` run twice without editing.                    | Edit JSON or delete it to re-seed.              |
| `power-finalize-incomplete`     | `finalize` called with null / empty answers.         | Inspect `pending_ids`, fill them, retry.        |
| `power-question-not-found`      | `explain Q-XX` with unknown id.                      | Use `refresh` to list question ids.             |
| `power-explain-missing-id`      | `explain` invoked without a question id.             | Supply an id via askuser input.                 |
| `template-not-found`            | CONTEXT.md template missing from `.nubos-pilot/templates/`. | Ensure Phase 5 templates are installed.         |
| `template-unresolved-var`       | User answer references an unknown placeholder.       | Check CONTEXT.md template; do not widen schema. |

## Success criteria

- JSON is the only state file produced by this workflow.
- `refresh` never writes CONTEXT.md.
- `finalize` writes CONTEXT.md atomically via `lib/template.cjs loadTemplate`.
- Zero bare runtime-prompt calls; every prompt routes through
  `np-tools.cjs askuser`.
- Verb set refresh / finalize / explain / exit covers the full power-mode
  lifecycle (D-07).
