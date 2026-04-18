---
command: np:note
description: Capture a free-form note to markdown. Defaults to project scope (.nubos-pilot/notes/YYYY-MM-DD-<slug>.md, committed). Use --global for sensitive/cross-project notes (~/.nubos-pilot/notes/YYYY-MM-DD-<slug>.md, NOT committed). No agent spawn, no STATE mutation.
---

# np:note

Implements UTIL-05b. Zero-friction idea capture that writes the note
text verbatim to a timestamped markdown file.
Unlike `/np:add-todo`, `/np:note` does NOT touch STATE.md and has no
pending-todo semantics — it is the fastest-possible surface for
"capture now, triage later".

This workflow ships with a project-default + global-fallback scope
model. Project scope (`.nubos-pilot/notes/YYYY-MM-DD-<slug>.md`,
committed per ADR-0004) is the happy path. The `--global` flag routes
to `~/.nubos-pilot/notes/` and intentionally does **not** commit —
global notes live outside any repository (Pitfall 10: the global
branch bypasses `lib/core.cjs.findProjectRoot` entirely so the tool
works from any cwd, including directories that have no project at
all).

This is a pure-CRUD workflow — no agent spawn, no resolve-model, no
metrics record. The `workflow-missing-metrics` lint in
`bin/check-workflows.cjs` only fires on `Task(` / `Spawn agent=` sites,
so CRUD-only workflows are exempt (Pitfall 9 resolution from
Plan 10-05). Interactive prompts route through
`node np-tools.cjs askuser --json` per INST-03.

## Initialize

```bash
SCOPE="project"
TEXT_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --global) SCOPE="global" ;;
    *)        TEXT_ARGS+=("$arg") ;;
  esac
done
TEXT="${TEXT_ARGS[*]}"
if [[ -z "$TEXT" ]]; then
  echo "Usage: /np:note [--global] <text>" >&2
  exit 2
fi
```

The `--global` flag is stripped from anywhere in `$@` (beginning,
middle, or end of the argv list) before the remaining args are joined
into `$TEXT`. Empty text after stripping is an error — there is no
`list` or `promote` subcommand here (deferred to a future
capture-management plan).

## Compute Paths

Scope branching is explicit (T-10-05-02 mitigation + Pitfall 10
guidance). The project branch walks the `lib/core.cjs.projectStateDir`
resolver which asserts the cwd is inside a project. The global branch
sidesteps that resolver and hardcodes `HOME + /.nubos-pilot/notes`.

```bash
if [[ "$SCOPE" == "global" ]]; then
  NOTES_DIR="$HOME/.nubos-pilot/notes"
else
  NOTES_DIR=$(node -e "console.log(require('./lib/core.cjs').projectStateDir(process.cwd()) + '/notes')")
fi
mkdir -p "$NOTES_DIR"
DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SLUG=$(node np-tools.cjs generate-slug "$TEXT" --raw)
if [[ -z "$SLUG" ]]; then
  echo "Error: note text produced no slug-safe characters." >&2
  exit 1
fi
NOTE_PATH="${NOTES_DIR}/${DATE}-${SLUG}.md"
```

Slug generation is delegated to `node np-tools.cjs generate-slug`
(which wraps `lib/phase.cjs.phaseSlug`) — the same filename-safety
rails used by every capture workflow (T-10-05-01 & T-10-05-02
mitigation; only `[a-z0-9-]` enter the filename).

## Duplicate Check

Same `date + slug` collisions are resolved via `askuser` Pattern S-3.
The fourth option, "append-timestamp", adds the current `HHMM` to the
filename so rapid-fire notes on the same topic each get their own
file.

```bash
if [[ -f "$NOTE_PATH" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Duplicate note",
    "question": "A note already exists at '"${NOTE_PATH}"'. What would you like to do?",
    "options": [
      {"label": "Re-run — overwrite existing note",      "description": "Replaces the body with the new text."},
      {"label": "View — display existing note and exit",  "description": "No changes."},
      {"label": "Skip — keep existing and exit",          "description": "Leaves the file untouched."},
      {"label": "Append-timestamp — add HHMM suffix",     "description": "Writes a new file with a time-suffixed name."}
    ]
  }')
  case "$CHOICE" in
    "View"*) cat "$NOTE_PATH"; exit 0 ;;
    "Skip"*) exit 0 ;;
    "Append-timestamp"*)
      HHMM=$(date +%H%M)
      NOTE_PATH="${NOTES_DIR}/${DATE}-${SLUG}-${HHMM}.md"
      ;;
  esac
fi
```

## Write Note File

Use the `Write` tool to create `$NOTE_PATH` with the following
frontmatter + body. The first 100 characters of `$TEXT` flow into a
short `text:` field for quick scanning; the full verbatim text lives
in the body so notes containing `:` characters or multi-line content
cannot break the YAML frontmatter (T-10-05-03 defence-in-depth
variant — the full text is never interpolated into frontmatter).

