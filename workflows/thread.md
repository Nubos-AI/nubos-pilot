---
command: np:thread
description: Create or resume a cross-session thread at .nubos-pilot/threads/<slug>.md. Lifecycle status OPEN → IN_PROGRESS (auto on resume) → RESOLVED (user edits manually, no close command per D-19 Claude's Discretion). No agent spawn. Project-scope only.
argument-hint: <slug-or-title>
---

# np:thread

Implements UTIL-06. Threads are lightweight cross-session context
stores for work spanning multiple sessions but not belonging to a
specific phase. They live under `.nubos-pilot/threads/<slug>.md` with
lifecycle `OPEN → IN_PROGRESS → RESOLVED` in their frontmatter.

Two modes, selected by presence of the target file:

- **create** — writes a fresh file with `status: OPEN`; one atomic
  docs commit (ADR-0004).
- **resume** — reads the file, bumps `status: OPEN → IN_PROGRESS`
  (never downgraded), updates `last_resumed`, displays content.
  Resume does **not** commit — `last_resumed` churn is too noisy.

No close command (D-19). User manually sets `status: RESOLVED`.
Pure-CRUD — no agent spawn, no metrics record (Pitfall 9 exempt).

## Initialize

```bash
SLUG_ARG="$*"
if [[ -z "$SLUG_ARG" ]]; then
  echo "Usage: /np:thread <slug-or-title>" >&2
  exit 2
fi
SLUG=$(node .nubos-pilot/bin/np-tools.cjs generate-slug "$SLUG_ARG" --raw)
if [[ -z "$SLUG" ]]; then
  echo "Error: argument produced no slug-safe characters." >&2
  exit 1
fi
STATE_DIR=$(node .nubos-pilot/bin/np-tools.cjs state-dir)
THREADS_DIR="${STATE_DIR}/threads"
THREAD_PATH="${THREADS_DIR}/${SLUG}.md"
TODAY=$(date +%Y-%m-%d)
mkdir -p "$THREADS_DIR"
```

Slug via `generate-slug` (wraps `lib/layout.cjs.slugify`) — only
`[a-z0-9-]` enters the filename; prevents path traversal.

## Create vs Resume Branch

```bash
if [[ -f "$THREAD_PATH" ]]; then
  MODE="resume"
else
  MODE="create"
fi
```

## Create Branch (MODE = create)

Use the `Write` tool to create `$THREAD_PATH` with the frontmatter +
body template below (not a bash heredoc). `${SLUG}` / `${SLUG_ARG}` /
`${TODAY}` are substituted from the variables above.

```markdown
---
slug: <SLUG>
status: OPEN
created: <TODAY>
last_resumed: <TODAY>
---

# Thread: <SLUG_ARG>

## Status: OPEN

## Goal

<TBD — user fills in>

## Context

*Created from conversation on <TODAY>.*

## References

- *(add links, file paths, or issue numbers)*

## Next Steps

- *(what the next session should do first)*
```

Route the commit through `node .nubos-pilot/bin/np-tools.cjs commit` so
`lib/git.cjs.assertCommittablePaths()` validates the path before
`git add` (path-traversal guard from Plan 10-01-T04).

```bash
if [[ "$MODE" == "create" ]]; then
  node .nubos-pilot/bin/np-tools.cjs commit "docs(10): create thread — ${SLUG}" --files "$THREAD_PATH"
  echo "Thread created: $THREAD_PATH"
  echo ""
  echo "Resume anytime with: /np:thread ${SLUG}"
fi
```

## Resume Branch (MODE = resume)

Two in-place updates via `lib/core.cjs.atomicWriteFileSync`
(ADR-0004 crash-safety):

1. If current `status === "OPEN"`, bump to `IN_PROGRESS`. Status is
   **never downgraded**: `IN_PROGRESS` / `RESOLVED` remain as-is.
2. `last_resumed: <TODAY>` — always refreshed.

Frontmatter parsed via `lib/frontmatter.cjs.extractFrontmatter` (read)
and re-serialised via a hand-rolled minimal FM writer (the lib ships
a reader only) that emits one `key: value` per field in insertion
order.

```bash
if [[ "$MODE" == "resume" ]]; then
  node .nubos-pilot/bin/np-tools.cjs thread-resume "$THREAD_PATH" --today "$TODAY" > /dev/null
  echo "Thread resumed: $THREAD_PATH"
  echo ""
  echo "--- thread content ---"
  cat "$THREAD_PATH"
fi
```

Resume never commits. `last_resumed` churn would flood the log.

## Report

Echo `Thread <MODE>d: <THREAD_PATH>` with slug/mode/today to stdout.

## Scope Guardrail

<scope_guardrail>
**Do:**
- Use `slugify`-generated slug (prevents path traversal).
- Preserve status monotonicity on resume: `OPEN → IN_PROGRESS` only.
- Let the user manually flip `status: RESOLVED` (D-19 — no close
  command in this adapted port).
- Use `lib/core.cjs.atomicWriteFileSync` for any in-place rewrite
  (ADR-0004 crash-safety).
- Route the create-branch commit through `node .nubos-pilot/bin/np-tools.cjs commit`.

**Don't:**
- Commit `last_resumed`-only updates. Resume is commit-free.
- Invoke host-specific prompt tools directly (the BARE_ASKUSER lint
  in `bin/check-workflows.cjs` blocks them) — route through
  `node .nubos-pilot/bin/np-tools.cjs askuser --json '…'`.
- Bypass `atomicWriteFileSync` — rename pair is the invariant.
- Add a `metrics record` block. No Task/Spawn site here; Pitfall 9 /
  `workflow-missing-metrics` is exempt.
</scope_guardrail>

## Output

- `.nubos-pilot/threads/<slug>.md` — thread file. Create mode writes
  a new file with four-field frontmatter (`slug / status:OPEN /
  created / last_resumed`) and four-section body. Resume mode
  updates in-place: `status: IN_PROGRESS` (if OPEN) + refreshed
  `last_resumed`.
- **Create mode only:** one atomic commit
  `docs(10): create thread — <slug>` (ADR-0004).
- **Resume mode:** no commit.

## Success Criteria

- [ ] Slug via `generate-slug` (T-10-06-01 mitigation).
- [ ] Threads dir via `lib/core.cjs.projectStateDir`.
- [ ] Mode selected by `[[ -f $THREAD_PATH ]]`.
- [ ] Create: `Write` tool + `np-tools.cjs commit` atomic unit.
- [ ] Resume: `extractFrontmatter` round-trip;
      `OPEN → IN_PROGRESS` only; `last_resumed` refreshed.
- [ ] Resume writes via `atomicWriteFileSync`; no commit.
- [ ] Lint clean under `bin/check-workflows.cjs` — no BARE_ASKUSER
      violations, no DIRECT_READ matches.

## Related Workflows

- **`/np:add-todo <title>`** — smaller-scope pending todo capture.
- **`/np:note [--global] <text>`** — zero-friction free-form capture.

## Design Notes

No list-all mode (no-arg invocation errors). Threads live under
`.nubos-pilot/threads/` per D-14. Lifecycle frontmatter is the
machine-readable source-of-truth (no free-text heading parsing).
