---
command: np:state
description: Print a JSON snapshot of the current STATE.md frontmatter — active milestone, slice, task and run state. Read-only.
---

# np:state

Print a JSON snapshot of the current STATE.md frontmatter.

```bash
node .nubos-pilot/bin/np-tools.cjs state
```
## Definition of Done

Read-only viewer. Definition of Done, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 5 (Genuinely impress) — every active milestone, slice, and task is visible with concrete IDs.
- Rule 11 (Ship the complete thing) — view is exhaustive, no truncation without explicit `--limit`.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
