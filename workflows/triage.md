# np:triage

Interactive reviewer that walks the unified queue (see `np:queue`) item-by-item.
For each item, prompts `promote-to-todo | promote-to-phase | keep | drop`.
Non-TTY runs default to `keep` — safe in CI.

```bash
node np-tools.cjs triage "$@"
```
