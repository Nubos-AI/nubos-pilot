---
command: np:add-backlog
description: Add a 999.x backlog item to ROADMAP.md. Uses lib/roadmap.cjs.addBacklogEntry (file-locked) to append to the synthetic "backlog" milestone. Creates .nubos-pilot/phases/999.X-<slug>/.gitkeep. One atomic docs commit.
---

# np:add-backlog

Implements UTIL-05c. Mints a new entry in the synthetic `backlog`
milestone (id: `backlog`) using 999.x numbering. Unlike normal phases,
backlog items live outside the active milestone sequence — they are
the parking lot for "not-ready-to-plan" ideas that still deserve a
home in the roadmap.

The authoritative numbering and ROADMAP/roadmap.yaml update are
performed inside `lib/roadmap.cjs.addBacklogEntry` (landed in
Plan 10-01-T05). That helper is file-locked via `_mutate()` so two
parallel invocations serialise on the same 999.x counter (T-10-05-04
is accepted because the lock resolves the race inside the mutator).
The preview number shown to the user is computed OUTSIDE the lock and
is advisory only — the authoritative number comes back in the
helper's return value.

This is a pure-CRUD workflow — no agent spawn, no resolve-model, no
metrics record. The `workflow-missing-metrics` lint in
`bin/check-workflows.cjs` only fires on `Task(` / `Spawn agent=` sites,
so CRUD-only workflows are exempt (Pitfall 9 resolution from
Plan 10-05). Interactive prompts route through
`node np-tools.cjs askuser --json` per INST-03.

## Initialize

```bash
TITLE="$*"
if [[ -z "$TITLE" ]]; then
  echo "Usage: /np:add-backlog <title>" >&2
  exit 2
fi
```

## Compute Preview

Info-only preview — the preview number is NOT used as the commit
subject. The authoritative 999.X is assigned inside the lock and
returned in `RESULT` below.

```bash
NEXT_NUMBER=$(node np-tools.cjs phase next-decimal 999 --raw)
SLUG=$(node np-tools.cjs generate-slug "$TITLE" --raw)
if [[ -z "$SLUG" ]]; then
  echo "Error: title produced no slug-safe characters." >&2
  exit 1
fi
echo "Will add backlog item: ${NEXT_NUMBER} — ${TITLE}"
```

## Confirm

```bash
CHOICE=$(node np-tools.cjs askuser --json '{
  "type": "select",
  "header": "Backlog Item Preview",
  "question": "Add backlog item '"${NEXT_NUMBER}"' — '"${TITLE}"'?",
  "options": [
    {"label": "Yes — append to ROADMAP + create phase dir", "description": "One atomic docs commit (ROADMAP.md + roadmap.yaml + .gitkeep)."},
    {"label": "Cancel", "description": "Exit without changes."}
  ]
}')
case "$CHOICE" in
  "Cancel"*) exit 0 ;;
esac
```

## Append to ROADMAP

The real append happens through `lib/roadmap.cjs.addBacklogEntry`
which owns (1) input validation (500-char cap, YAML-separator reject),
(2) the file lock, and (3) the 999.X numbering computed inside the
mutator. The helper returns `{backlog_number, backlog_slug}`; we use
those values — NOT the preview values — for the phase directory and
commit subject.

```bash
RESULT=$(node -e "const r=require('./lib/roadmap.cjs').addBacklogEntry(process.argv[1]); process.stdout.write(JSON.stringify(r));" "$TITLE")
BACKLOG_NUMBER=$(echo "$RESULT" | jq -r '.backlog_number')
BACKLOG_SLUG=$(echo "$RESULT" | jq -r '.backlog_slug')
```

T-10-05-03 (description-breaks-YAML) is mitigated inside
`addBacklogEntry`: it rejects descriptions containing the YAML
separator pattern and caps length at 500 chars, then re-parses
roadmap.yaml inside the lock to validate the post-mutation document.

## Create Phase Dir Stub

The backlog phase gets an empty `.gitkeep` directory so
`/np:discuss-phase 999.X` and `/np:plan-phase 999.X` have a place to
write CONTEXT/RESEARCH/PLAN artefacts when the idea graduates from
parking lot to active planning.

```bash
STATE_DIR=$(node -e "console.log(require('./lib/core.cjs').projectStateDir(process.cwd()))")
PHASE_DIR="${STATE_DIR}/phases/${BACKLOG_NUMBER}-${BACKLOG_SLUG}"
mkdir -p "$PHASE_DIR"
touch "${PHASE_DIR}/.gitkeep"
```

## Commit

Route through `node np-tools.cjs commit` so
`lib/git.cjs.assertCommittablePaths()` validates each path before
`git add`. ROADMAP.md (rendered), roadmap.yaml (canonical source), and
the phase-dir `.gitkeep` land together as a single atomic unit per
ADR-0004.

