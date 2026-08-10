---
name: np-refactoring
description: "Quality bar for behavior-preserving change — refactor, cleanup, restructure, rename, extract, deduplicate, decouple. Triggered for executor work on tasks that improve internal structure while keeping observable behavior identical. Encodes the checklist the change MUST satisfy before commit, not a method to teach. Structure changes; behavior does not — if behavior shifts, it is a feature or fix, not a refactor, and must be flagged. Language- and framework-agnostic."
user-invocable: false
---

# Refactoring

A refactor changes how the code is shaped, never what it does. Same inputs, same outputs, same side effects — only the structure improves. If you cannot say that with a straight face, you are not refactoring.

## Before editing
- Read existing conventions / pin behavior: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "<query>" --task $TASK_ID`.
- Find the tests that currently exercise the code. If none pin the behavior you are about to move, add characterization tests FIRST — capture what it does today, not what it should do.

## Behavior is frozen
- Do not change observable behavior: return values, side effects, error cases, ordering, timing-sensitive contracts.
- Preserve public contracts — signatures, names, types, routes, serialized shapes — unless the task is explicitly to change them.
- If you discover a bug mid-refactor, do not fix it silently. Flag it and keep the behavior (including the bug) until a separate task addresses it.
- A behavior change disguised as a refactor is the failure mode to avoid. When in doubt, it is NOT a refactor.

## Small green steps
- Move in small, reversible increments. Run the tests between steps; stay green the whole way.
- Separate mechanical changes (bulk rename, file move, extract) from logic moves — different commits, so each diff is trivially reviewable.
- Never mix a refactor and a behavior change in one commit.

## Stay in scope
- Refactor only what the task names. Resist "while I'm here" cleanups, drive-by reformatting, and adjacent rewrites — they bloat the diff and hide the real change.
- Improving the target means: better names, higher cohesion, less duplication, looser coupling, lower complexity. Not: new abstractions nobody asked for.

## Verification bar (must hold before commit)
- Behavior is provably unchanged: the pre-existing tests pass without modification, or characterization tests added first still pass (see [np-test-strategy]).
- No public contract was altered unless the task required it (see [np-api-design] for contract preservation).
- The diff is reviewable: mechanical renames/moves are isolated from logic changes; no unrelated files touched.
- No behavior change is bundled in; any discovered bug or behavior gap is flagged, not fixed in place.
- The change measurably reduces duplication, coupling, or complexity — or it should not have been made.
