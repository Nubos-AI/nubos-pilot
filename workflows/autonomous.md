---
command: np:autonomous
description: In-session auto-advance loop — runs phase after phase, asking the user between phases. NOT a daemon (ADR-0001 No-Daemon Invariant).
---

# /np:autonomous

<objective>
Iterate `resolveGate` → `/np:execute-phase` → `/np:verify-work` → askUser
until the user says stop. The loop is an in-session for-loop executed by
the host agent — it does NOT fork, spawn a detached process, or survive
session end (ADR-0001).
</objective>

## Initialize

```bash
PHASE="$1"
GATE_JSON=$(node np-tools.cjs init autonomous "$PHASE")
```

Parse: `status` (ok | advancement-blocked), `gate.rule`, `gate.task`.

If `status == advancement-blocked`:

```bash
CHOICE=$(node np-tools.cjs askuser --json '{
  "type": "select",
  "header": "Phase kann nicht fortschreiten",
  "question": "Jede Pending-Task in Wave 1 ist skipped oder parked. Was tun?",
  "options": [
    {"label": "Unpark tasks and continue", "description": "Dispatch /np:unpark zur Reaktivierung, dann erneut /np:autonomous starten."},
    {"label": "Abort",                      "description": "Exit; User entscheidet manuell."}
  ]
}')
exit 0
```

## Execution — in-session loop (NO daemon, NO background)

The loop runs inside the agent context. Each iteration:

1. Re-read gate for `$PHASE`: `node np-tools.cjs init autonomous "$PHASE"`.
2. If `gate.rule == 1` → dispatch `/np:discuss-phase $PHASE`, wait for
   completion, continue.
3. If `gate.rule == 2` → dispatch `/np:plan-phase $PHASE`, wait, continue.
4. If `gate.rule == 3` → dispatch `/np:execute-phase $PHASE`, wait, continue.
5. If `gate.rule == 4` → dispatch `/np:verify-work $PHASE`, wait, continue.
6. If `gate.rule == 5` → phase verified. Ask the user:

```bash
CHOICE=$(node np-tools.cjs askuser --json '{
  "type": "select",
  "header": "Phase verifiziert",
  "question": "Phase '"$PHASE"' ist verified. Weitermachen mit der nächsten Phase?",
  "options": [
    {"label": "Continue",  "description": "Nächste Phase automatisch starten."},
    {"label": "Pause",     "description": "Stop, handoff via /np:pause-work."},
    {"label": "Abort",     "description": "Exit."}
  ]
}')
case "$CHOICE" in
  "Continue") PHASE=$((PHASE + 1));;
  "Pause")    node np-tools.cjs init pause-work; exit 0 ;;
  "Abort")    exit 0 ;;
esac
```

## Hard-stops (D-15)

- Any `NubosPilotError` with severity fatal → exit non-zero immediately.
- commit-task loud-fails (gitignored-only) → propagate, do not retry.
- `advancement-blocked` → askUser gate above, never silent spin.

## Scope Guardrail

<!-- scope_guardrail -->
**Do:**
- Drive the loop inside the current agent session.
- Ask the user at every phase boundary (D-14).
- Respect `resolveGate` outputs verbatim.

**Don't:**
- Fork, `setInterval`, `nohup`, `spawn --detached`, or `&` the loop body —
  ADR-0001 bans daemon behavior (T-06-14).
- Skip the inter-phase askUser gate.
- Silently advance past a Fail verdict from `/np:verify-work`.
<!-- /scope_guardrail -->

## Output

- N phases advanced (N = user choice count).
- Full audit trail in per-phase `PLAN-REVIEW.md` + `VERIFICATION.md`.
- Session ends cleanly; resume via `/np:resume-work`.