```bash
node np-tools.cjs commit "docs(10): add backlog item ${BACKLOG_NUMBER} — ${TITLE}" \
  --files "${STATE_DIR}/ROADMAP.md" "${STATE_DIR}/roadmap.yaml" "${PHASE_DIR}/.gitkeep"
```

## Report

```
Backlog item added: ${BACKLOG_NUMBER} — ${TITLE}
  Directory: ${PHASE_DIR}/

This item lives in the backlog parking lot.
Use /np:discuss-phase ${BACKLOG_NUMBER} to explore it further.
```

## Scope Guardrail

<scope_guardrail>
**Do:**
- Use `lib/roadmap.cjs.addBacklogEntry` (file-locked + atomic
  YAML+MD write) — it is the single sanctioned mutator for the
  synthetic `backlog` milestone.
- Use `node np-tools.cjs phase next-decimal 999 --raw` for the
  preview number ONLY. The authoritative number comes from
  `addBacklogEntry`'s return value (re-computed inside the lock).
- Commit ROADMAP.md + roadmap.yaml + phase-dir `.gitkeep` together
  as a single atomic unit per ADR-0004.
- Route the commit through `node np-tools.cjs commit` for
  `lib/git.cjs.assertCommittablePaths()` validation.
- Confirm via `askuser` Pattern S-3 before the mutation — the
  roadmap.yaml write is visible in git history forever.

**Don't:**
- Hand-edit ROADMAP.md. The synthetic backlog milestone renders via
  `lib/roadmap-render.cjs` (Plan 10-01-T05); direct edits will be
  overwritten on the next render pass.
- Use the preview number as the final commit subject. A concurrent
  `/np:add-backlog` may race and claim the same number; only the
  lock-returned `BACKLOG_NUMBER` is authoritative.
- Invoke host-specific prompt tools directly (the BARE_ASKUSER lint
  in `bin/check-workflows.cjs` blocks them) — always route through
  `node np-tools.cjs askuser --json '…'`.
- Add a `metrics record` block. There is no Task/Spawn site here;
  Pitfall 9 / `workflow-missing-metrics` is exempt.
</scope_guardrail>

## Output

- `.nubos-pilot/ROADMAP.md` — updated via
  `lib/roadmap-render.cjs` to include the new 999.X entry under
  the synthetic `## Backlog` H2 section (Plan 10-01-T05).
- `.nubos-pilot/roadmap.yaml` — canonical source-of-truth with the
  new phase appended to the `backlog` milestone's `phases:` array.
- `.nubos-pilot/phases/999.X-<slug>/.gitkeep` — empty stub so
  subsequent `/np:discuss-phase 999.X` invocations have a working
  directory.
- One atomic git commit
  `docs(10): add backlog item 999.X — <title>` containing the three
  files above (ADR-0004).

## Success Criteria

- [ ] Title validated (non-empty) before any roadmap read.
- [ ] Preview number generated via
      `node np-tools.cjs phase next-decimal 999 --raw` — info only.
- [ ] Confirmation via `askuser` Pattern S-3 before mutation.
- [ ] Authoritative 999.X comes from
      `lib/roadmap.cjs.addBacklogEntry` return value (NOT the
      preview number).
- [ ] Phase directory created at
      `${STATE_DIR}/phases/${BACKLOG_NUMBER}-${BACKLOG_SLUG}/` with
      `.gitkeep` stub.
- [ ] Single atomic commit via `np-tools.cjs commit` containing
      ROADMAP.md + roadmap.yaml + `.gitkeep`.
- [ ] Lint clean under `bin/check-workflows.cjs` — no BARE_ASKUSER
      violations and no DIRECT_READ pattern matches for the project
      state directory.

## Related Workflows

- **`/np:add-todo <title>`** — smaller-scope pending todo capture
  with STATE.md counter increment. Use when the idea is actionable
  within a current plan.
- **`/np:note [--global] <text>`** — zero-friction free-form capture
  with no ROADMAP mutation. Use when the idea isn't yet scoped.
- **`/np:discuss-phase 999.X`** — explore a backlog item
  interactively to graduate it from parking-lot to active planning.
- **`/np:plan-phase 999.X`** — produce a CONTEXT/RESEARCH/PLAN stack
  for a backlog item once it is ready for implementation.

## Design Notes

Numbering + roadmap mutation run through
`lib/roadmap.cjs.addBacklogEntry` (Plan 10-01-T05). The lib-level
helper is file-locked and touches both the canonical `roadmap.yaml`
AND the rendered ROADMAP.md atomically — ROADMAP.md is rendered
output, not source-of-truth. The `.gitkeep` phase-dir stub keeps the
working directory legible before planning lands.
