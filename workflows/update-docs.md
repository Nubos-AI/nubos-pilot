---
command: np:update-docs
description: Incremental codebase-doc refresh — diffs current source against .hashes.json, refreshes only affected module docs, and updates the manifest.
argument-hint: [--path <path>] [--batch-size <N>] [--max-files <N>] [--module <id>]
---

# np:update-docs

Run after any code change to keep `.nubos-pilot/codebase/` in sync with the
source. Detects added / changed / removed files, maps them to affected
modules, dispatches the documenter agent per stale module, and writes back
updated docs + manifest.

Dev-agents must invoke this after writing/editing source. `np:execute-*`
workflows call it automatically. Humans can call it manually.

## Philosophy

<philosophy>
Docs that lag the code are worse than no docs — agents act on stale facts.
`np:update-docs` is the backpressure that keeps the shared memory fresh.
It is cheap when little has changed (diff is empty → no-op) and incremental
when much has changed (only stale modules re-documented).

Runtime-agnostic: the subcommand returns stale-module facts + new module
stubs; the host dispatches the documenter agent on each; the workflow
calls `--apply-prose` per module.
</philosophy>

## Scope Guardrail

<scope_guardrail>
This workflow ONLY writes inside `.nubos-pilot/codebase/`. It NEVER:

- rewrites source code
- renames or removes doc files for modules that still exist
- regenerates prose for modules that did not change
</scope_guardrail>

## Downstream Awareness

<downstream_awareness>
- Called from every `np:execute-*` workflow's post-step.
- Reads `.doc-index.json` to map touched paths → stale docs.
- Writes `.hashes.json` on completion so the next run has a fresh baseline.

If `.doc-index.json` is missing, fall back to a full rescan via
`np:scan-codebase` instead of guessing.
</downstream_awareness>

## Single-Call Init

```bash
PLAN=$(node .nubos-pilot/bin/np-tools.cjs update-docs)
if [[ "$PLAN" == @file:* ]]; then PLAN=$(cat "${PLAN#@file:}"); fi
```

Parse: `mode`, `diff_summary` (added/removed/changed/unchanged counts),
`stale_modules[]`, `added_modules[]`, `removed_modules[]`.

If all counts are zero, print "No doc updates needed." and exit.

## Process

### Step 1: Report diff to the user

```
Diff vs last manifest:
- Added files: <n>
- Changed files: <n>
- Removed files: <n>

Stale modules: <n>   — prose will be refreshed
Added modules: <n>   — stubs written; prose pending
Removed modules: <n> — marked for user review
```

For non-zero stale/added, ask: "Refresh prose now? (yes / no / pick)".
If "no", exit with stubs-only state — user can run the workflow later.

### Step 2: Dispatch documenter per stale + added module

For each module in `stale_modules ++ added_modules`:

```bash
# Build prompt from facts, dispatch agent, capture JSON to $PROSE_FILE
node .nubos-pilot/bin/np-tools.cjs update-docs --apply-prose \
  --module "$MODULE_ID" \
  --prose-file "$PROSE_FILE"
```

### Step 3: Handle removed modules

For `removed_modules`, prompt the user:

```
Module <id> has no source files anymore. Delete its doc?
  (delete / archive to modules/_archived/ / keep)
```

Default: archive. The workflow MUST NOT silently delete docs.

### Step 4: Verify manifest is fresh

```bash
stat -f "%m" .nubos-pilot/codebase/.hashes.json
```

The `generated_at` in the JSON should be within the last few seconds.

## Output

```
np:update-docs complete.

Diff: +<added> ~<changed> -<removed>
Refreshed: <n> modules
Added:     <n> modules
Archived:  <n> modules

Manifest: .nubos-pilot/codebase/.hashes.json
```

## Errors

| Code | Trigger | User action |
|------|---------|-------------|
| `update-docs-not-initialized` | `.nubos-pilot/` missing | Run `np:new-project` |
| `update-docs-missing-module` | `--apply-prose` without `--module` | Supply flag |
| `update-docs-missing-prose` | `--apply-prose` without `--prose-file` | Supply flag |
| `update-docs-module-not-found` | id does not exist in current scan | Rescan |
| `update-docs-prose-unreadable` | prose JSON unreadable or invalid | Fix JSON; re-dispatch agent |
| `manifest-schema-mismatch` | old `.hashes.json` from prior schema | Delete manifest; run `np:scan-codebase` |
