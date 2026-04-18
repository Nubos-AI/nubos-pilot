# np:dispatch

State-router for the current phase. Reads state → determines next action
(discuss / plan / execute / verify) → delegates via `Skill()` call.
`--force` or `--action=<name>` to override. `--action` wins over recommendation.

```bash
node np-tools.cjs dispatch "$@"
```
