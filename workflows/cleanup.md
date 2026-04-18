---
command: np:cleanup
description: Archive completed milestones to .nubos-pilot/archive/v<X.Y>/ (D-06). Collapses each archived milestone's ROADMAP.md block into a <details> summary (D-07). Idempotent per D-08 (target-path existence check). One atomic chore commit (D-09). Path-preserving git mv (rename history kept).
---

# np:cleanup

Implements UTIL-08. Enumerates milestones whose every phase is marked
complete, previews the archive plan, moves phase directories into
`.nubos-pilot/archive/v<X.Y>/` with `git mv` (preserving rename
history), collapses the milestone's ROADMAP.md block into a
`<details>` wrapper via `lib/roadmap.cjs.collapseMilestone` (landed
Plan 10-01-T05), and commits the whole operation as a single atomic
chore unit.

Four deliberate design choices:

- **D-06** — archive layout lives at `.nubos-pilot/archive/v<X.Y>/`,
  the canonical home under the project-state tree (ADR-0005
  3-file-tree invariant).
- **D-07** — collapsed milestones render as `<details>` blocks in
  the generated ROADMAP.md rather than being deleted. Milestone
  history stays visible on demand.
- **D-08** — idempotency. If `archive/v<X.Y>/` already exists for a
  milestone, the workflow skips it. Partial-move recovery is safe
  because per-milestone state is all-or-nothing.
- **D-09** — single atomic commit per run. All milestones archived
  in one invocation land in one commit (ADR-0004).

Security-relevant defenses built in:

- **T-10-06-03 (partial-move)** — idempotent skip + per-mv failure
  abort + single commit after ALL mvs succeed.
- **T-10-06-04 (symlink traversal)** — `lstat`-based reject before
  every `git mv` (pattern reused from Phase 7 Plan 07-02 backup.cjs).

Pure CRUD / filesystem workflow — no agent spawn, no resolve-model,
no metrics record. Pitfall 9 / `workflow-missing-metrics` is exempt.

## Initialize

```bash
STATE_DIR=$(node -e "console.log(require('./lib/core.cjs').projectStateDir(process.cwd()))")
ARCHIVE_ROOT="${STATE_DIR}/archive"
mkdir -p "$ARCHIVE_ROOT"

DRY_RUN_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN_FLAG="1" ;;
  esac
done
```

## Enumerate Completed Milestones

All enumeration happens in Node so we can consume `lib/roadmap.cjs`
parse output directly (not re-implement YAML parsing). The query
filters: (a) skip the synthetic `backlog` milestone, (b) require
every phase in the milestone to have `status === "complete"`, (c)
skip if `archive/<id>/` already exists (D-08 idempotency), (d) list
the phase directories that exist on disk.

```bash
ACTIONS_JSON=$(node -e '
  const { parseRoadmap } = require("./lib/roadmap.cjs");
  const fs = require("node:fs");
  const path = require("node:path");
  const stateDir = process.argv[1];
  const archive = path.join(stateDir, "archive");
  const phasesRoot = path.join(stateDir, "phases");
  const parsed = parseRoadmap(process.cwd());
  const raw = parsed && parsed.doc ? parsed.doc : null;
  const out = [];
  for (const m of (raw && raw.milestones) || []) {
    if (!m || m.id === "backlog") continue;
    const phases = m.phases || [];
    if (phases.length === 0) continue;
    const allDone = phases.every((ph) => ph && ph.status === "complete");
    if (!allDone) continue;
    const target = path.join(archive, m.id);
    if (fs.existsSync(target)) continue;
    let entries = [];
    try { entries = fs.readdirSync(phasesRoot, { withFileTypes: true }); } catch (_e) {}
    const phaseDirs = [];
    for (const ph of phases) {
      const padded = String(ph.number).padStart(2, "0");
      const match = entries.filter((e) => e.isDirectory())
        .map((e) => e.name)
        .find((n) => n === padded || n.startsWith(padded + "-"));
      if (match) phaseDirs.push(path.join(phasesRoot, match));
    }
    if (phaseDirs.length === 0) continue;
    out.push({ milestone_id: m.id, target_dir: target, phase_dirs: phaseDirs });
  }
  process.stdout.write(JSON.stringify(out));
' "$STATE_DIR")

ACTION_COUNT=$(echo "$ACTIONS_JSON" | jq 'length')
if [[ "$ACTION_COUNT" -eq 0 ]]; then
  echo "Nothing to archive (no complete + un-archived milestones)."
  exit 0
fi
```

## Symlink Safety Check (T-10-06-04)