```markdown
---
text: <first line of TEXT, truncated to 100 chars>
created: <TIMESTAMP>
scope: project | global
promoted: false
---

<TEXT>
```

The note text is captured verbatim — typos, emoji, capitalisation are
all preserved. The `promoted` flag starts as `false`; a future
capture-management workflow will flip it when a note is promoted to a
todo.

## Commit (project scope only)

Project-scope notes commit to git per ADR-0004 so the capture shows
up in the repo history. Global-scope notes do **not** commit — they
live under `$HOME/.nubos-pilot/notes/` which is outside any repo, and
committing would require running `git` against an unknown repo (or
none). The scope-branching commit step is the single-source-of-truth
for that distinction.

```bash
if [[ "$SCOPE" == "project" ]]; then
  node np-tools.cjs commit "docs(10): add note — ${SLUG}" --files "$NOTE_PATH"
else
  echo "Global note written to $NOTE_PATH (not committed — lives outside any project)." >&2
fi
```

## Report

```
Note saved ($SCOPE): $NOTE_PATH

  Text:    $TEXT
  Created: $TIMESTAMP
  Scope:   $SCOPE
```

## Scope Guardrail

<scope_guardrail>
**Do:**
- Use `--global` for sensitive data that must not enter git history
  (API keys, personal context, cross-project thoughts). Project scope
  writes are committed; treat them as public.
- Let `lib/core.cjs.projectStateDir` throw on a non-project cwd for
  project scope — the error message is clearer than a silent write
  to a resolved-to-unexpected-root.
- For global scope, bypass `lib/core.cjs.findProjectRoot` completely
  (Pitfall 10) so the workflow works from any cwd, including non-repo
  directories.
- Derive the slug via `node np-tools.cjs generate-slug` so only
  `[a-z0-9-]` enter the filename.
- Route the project-scope commit through `node np-tools.cjs commit`
  for `lib/git.cjs.assertCommittablePaths()` validation.

**Don't:**
- Commit global-scope notes. They live outside any repo; committing
  them from this workflow would write into whatever git repo happens
  to contain the current cwd.
- Put the full note text in the frontmatter `text:` field —
  multi-line content or `:` characters would break YAML parsing
  (T-10-05-03 defence-in-depth).
- Invoke host-specific prompt tools directly (the BARE_ASKUSER lint
  in `bin/check-workflows.cjs` blocks them) — always route through
  `node np-tools.cjs askuser --json '…'`.
- Mutate STATE.md. Notes are lighter-weight than todos; there is no
  pending-note counter. If you need STATE semantics, use
  `/np:add-todo` instead.
- Add a `metrics record` block. There is no Task/Spawn site here;
  Pitfall 9 / `workflow-missing-metrics` is exempt.
</scope_guardrail>

## Output

- `.nubos-pilot/notes/YYYY-MM-DD-<slug>.md` (project scope) OR
  `~/.nubos-pilot/notes/YYYY-MM-DD-<slug>.md` (global scope) — note
  file with `text / created / scope / promoted:false` frontmatter and
  the verbatim capture as body text.
- Project scope only: one atomic git commit
  `docs(10): add note — <slug>` containing the new note file.
- Global scope: no commit. The note lives outside the repo.

## Success Criteria

- [ ] `--global` stripped from `$@` at any position.
- [ ] Scope defaults to `project`; `--global` switches to HOME-based
      path (Pitfall 10 mitigation — bypasses findProjectRoot).
- [ ] Project-scope directory resolved via
      `lib/core.cjs.projectStateDir`.
- [ ] Slug produced via `node np-tools.cjs generate-slug` (only
      `[a-z0-9-]` enter filename).
- [ ] Duplicate collisions resolved via `askuser` Pattern S-3
      (Re-run / View / Skip / Append-timestamp).
- [ ] Note text captured verbatim in body (never in frontmatter).
- [ ] Project-scope notes committed via `np-tools.cjs commit`;
      global-scope notes not committed (stderr confirmation only).
- [ ] STATE.md is NOT touched by this workflow (notes have no
      pending-counter semantics).
- [ ] Lint clean under `bin/check-workflows.cjs` — no BARE_ASKUSER
      violations and no DIRECT_READ pattern matches for the project
      state directory.

## Related Workflows

- **`/np:add-todo <title>`** — pending todo capture with STATE.md
  counter increment. Use when the idea is actionable.
- **`/np:add-backlog <title>`** — larger-scope capture for a full
  backlog phase (`999.x`) entry in ROADMAP.md.

## Design Notes

`list` and `promote` subcommands are out of scope (they belong to a
future capture-management workflow). Global notes live under
`~/.nubos-pilot/notes/` per D-14. Empty text after flags errors out
rather than falling through to a list dump — the explicit failure
mode is easier to debug than an accidental list surface.
