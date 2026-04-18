# np:queue

Unified queue across 4 sources: `.nubos-pilot/todos/pending/`, backlog phases
(999.x), pending VERIFICATION/UAT items, and roadmap phases without PLAN.md.
Emits a flat JSON table to stdout.

```bash
node np-tools.cjs queue "$@"
```