Before any `git mv`, `lstat` each phase directory and reject
symlinks. A symlinked phase dir would escape the archive root on
rename (the link target might point outside `.nubos-pilot/phases/`).
Pattern reused from Phase 7 Plan 07-02 `backup.cjs`.

```bash
SYMLINK_FOUND=$(node -e '
  const fs = require("node:fs");
  const actions = JSON.parse(process.argv[1]);
  for (const a of actions) {
    for (const d of a.phase_dirs) {
      try {
        const st = fs.lstatSync(d);
        if (st.isSymbolicLink()) { process.stdout.write(d); process.exit(0); }
      } catch (_e) {}
    }
  }
' "$ACTIONS_JSON")
if [[ -n "$SYMLINK_FOUND" ]]; then
  echo "Error: symlink detected at $SYMLINK_FOUND — refusing to archive. Remove or unlink and retry." >&2
  exit 1
fi
```

## Dry-Run Summary + askuser Confirm

Show the plan before mutating anything. `--dry-run` exits after the
preview; otherwise confirm via `askuser` Pattern S-3.

```bash
echo "$ACTIONS_JSON" | jq -r '.[] | "Milestone " + .milestone_id + ":\n  → " + .target_dir + "\n  Phases: " + ([.phase_dirs[] | split("/") | last] | join(", "))'

if [[ -n "$DRY_RUN_FLAG" ]]; then
  echo "Dry-run: no changes made."
  exit 0
fi

CHOICE=$(node np-tools.cjs askuser --json '{
  "type": "select",
  "header": "Cleanup Preview",
  "question": "Archive '"$ACTION_COUNT"' milestone(s) listed above?",
  "options": [
    {"label": "Yes — archive listed phases", "description": "Creates .nubos-pilot/archive/<id>/ + ROADMAP details-block + 1 atomic commit"},
    {"label": "Cancel", "description": "Exits without mutation"}
  ]
}')
case "$CHOICE" in
  "Cancel"*) exit 0 ;;
esac
```

## Execute Archive

Per-milestone loop: create the archive target dir, re-`lstat` every
phase directory IMMEDIATELY before each `git mv` and abort if a
symlink is detected, then call `lib/roadmap.cjs.collapseMilestone`
to flip the `collapsed: true` flag so `lib/roadmap-render.cjs` wraps
the block in a `<details>` summary (landed Plan 10-01-T05).

The symlink re-check is intentionally collocated with `git mv`
inside ONE Node process (no intermediate bash fork) so there is no
TOCTOU window between check and move. The earlier "Symlink Safety
Check" section is a defense-in-depth pre-flight that fails fast
before the askuser confirm; this block is the authoritative
just-in-time guard (T-10-06-04 mitigation).

```bash
node -e '
  const fs = require("node:fs");
  const { execFileSync } = require("node:child_process");
  const { collapseMilestone } = require("./lib/roadmap.cjs");
  const actions = JSON.parse(process.argv[1]);
  for (const a of actions) {
    fs.mkdirSync(a.target_dir, { recursive: true });
    for (const src of a.phase_dirs) {
      const st = fs.lstatSync(src);
      if (st.isSymbolicLink()) {
        process.stderr.write("Error: symlink detected at " + src + " — refusing to archive.\n");
        process.exit(1);
      }
      try {
        execFileSync("git", ["mv", src, a.target_dir + "/"], { stdio: "inherit" });
      } catch (err) {
        process.stderr.write("git mv failed on " + src + "\n");
        process.exit(1);
      }
    }
    collapseMilestone(a.milestone_id);
  }
' "$ACTIONS_JSON"
```

`git mv` preserves rename history (per Plan §interfaces / Research
§4) — later blame/log on the archived files still traces back
through the rename.

## Commit (D-09)

Single atomic commit per run. All milestones archived together land
in one `chore(10): ...` commit. Subject line names the first
milestone and a count suffix when N > 1.

```bash
FIRST_MILESTONE=$(echo "$ACTIONS_JSON" | jq -r '.[0].milestone_id')
SUFFIX=""
if [[ "$ACTION_COUNT" -gt 1 ]]; then
  SUFFIX=" and $((ACTION_COUNT - 1)) other(s)"
fi
node np-tools.cjs commit "chore(10): archive milestone ${FIRST_MILESTONE}${SUFFIX}" \
  --files "${STATE_DIR}/archive/" "${STATE_DIR}/ROADMAP.md" "${STATE_DIR}/roadmap.yaml" "${STATE_DIR}/phases/"
```

## If a cleanup is interrupted

