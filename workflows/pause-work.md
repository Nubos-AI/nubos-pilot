---
command: np:pause-work
description: Stamp STATE.session.stopped_at and resume_file for explicit session handoff. No git stash (D-08 semantic).
---

# /np:pause-work

<objective>
Record the session boundary in STATE.md so the next session (or a
different operator) can re-enter via `/np:resume-work`. The in-flight
checkpoint, if any, is untouched — it continues to capture the executor's
progress.
</objective>

## Execution

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
node .nubos-pilot/bin/np-tools.cjs init pause-work
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
Obey `$LANG_DIRECTIVE` for the resume-hint narration and any status lines
printed around the JSON payload. Supersedes CLAUDE.md.

Output is a small JSON payload `{ ok, stopped_at, resume_file }`. The
workflow simply displays it.

## Step 2 — Write the session handoff (ADR-0025)

The stamp above resumes a *task*. It says nothing about the reasoning around
it, and that is the part a fresh context loses. Write the six-section handoff
now, while the session still holds the context that produced it.

Compose the document from what actually happened this session and hand it to
`resume-doc write`:

```bash
node .nubos-pilot/bin/np-tools.cjs resume-doc write --doc-file /tmp/np-handoff-$$.json \
  --milestone "$MILESTONE" --task "$TASK_ID"
```

The document shape (`resume-doc --help` prints it in full):

| Section | Content |
|---|---|
| `goal` | Why this project exists, a few sentences. Not this session's goal — the project's. |
| `status` | `running` \| `partial` \| `blocked`. One word, plus an optional `status_note`. |
| `active_files` | Only the paths that matter, each with the purpose it serves *here*. A bare path list is a directory listing. |
| `changes` | What was built or modified, each with its `why`. The diff already carries the what. |
| `failed_approaches` | **Mandatory.** What was tried and abandoned, each with `why_failed`. |
| `next_steps` | Ordered, and at least one carries a concrete `command`. |

**On section 5.** This is the section that justifies the format. Every other
section can be reconstructed: the goal from `PROJECT.md`, the changes from `git
log`, the files from the diff. A failed approach cannot — a commit records what
worked and never what was tried and reverted. Omit it and the next session
starts with a clean slate on which it will re-attempt exactly what this session
disproved, which is the most expensive way to lose a session's most valuable
finding.

An empty list is legitimate and requires `no_failed_approaches_reason`. A
session where nothing was abandoned and a session that skipped the section must
not look identical on disk.

**Never record a secret value.** Variable names are fine and encouraged
(`reads STRIPE_SECRET_KEY from the environment`); the writer refuses tokens,
keys, JWTs and credentialed URLs, and that refusal is not a lint you argue with.

Fold the disproved approaches into the learnings store so a later task ranks
them below proven patterns:

```bash
node .nubos-pilot/bin/np-tools.cjs resume-doc learnings --log
```

They are logged with `outcome: failed`, which is what the confidence
calculation demotes. This is the one path by which an approach abandoned
*before* it was committed can reach the store at all — the learnings extractor
reads a turn diff, and an uncommitted dead end never appears in one.

## Scope Guardrail

**Do:** stamp STATE.session; write the session handoff; print the resume hint.
**Don't:** stash, discard, or modify the working tree; delete checkpoints
(resume-work needs them); write a handoff with an empty `failed_approaches` and
no stated reason; put a secret value in any field.

## Output

- STATE.md updated with `session.stopped_at = <ISO>` and
  `session.resume_file = .nubos-pilot/checkpoints/<task-id>.json` (or null
  if no active task).
- `.nubos-pilot/RESUME.md` — the six-section brief the next session reads, plus
  a timestamped copy under `.nubos-pilot/handoffs-session/` so history is never
  overwritten.
## Definition of Done

Session boundary. Definition of Done, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 1 (Do the whole thing) — all six sections are filled from what actually happened, not templated placeholders.
- Rule 7 (Never leave a dangling thread) — every checkpoint is closed or explicitly preserved with reason, and every abandoned approach is recorded with its cause rather than dropped.
- Rule 8 (Never present a workaround) — a failed approach is recorded as failed, not softened into a "possible alternative" the next session might retry.
- Rule 11 (Ship the complete thing) — `np:resume-work` can pick up exactly where this left off, no manual fixup.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
