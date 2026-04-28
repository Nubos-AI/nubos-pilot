---
command: np:architect-phase
description: Optional ADR-step between /np:research-phase and /np:plan-phase. Spawns np-architect to emit M<NNN>-ARCHITECTURE.md. Use when a milestone introduces structural change (new module, new boundary, new data flow). Skip for purely additive milestones — the planner handles those without an architecture pass.
argument-hint: <milestone-number>
---

# /np:architect-phase

<objective>
Optionaler Architektur-Pass zwischen Research und Planning. Spawnt
`agents/np-architect.md`, der RESEARCH.md + CONTEXT.md + RULES.md liest
und eine `M<NNN>-ARCHITECTURE.md` mit 3–7 ADR-style Entscheidungen
erzeugt. Der Planner respektiert das Artefakt anschließend wie eine
Erweiterung von CONTEXT.md.
</objective>

## When to Run

Lauf, wenn der Milestone:
- ein neues Modul / einen neuen Service / eine neue Boundary einführt,
- mehrere `[ASSUMED]`-Claims in der Architecture-Dimension von RESEARCH.md hat,
- explizit per `architecture_review: required` in CONTEXT.md markiert ist.

Skip, wenn der Milestone rein additiv ist (neuer Endpoint auf existierendem
Controller, Copy-Update, Version-Bump). Der Planner schafft das ohne ADR-Pass.

## Initialize

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
MILESTONE_NUMBER="$1"

if [ -z "$MILESTONE_NUMBER" ]; then
  echo "Usage: /np:architect-phase <milestone-number>" >&2
  exit 1
fi
```

`$LANG_DIRECTIVE` regelt die Sprache aller User-facing Outputs und der
ARCHITECTURE.md (en/de gemäß `.nubos-pilot/config.json` →
`response_language`).

## Pre-flight

Prüfe, dass die Voraussetzungen vorliegen:

```bash
M_DIR=$(node .nubos-pilot/bin/np-tools.cjs state-dir --subdir milestones)
M_ID=$(printf 'M%03d' "$MILESTONE_NUMBER")
CTX="$M_DIR/$M_ID/$M_ID-CONTEXT.md"
RES="$M_DIR/$M_ID/$M_ID-RESEARCH.md"

if [ ! -f "$CTX" ]; then
  echo "Missing CONTEXT — run /np:discuss-phase $MILESTONE_NUMBER first." >&2
  exit 2
fi
if [ ! -f "$RES" ]; then
  echo "Missing RESEARCH — run /np:research-phase $MILESTONE_NUMBER first (or skip explicitly)." >&2
  exit 3
fi
```

## Spawn np-architect

Spawn `agents/np-architect.md` mit dem folgenden Files-to-Read-Block:

```
<files_to_read>
.nubos-pilot/milestones/M<NNN>/M<NNN>-CONTEXT.md
.nubos-pilot/milestones/M<NNN>/M<NNN>-RESEARCH.md
.nubos-pilot/RULES.md
.nubos-pilot/codebase/INDEX.md
</files_to_read>

Milestone: M<NNN>
Task: Emit M<NNN>-ARCHITECTURE.md per the agent's Output Contract.
```

Der Agent ist read-only auf Source — er schreibt EINE Datei:
`.nubos-pilot/milestones/M<NNN>/M<NNN>-ARCHITECTURE.md`.

## Post

Wenn der Agent `## CONTEXT CONFLICT` emittiert statt der Datei:
- nicht weiterplanen,
- Output an User zur Auflösung übergeben (`/np:discuss-phase <N>` re-öffnen).

Wenn die Datei geschrieben wurde, gibt der Workflow eine kurze
Quittung aus und verweist auf `/np:plan-phase $MILESTONE_NUMBER`.

## Scope Guardrail

<scope_guardrail>
**Do:** Voraussetzungen prüfen, np-architect spawnen, Quittung anzeigen.

**Don't:**
- Quellen-Dateien mutieren (der Agent schreibt nur ARCHITECTURE.md).
- CONTEXT.md neu öffnen (`/np:discuss-phase` ist die Single Source).
- Direkt zur Planung übergehen — der Operator entscheidet wann
  `/np:plan-phase` läuft.
- Commits machen — `/np:architect-phase` ist read-only auf Git.
</scope_guardrail>

## Output

- `.nubos-pilot/milestones/M<NNN>/M<NNN>-ARCHITECTURE.md` (1 Datei)
- Stdout: kurze Quittung mit Pfad + Verweis auf `/np:plan-phase`.
