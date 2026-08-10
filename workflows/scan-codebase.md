---
command: np:scan-codebase
description: Initial deep codebase scan — inventories files, groups them into coherent modules, writes skill-style docs under .nubos-pilot/codebase/ that dev-agents must read before touching code.
argument-hint: [--batch-size <N>] [--max-files <N>] [--module <id>] [--project-name <name>]
---

# np:scan-codebase

Perform the initial codebase scan for a project. Produces a full set of
module docs under `.nubos-pilot/codebase/modules/`, an `INDEX.md` pointer
file, a `.hashes.json` manifest for staleness tracking, and a
`.doc-index.json` mapping of doc → source paths.

Dev-agents (executor, code-fixer, planner, researcher, documenter, custom)
MUST read `INDEX.md` + any relevant module docs before modifying code, and
MUST call `np:update-docs` after changes.

## Philosophy

<philosophy>
The codebase doc layer is the shared memory of every agent working in the
project. If it is empty or stale, each agent re-derives context from raw
source, burns tokens, and can drift. This workflow pays the one-time cost
of a deep inventory, hybrid-parser-plus-documenter-agent pass so that every
subsequent agent starts informed.

Nothing in this workflow is Claude-specific. The subcommand returns
module-facts JSON, the documenter agent is a prompt that any orchestrator
(Claude Code, OpenAI, Codex) can dispatch. Stay runtime-agnostic.
</philosophy>

## Scope Guardrail

<scope_guardrail>
This workflow ONLY writes inside `.nubos-pilot/codebase/`. It NEVER:

- modifies application source code
- touches PROJECT.md, REQUIREMENTS.md, or roadmap.yaml
- runs git commands beyond read-only `git log` via the scanner
- spawns network calls outside the documenter agent's own tool surface

Refuse and report if any of these boundaries would be crossed.
</scope_guardrail>

## Downstream Awareness

<downstream_awareness>
- `np:update-docs` reads `.doc-index.json` + `.hashes.json` to diff.
- Every `np:execute-*` workflow's post-step calls `np:update-docs`.
- Every np-agent is instructed to read `.nubos-pilot/codebase/INDEX.md` and
  relevant module docs before editing source.

If this workflow produces malformed INDEX.md or unreadable frontmatter,
every downstream agent degrades silently. Validate the written files at the
end.
</downstream_awareness>

## Single-Call Init

Scan, group, write manifest + stubs, emit module-facts in one call:

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
PLAN=$(node .nubos-pilot/bin/np-tools.cjs scan-codebase --project-name "$PROJECT_NAME")
if [[ "$PLAN" == @file:* ]]; then PLAN=$(cat "${PLAN#@file:}"); fi
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative. Obey it for user-facing output and
askuser prompts. Pass it into any writer-subagent spawn so module-doc
prose (overview, responsibilities, notes) follows the project language.
Module IDs, file paths, symbol names, and language labels stay canonical
English. Supersedes CLAUDE.md.

`--project-name` is optional; when provided it goes into `INDEX.md`. Other
flags: `--batch-size N` (default 500), `--max-files N`.

Parse: `mode`, `stats`, `modules[]` (each with `id`, `directory`,
`primary_language`, `file_count`, `facts`), `index_path`, `manifest_path`.

## Process

### Step 1: Confirm scan scope with the user

Show a summary before iterating modules:

```
Scan complete.
- Files walked: <stats.file_count>
- Hashed: <stats.hashed_count>
- Languages: <top 3 by count>
- Modules discovered: <modules.length>
- Manifests captured: <manifests.length> (package.json, …)

Generate doc prose for all <N> modules? (yes / pick subset)
```

Large codebases may warrant a subset pass. Honor the user's choice — do
not blast through 500 agent calls without consent.

### Step 2: For each selected module, dispatch the documenter

Per module, build the prompt from `facts` and dispatch the documenter
subagent. The subagent is defined in `agents/np-codebase-documenter.md` and
is runtime-agnostic — pick whichever dispatch mechanism your host supports.

