---
command: np:add-todo
description: Capture a pending todo to .nubos-pilot/todos/pending/YYYY-MM-DD-<slug>.md; increments STATE.md pending_todos count via lib/state.cjs.mutateState single-writer lock. One atomic docs commit. No agent spawn.
---

# np:add-todo

Implements UTIL-05a. Captures a free-form idea, task, or issue that
surfaces mid-session as a structured
pending todo so the originating workflow can continue without losing
context. The todo lives under `.nubos-pilot/todos/pending/` and the
pending-todo counter in STATE.md is bumped via the single-writer lock
in `lib/state.cjs.mutateState` (D-20 invariant).

This is a pure-CRUD workflow — no agent spawn, no resolve-model, no
metrics record. The `workflow-missing-metrics` lint in
`bin/check-workflows.cjs` only fires on `Task(` / `Spawn agent=` sites,
so CRUD-only workflows are exempt (Pitfall 9 resolution from
Plan 10-05). All interactive prompts route through
`node np-tools.cjs askuser --json` per INST-03.

## Initialize

```bash
DESCRIPTION="$*"
if [[ -z "$DESCRIPTION" ]]; then
  echo "Usage: /np:add-todo <description>" >&2
  exit 2
fi

INIT=$(node np-tools.cjs init add-todo "$DESCRIPTION")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi

SLUG=$(echo "$INIT" | jq -r '.slug')
DATE=$(echo "$INIT" | jq -r '.date')
TIMESTAMP=$(echo "$INIT" | jq -r '.timestamp')
PENDING_DIR=$(echo "$INIT" | jq -r '.pending_dir')
STATE_PATH=$(echo "$INIT" | jq -r '.state_path')
TODO_PATH="${PENDING_DIR}/${DATE}-${SLUG}.md"
```

Extract from init JSON: `commit_docs`, `date`, `timestamp`, `slug`,
`todo_count`, `todos_dir_exists`, `pending_dir`, `state_path`. The
init handler sanitises the slug through `lib/phase.cjs.phaseSlug`
(strips to `[a-z0-9-]` only; T-10-05-01 filename-injection
mitigation) and validates the description length (<= 500 chars) before
any filesystem write occurs.

## Create Pending Dir

```bash
mkdir -p "$PENDING_DIR"
```

The directory is created idempotently; no-op if it already exists.

## Duplicate Check

If a todo with this `DATE-SLUG` already exists in `pending/`,
let the user resolve the collision via `askuser` Pattern S-3. The
prompt surfaces four options: re-run (overwrite), view existing,
skip (keep both), or rename-with-counter (append `-2`, `-3`, etc.).

```bash
if [[ -f "$TODO_PATH" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Duplicate todo",
    "question": "A todo already exists at '"${TODO_PATH}"'. What would you like to do?",
    "options": [
      {"label": "Re-run — overwrite existing todo", "description": "Replaces the current todo body."},
      {"label": "View — display the existing todo and exit", "description": "No changes."},
      {"label": "Skip — keep existing and exit", "description": "Leaves the file untouched."},
      {"label": "Rename — append -2/-3 counter to filename", "description": "Writes a new file beside the existing one."}
    ]
  }')
  case "$CHOICE" in
    "View"*) cat "$TODO_PATH"; exit 0 ;;
    "Skip"*) exit 0 ;;
    "Rename"*)
      i=2
      while [[ -f "${PENDING_DIR}/${DATE}-${SLUG}-${i}.md" ]]; do i=$((i + 1)); done
      TODO_PATH="${PENDING_DIR}/${DATE}-${SLUG}-${i}.md"
      ;;
  esac
fi
```

## Write Todo File

Use the `Write` tool (not a bash heredoc) to create `$TODO_PATH` with
the following frontmatter + body. The agent invokes the `Write` tool
directly — this is documented here as the contract, not executed as a
shell step.

```markdown
---
title_short: <first 100 chars of DESCRIPTION, single line>
created: <TIMESTAMP>
status: pending
---

<DESCRIPTION>
```

Specifically: `title_short` = the first 100 chars of `$DESCRIPTION`
flattened to a single line (newlines replaced with spaces) so the
frontmatter stays parseable even when the raw description contains
YAML metacharacters or multiple lines, `created` = `$TIMESTAMP`
(init-supplied ISO-8601), `status` always `pending`. The body carries
the full raw description verbatim so the file is self-contained when
read weeks later. This mirrors the `note.md` pattern (truncated
frontmatter field + full body) and pairs with the
`add-todo-invalid-description` YAML-separator guard in
`bin/np-tools/add-todo.cjs._buildPayload`. Do **not** include
`status: completed` or any other status here — the completion flow
lives in a separate workflow.