If `git mv` fails mid-operation (power loss, Ctrl-C), the working
tree may be in a mixed state — some phase dirs moved, some not.
Running `/np:cleanup` again is SAFE because:

- **Per-milestone idempotency (D-08):** milestones whose archive
  target dir already exists are skipped.
- Within a milestone, `git mv` on a non-existent source fails
  loudly; the workflow aborts WITHOUT committing.

If you see a partial state, either:

1. Run `/np:cleanup` again — re-processes only the un-archived
   milestones.
2. Manually `git mv` the remaining phase dirs into their archive
   target, then run
   `node -e "require('./lib/roadmap.cjs').collapseMilestone('v<X.Y>')"`
   and commit manually.

No automatic `git reset --hard HEAD` is performed — that would
destroy unrelated uncommitted work (Open Question #3 recommendation,
T-10-06-03 mitigation).

## Scope Guardrail

<scope_guardrail>
**Do:**
- Use `git mv` (not plain `mv`) — preserves rename history for
  `git blame` / `git log --follow`.
- Check target-dir existence BEFORE attempting mvs (D-08
  idempotency).
- Reject symlinks via `lstat` before every `git mv` (T-10-06-04).
- Single atomic commit after ALL mvs + `collapseMilestone` mutations
  succeed (D-09).
- Show the dry-run preview before any mutation (S-3 pattern).

**Don't:**
- `git reset --hard` on failure (destroys unrelated user work per
  Open Question #3 / T-10-06-03).
- Mutate archive targets that already exist (idempotency).
- Skip the `collapseMilestone` call — ROADMAP must reflect the
  archive state (D-07).
- Invoke host-specific prompt tools directly (the BARE_ASKUSER lint
  in `bin/check-workflows.cjs` blocks them) — route through
  `node np-tools.cjs askuser --json '…'`.
- Add a `metrics record` block. No Task/Spawn site; Pitfall 9 /
  `workflow-missing-metrics` is exempt.
</scope_guardrail>

## Output

- `.nubos-pilot/archive/v<X.Y>/` — one directory per archived
  milestone containing the milestone's phase dirs (moved via
  `git mv`, rename history preserved).
- `.nubos-pilot/ROADMAP.md` — regenerated with `<details>` wrapper
  around each archived milestone's block (D-07 via
  `lib/roadmap.cjs.collapseMilestone`).
- `.nubos-pilot/roadmap.yaml` — `collapsed: true` and `collapsed_at`
  set for each archived milestone.
- `.nubos-pilot/phases/` — archived phase dirs removed.
- One atomic git commit
  `chore(10): archive milestone <id> [and N other(s)]` (ADR-0004,
  D-09).

## Success Criteria

- [ ] Synthetic `backlog` milestone is never archived.
- [ ] Only milestones with `every phase status === "complete"` are
      considered.
- [ ] Milestones whose archive target already exists are skipped
      (D-08 idempotency).
- [ ] Symlinks in candidate phase dirs abort the workflow
      (T-10-06-04 mitigation).
- [ ] `--dry-run` exits after the preview with no mutation.
- [ ] Confirmation via `askuser` Pattern S-3 before any mutation.
- [ ] Phase dirs moved via `git mv` (preserves rename history).
- [ ] `lib/roadmap.cjs.collapseMilestone` called for every archived
      milestone (D-07).
- [ ] Single atomic commit via `np-tools.cjs commit` after ALL mvs +
      collapseMilestone calls succeed (D-09).
- [ ] Commit subject shape `chore(10): archive milestone <id>
      [and N other(s)]`.
- [ ] Partial-move recovery is idempotent — re-running picks up
      only un-archived milestones (T-10-06-03 mitigation).
- [ ] Lint clean under `bin/check-workflows.cjs` — no BARE_ASKUSER
      violations, no DIRECT_READ matches.

## Related Workflows

- **`/np:session-report`** — per-session snapshot report (distinct
  from milestone archival).
- **`/np:stats`** — read-only current-state view.
- **`/np:add-backlog <title>`** — adds ideas to the synthetic
  backlog milestone (which `/np:cleanup` deliberately never
  archives).

## Design Notes

D-06 fixes archive layout at `.nubos-pilot/archive/v<X.Y>/` — the
canonical home under the project-state tree (ADR-0005). D-07 collapse
renders archived milestones as `<details>` blocks instead of deleting
them so history stays visible on demand. D-08 idempotency via
existence-check enables safe re-runs. D-09 single-commit shape matches
ADR-0004. Symlink rejection via `lstat` (T-10-06-04) and path-preserving
`git mv` guard against filesystem-level surprises.
