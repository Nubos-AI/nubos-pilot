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

## Researcher-Schwarm (when invoked with `--research`)

When the user invokes `/np:architect-phase <N> --research` (or when `swarm.research.k > 1` is the project default and the architect has not already consumed a fresh `M<NNN>-RESEARCH.md`), the orchestrator runs the Researcher-Schwarm before spawning the architect:

1. Load swarm config via `lib/researcher-swarm.cjs::resolveSwarmOpts` (default `k=3`).
2. Pre-flight cache lookup via `lib/knowledge-adapter.cjs::match`. Hit ⇒ rendered directly into `M<NNN>-RESEARCH.md` with `[CACHED]` provenance and Schwarm bypassed.
3. Otherwise spawn `k` parallel `np-researcher` agents and merge with `mergeConsensus` (Mehrheit / Union / Schnittmenge). The merged output replaces the architect's research input.

The architect then consumes the consensus-merged `RESEARCH.md` instead of a single-spawn output. ADR-0011 details the merge rules and the `<consensus_meta>` audit block.

**Off-host (ADR-0021):** the Schwarm reuses the exact off-host `np-researcher` mechanism documented in `/np:research-phase` — detect `resolve-model np-researcher --kind`; when `openai-compat`, run the `k` spawns via `spawn-offhost --agent np-researcher --task-id "${MILESTONE_ID}-S000-T0000" --no-audit` (synthetic milestone-level canonical task-id for the Rule-9 ledger) and stamp one `loop-audit-tool-use` per spawn. **Offline only** — the off-host toolset has no `WebFetch`/`context7`, so route `np-researcher` native for online research.

## Adversarial Loop (1 round)

After the architect emits `M<NNN>-ARCHITECTURE.md`, the orchestrator spawns ONE `np-critic` instance with the architecture file + `M<NNN>-CONTEXT.md` as inputs. The critic verifies that every locked decision in CONTEXT has a corresponding architecture entry and that no `Deferred` items leaked into the architecture. Findings of category `unmet-criterion`, `locked-decision-violation`, or `information-missing` route per `lib/nubosloop.cjs::routeFindings`. A single Build-Fixer-style round on the architect closes the loop. Beyond one round the workflow exits with `stuck` and the user resolves manually — architecture decisions don't merit unbounded looping.

**Off-host (ADR-0021):** when `np-critic` routes to an `openai-compat` provider (`resolve-model np-critic --kind`), run it `--read-only` via `spawn-offhost --agent np-critic` exactly as the `/np:execute-phase` off-host critic — the critic emits its `{ "critic":"critic", "findings":[…] }` object as the final message (off-host Write is cwd-confined, cannot reach `$TMPDIR`), and the orchestrator persists it as-is. `mergeCriticOutputs` is the single guard for the `critic` axis and fails closed on an unknown value (`critic-output-unknown-axis`) — do not re-implement the axis list here.

## Skills (Nubos library)

Nubos ships a design-time skill library under `.claude/skills/np-*/` (present only on Claude Code). These are the **quality bar for the architecture decisions you are about to commit** — each skill's "Verification bar" is the standard each ADR-style decision is held to. Before spawning `np-architect`, classify the milestone (read `M<NNN>-CONTEXT.md` + `M<NNN>-RESEARCH.md`) and inject the matching skill triggers into the architect's spawn prompt. Skills **stack** — include every row the milestone matches (cap at the most relevant ~4 if more match; always keep the security row when it applies).

| Milestone signal | Skills to trigger |
|---|---|
| Designs a new system, module, or significant feature | `np-system-design` (with `np-adr` for an architecturally significant, hard-to-reverse choice) |
| Introduces or moves a module/service boundary, splits a service, or chooses sync vs async | `np-service-boundary` |
| Any structural decision that is costly to reverse — datastore, sync/async, new dependency, auth model, public contract | `np-adr` |
| New external surface, new trust boundary, new privilege model, or handling of sensitive assets | `np-secure-design` (with `np-threat-model`) |
| Authorization model — roles, permissions, policies, resource ownership | `np-access-control` |
| Design depends on an unreliable dependency, async/queue processing, or a cache | `np-resilience-patterns`, `np-queue-design`, `np-caching-strategy` (each as it applies) |
| Persisted data shape, or personal/sensitive data | `np-data-modeling`, `np-data-privacy` (as they apply) |
| Purely additive milestone with no structural/security decision | None — skip the skill block (and reconsider whether the architect pass is needed at all) |

## Spawn np-architect

Spawn `agents/np-architect.md` mit dem folgenden Files-to-Read-Block und (sofern Skills matchen) der angehängten Skill-Direktive:

```
<files_to_read>
.nubos-pilot/milestones/M<NNN>/M<NNN>-CONTEXT.md
.nubos-pilot/milestones/M<NNN>/M<NNN>-RESEARCH.md
.nubos-pilot/RULES.md
.nubos-pilot/codebase/INDEX.md
</files_to_read>

Milestone: M<NNN>
Task: Emit M<NNN>-ARCHITECTURE.md per the agent's Output Contract.

Use the following Nubos skills as the quality bar for your decisions: <skill-1>, <skill-2>, ...
Each is installed at .claude/skills/<skill>/SKILL.md; every architecture decision must satisfy the matching skill's "Verification bar".
```

If zero skills match, omit the skill-directive line — do not invent skills.

Der Agent ist read-only auf Source — er schreibt EINE Datei:
`.nubos-pilot/milestones/M<NNN>/M<NNN>-ARCHITECTURE.md`.

**Off-host (ADR-0021):** when `np-architect` routes to an `openai-compat` provider, run it via `spawn-offhost` instead of the host spawn. `np-architect` is NOT Rule-9-audited and writes only the one `M<NNN>-ARCHITECTURE.md` artefact under `.nubos-pilot/` (inside the repo cwd — never live code), so it runs off-host with the default cwd (Read/Grep/Glob over the repo + Write confined to cwd), **no `--allow-bash`, no worktree**. It writes the file exactly as the native architect; no emit-and-persist contract is needed.

```bash
ARCHITECT_KIND=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-architect --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).kind||"native")}catch{console.log("native")}})')
if [ "$ARCHITECT_KIND" = "openai-compat" ]; then
  ARCHITECT_PROMPT="${TMPDIR:-/tmp}/np-offhost-architect-M<NNN>.md"
  # … render the SAME files_to_read block + Milestone/Task + (matched) skill
  #   directive above, PLUS $LANG_DIRECTIVE, into "$ARCHITECT_PROMPT" …
  node .nubos-pilot/bin/np-tools.cjs spawn-offhost \
    --agent np-architect --task-file "$ARCHITECT_PROMPT" --phase "M<NNN>" >/dev/null
fi
# else → native host spawn per the block above.
```

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
## Definition of Done

This workflow exits successfully only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 1 (Do the whole thing) — `M<NNN>-ARCHITECTURE.md` covers module boundaries, data flow, error paths, and migration plan; partial structures are findings.
- Rule 6 (Never table) — every architectural decision required for this milestone is locked here, not deferred to an unscheduled future ADR.
- Rule 8 (No workarounds without ADR) — every workaround referenced has an accepted ADR.
- Rule 9 (Search before building) — prior `M<???>-ARCHITECTURE.md` files and `.nubos-pilot/codebase/INDEX.md` are read before any new module is named.
- Rule 12 (Boil the ocean) — no "structure TBD" markers remain at exit.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
