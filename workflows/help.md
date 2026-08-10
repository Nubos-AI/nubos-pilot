---
command: np:help
description: List every available np-tools.cjs command grouped by category. Pass --json for programmatic consumption.
argument-hint: [--json]
---

# np:help

List every available `np-tools.cjs` command grouped by category. Pass `--json`
for programmatic consumption.

```bash
node .nubos-pilot/bin/np-tools.cjs help
```
## Definition of Done

Help reporter. Definition of Done, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 4 (Do it with documentation) — every command is listed; coverage gaps fail the workflow.
- Rule 5 (Genuinely impress) — descriptions are one-liners that name the deliverable, not abstractions.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