## Update STATE.md

STATE.md is mutated through `lib/state.cjs.mutateState` which wraps
`withFileLock` (D-20 single-writer invariant, T-10-05-06 mitigation).
The node one-liner is the sanctioned surface; direct filesystem
reads of the project state directory from this workflow would bypass
the lock and are explicitly forbidden by the check-workflows lint.

```bash
node -e "require('./lib/state.cjs').mutateState(function (doc) { doc.frontmatter.pending_todos = (doc.frontmatter.pending_todos || 0) + 1; return doc; });"
```

The mutator increments the `pending_todos` counter on the STATE.md
frontmatter. The lock serialises concurrent writers (two parallel
`/np:add-todo` invocations converge on the correct count).

## Commit

Route through `node np-tools.cjs commit` so
`lib/git.cjs.assertCommittablePaths()` validates the paths before
`git add` (path-traversal guard from Plan 10-01-T04).

```bash
node np-tools.cjs commit "docs(10): add todo — ${SLUG}" --files "$TODO_PATH" "$STATE_PATH"
```

Both the new todo file and STATE.md land in a single atomic commit per
ADR-0004 (one commit per unit).

## Report

```
Todo saved: $TODO_PATH

  Title:  $DESCRIPTION
  Status: pending
  Created: $TIMESTAMP

Pending todo count bumped via lib/state.cjs.mutateState.
Use /np:next to surface this todo in the next-step picker.
```

## Scope Guardrail

<scope_guardrail>
**Do:**
- Always go through `lib/state.cjs.mutateState` for STATE.md updates
  (D-20 single-writer lock; T-10-05-06 mitigation).
- Use the `Write` tool for the new markdown file — never a bash
  heredoc or `echo >`.
- Route the final commit through `node np-tools.cjs commit` so
  `lib/git.cjs.assertCommittablePaths()` runs the gitignore-guard.
- Derive the slug via `node np-tools.cjs init add-todo` (filename
  sanitisation, T-10-05-01 mitigation) — not via ad-hoc `sed`.
- Commit todo file + STATE.md together as a single atomic unit.

**Don't:**
- Invoke host-specific prompt tools directly (the BARE_ASKUSER lint in
  `bin/check-workflows.cjs` blocks them) — always route through
  `node np-tools.cjs askuser --json '…'`.
- Read STATE.md via raw filesystem calls (DIRECT_READ lint blocks
  those patterns) — let `mutateState` handle the lock.
- Add a `metrics record` block. There is no Task/Spawn site in this
  workflow, so Pitfall 9 / the `workflow-missing-metrics` lint is
  exempt.
- Touch the completed-todos subtree — completion is a separate
  workflow concern.
</scope_guardrail>

## Output

- `.nubos-pilot/todos/pending/YYYY-MM-DD-<slug>.md` — new todo file
  with `title / created / status: pending` frontmatter and the
  description as body text.
- `.nubos-pilot/STATE.md` — `pending_todos` frontmatter counter
  incremented via `mutateState`.
- One atomic git commit `docs(10): add todo — <slug>` containing
  both files (ADR-0004).

## Success Criteria

- [ ] Description validated (non-empty, <= 500 chars) via the init
      handler before any filesystem write.
- [ ] Slug derived via `phaseSlug` so only `[a-z0-9-]` enter the
      filename (T-10-05-01 mitigation).
- [ ] Pending todo directory created idempotently.
- [ ] Duplicate collisions resolved via `askuser` Pattern S-3
      (Re-run / View / Skip / Rename-with-counter).
- [ ] Todo file written via the `Write` tool with valid frontmatter.
- [ ] STATE.md `pending_todos` counter incremented via
      `lib/state.cjs.mutateState` (D-20 single-writer lock).
- [ ] Both files committed atomically via `np-tools.cjs commit`.
- [ ] Lint clean under `bin/check-workflows.cjs` — no BARE_ASKUSER
      violations and no DIRECT_READ pattern matches for the project
      state directory.

## Related Workflows

- **`/np:note <text>`** — zero-friction free-form capture (no STATE
  mutation, no todo semantics). Use when the idea isn't yet actionable.
- **`/np:add-backlog <title>`** — larger-scope capture for ideas that
  deserve a full backlog phase (`999.x` in ROADMAP.md).
- **`/np:next`** — surfaces the next actionable item; a pending todo
  can be the pointer when no active plan has a runnable task.