```bash
PROSE_FILE=$(mktemp -t np-prose-XXXXXX.json)
# Off-host (ADR-0021): when np-codebase-documenter routes to an openai-compat
# provider (agent_routing), run it via spawn-offhost INSTEAD of the native host
# dispatch below.
DOCUMENTER_KIND=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-codebase-documenter --kind 2>/dev/null || echo native)
if [ "$DOCUMENTER_KIND" = "openai-compat" ]; then
  # np-codebase-documenter is NOT Rule-9-audited and writes ONLY
  # .nubos-pilot/codebase/ artefacts (inside the repo cwd — NOT live code), so it
  # runs off-host with the default cwd (repo root): Read/Grep/Glob over the repo +
  # Write confined to cwd. NO --allow-bash and NO worktree (no live-code blast
  # radius to isolate). The agent writes its module doc JSON itself, inside cwd.
  DOC_PROMPT="${TMPDIR:-/tmp}/np-offhost-documenter-${MODULE_ID}.md"
  # … render the SAME buildDocumenterPrompt(facts) prompt the native dispatch
  #   below describes PLUS $LANG_DIRECTIVE into "$DOC_PROMPT" …
  node .nubos-pilot/bin/np-tools.cjs spawn-offhost \
    --agent np-codebase-documenter --task-file "$DOC_PROMPT" \
    --phase scan >/dev/null
else
  # Host dispatches agent with buildDocumenterPrompt(facts) and writes JSON
  # to $PROSE_FILE. Validate JSON before proceeding.
  python -c 'import json,sys; json.load(open(sys.argv[1]))' "$PROSE_FILE"
fi
```

Batch pacing: the user opted into batches during Step 1. Between batches,
show a progress line (`[37/120 modules documented]`) and give the user a
chance to pause with Ctrl-C. Never eat interrupt signals.

### Step 3: Apply prose per module

```bash
node .nubos-pilot/bin/np-tools.cjs scan-codebase --apply-prose \
  --module "$MODULE_ID" \
  --prose-file "$PROSE_FILE"
```

The subcommand re-reads the module's source hashes (handles files that
changed between scan and apply), merges the prose, and atomically writes
`modules/<id>.md`.

### Step 4: Validate written artifacts

Before declaring success:

```bash
test -f .nubos-pilot/codebase/INDEX.md
test -f .nubos-pilot/codebase/.hashes.json
test -f .nubos-pilot/codebase/.doc-index.json
ls .nubos-pilot/codebase/modules/ | wc -l
```

Warn if a module doc is still `_TBD_` — user may have opted out mid-run.

## Output

```
np:scan-codebase complete.

Indexed: .nubos-pilot/codebase/INDEX.md
Modules: <N> (documented: <M>, stubs only: <N-M>)
Manifest: .nubos-pilot/codebase/.hashes.json

Dev-agents will now read INDEX.md + relevant module docs before editing.
Next change → np:update-docs runs automatically from np:execute-* workflows.
```

## Errors

| Code | Trigger | User action |
|------|---------|-------------|
| `scan-codebase-not-initialized` | `.nubos-pilot/` missing | Run `np:new-project` first |
| `scan-codebase-missing-module` | `--apply-prose` without `--module` | Supply flag |
| `scan-codebase-missing-prose` | `--apply-prose` without `--prose-file` | Supply flag |
| `scan-codebase-module-not-found` | id does not exist in current scan | Re-list via default mode |
| `scan-codebase-prose-unreadable` | prose JSON unreadable or invalid | Fix JSON; re-dispatch agent |
## Definition of Done

This workflow exits successfully only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 1 (Do the whole thing) — every module under source detection produces a `.nubos-pilot/codebase/modules/<id>.md` with prose.
- Rule 4 (Do it with documentation) — INDEX.md is regenerated; stale entries fail the workflow.
- Rule 9 (Search before building) — existing module docs are reused; conventions stay consistent.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
