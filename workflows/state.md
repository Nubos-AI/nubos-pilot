---
command: np:state
description: Print a JSON snapshot of the current STATE.md frontmatter — active milestone, slice, task and run state. Read-only.
---

# np:state

Print a JSON snapshot of the current STATE.md frontmatter.

```bash
node .nubos-pilot/bin/np-tools.cjs state
```

## Unlazy Discipline

Every step of this workflow runs under the [`np-unlazy`](../skills/np-unlazy/SKILL.md) skill. Before the first step, `Read` `.claude/skills/np-unlazy/SKILL.md` (Codex: `.codex/skills/np-unlazy/SKILL.md`) and keep its step contract for every section of this workflow: reread the request, name the section's gates before running it, re-verify evidence yourself instead of trusting a spawn's report, surface every dropped outcome as a handoff, and audit the final report against measured counts. Every agent spawn prompt carries `np-unlazy` in its `Use the following Nubos skills:` line; when the spawn has a task id, record it first with `node .nubos-pilot/bin/np-tools.cjs skill-audit expect --task "$TASK_ID" --skills "np-unlazy,…"`.

## Definition of Done

Read-only viewer. Definition of Done, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 5 (Genuinely impress) — every active milestone, slice, and task is visible with concrete IDs.
- Rule 11 (Ship the complete thing) — view is exhaustive, no truncation without explicit `--limit`.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
