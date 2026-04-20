---
command: np:discuss-project
description: Project-level discovery — adaptive interview that fills (bootstrap) or refreshes (refresh) PROJECT.md sections (Domain, Target Users, Non-Goals, Success Criteria, Strategic Decisions) and proposes REQ candidates.
argument-hint: [--bootstrap|--refresh]
---

# np:discuss-project

Deep, adaptive interview on project identity. Called automatically from
`np:new-project` (bootstrap mode — obligatory before roadmap/plan work),
and on demand later (refresh mode) when positioning or scope shifts.

The interview is informed by a codebase scan (so when the project already
contains code, the discussion builds on what exists rather than asking in
a vacuum).

## Philosophy

<philosophy>
Five boilerplate questions do not a project understand. PROJECT.md is the
one artifact every downstream agent reads before asking what to build, and
its quality caps the quality of every plan that follows. This workflow
treats the project discussion as a first-class moment — adaptive, grounded
in the scanned workspace, and ends with a filled PROJECT.md plus a
user-reviewable list of proposed requirements.
</philosophy>

## Scope Guardrail

<scope_guardrail>
Writes only:
- `.nubos-pilot/PROJECT.md` (section bodies only — structure preserved)
- `.nubos-pilot/REQUIREMENTS.md` (append-only "Proposed" block)

Never:
- rewrites application source
- touches `.nubos-pilot/codebase/` (that is `np:scan-codebase`'s job)
- writes requirements into the Active list (user promotes manually)
</scope_guardrail>

## Downstream Awareness

<downstream_awareness>
- `np:discuss-phase` reads PROJECT.md's Constraints and Domain.
- `np:planner` reads Non-Goals to avoid scope creep.
- `np:researcher` reads Strategic Decisions before proposing libraries.
- REQ-IDs appended by this workflow are consumed by `np:plan-phase` after
  the user promotes them.
</downstream_awareness>

## Single-Call Init

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT=$(node .nubos-pilot/bin/np-tools.cjs init discuss-project ${BOOTSTRAP:+--bootstrap})
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative. Obey it for all askuser prompt texts,
narrative status updates, and the prose written into PROJECT.md sections.
Supersedes CLAUDE.md managed block.

Parse: `mode`, `sub_mode` (`bootstrap` or `refresh`), `project_md_exists`,
`scan_context`, `questions[]`, `required_fields[]`.

## Process

### Step 1: Ground the user in the scan

Show the scan context before questions:

```
Before we discuss — here is what I found in the workspace:

- Files: <scan_context.file_count>
- Languages: <top 3 from language_distribution>
- Manifests: <manifest_paths>
- README head:
  <first 10 lines or "none">
- Git: <commits[0..2] subjects or "no git repo">

Does this match what you expect, or am I missing something?
```

Let the user correct (e.g. "the README is stale, ignore it"). Record
corrections — they shape follow-up questions.

### Step 2: Adaptive interview across the six required fields

The six required fields come from `required_fields[]`:

1. `project_description` — What This Is (2–3 sentences)
2. `domain_text` — Domain / lore / background
3. `target_users_text` — Target users
4. `non_goals_text` — Explicit Non-Goals
5. `success_criteria_text` — Observable success criteria
6. `strategic_decisions_text` — Strategic tech/business decisions

For each field: ask the seed question from `questions[]`, then follow up
with 1–3 deepening questions based on the answer. Use `np-tools.cjs
askuser` for every prompt (SC-5 enforcement — never bypass the gateway).

Tailor follow-ups to the scan:

- If the workspace has code, ask "I see `src/auth/` and `services/api/` —
  does the Non-Goals list carve out what these will not do?"
- If no code, ask "For Strategic Decisions, what language/runtime are you
  committing to?"

When the user's answer references an existing doc (e.g. "see README
section X"), fetch it and ground your summary in that.

### Step 3: Propose requirements

Based on the Success Criteria + Domain + Non-Goals, propose 3–7 candidate
REQ entries. Present them for user confirmation:

```
I see these requirements emerging from your answers. Want me to add them to
REQUIREMENTS.md under "Proposed"?

REQ-02 — must operate offline (no network calls)
REQ-03 — persists all state as plain Markdown files
REQ-04 — supports Node 22+ and Python 3.12+

(confirm all / pick subset / none)
```

Write the confirmed list to a JSON file:

```bash
REQ_FILE=$(mktemp -t np-proposed-reqs-XXXXXX.json)
# [{"id":"REQ-02","text":"..."}, ...]
```

### Step 4: Apply answers

```bash
ANSWERS=$(mktemp -t np-discuss-project-answers.XXXXXX.json)
# Write the six answer fields as JSON

node .nubos-pilot/bin/np-tools.cjs init discuss-project --apply "$ANSWERS" \
  ${BOOTSTRAP:+--bootstrap} \
  ${REQ_FILE:+--proposed-requirements "$REQ_FILE"}
```

The subcommand replaces PROJECT.md section bodies (structure preserved)
and appends a "Proposed" block to REQUIREMENTS.md. Both writes are atomic.

### Step 5: Commit respecting config.commit_docs

```bash
COMMIT_DOCS=$(node .nubos-pilot/bin/np-tools.cjs config-get workflow.commit_docs 2>/dev/null || echo "true")
if [[ "$COMMIT_DOCS" == "true" ]]; then
  git add .nubos-pilot/PROJECT.md .nubos-pilot/REQUIREMENTS.md 2>/dev/null || true
  git commit -m "docs: np:discuss-project ${BOOTSTRAP:+bootstrap}${BOOTSTRAP:-refresh}" 2>/dev/null || true
fi
```

## Output

```
np:discuss-project complete (<sub_mode>).

Updated:
  .nubos-pilot/PROJECT.md
  .nubos-pilot/REQUIREMENTS.md   (if requirements were proposed)

Next:
  - Promote proposed REQs to Active in REQUIREMENTS.md
  - Run `np:scan-codebase` if you have not yet (recommended)
  - Run `np:discuss-phase 1` when ready to scope the first phase
```

## Errors

| Code | Trigger | User action |
|------|---------|-------------|
| `discuss-project-not-initialized` | `.nubos-pilot/` missing | Run `np:new-project` |
| `discuss-project-missing-field` | answer JSON lacks one of six fields | Complete the interview |
| `discuss-project-cannot-refresh` | refresh mode but PROJECT.md missing | Run bootstrap mode first |
| `discuss-project-bootstrap-requires-project` | bootstrap but no scaffold | Run `np:new-project` |
| `discuss-project-answers-parse-error` | answers file not valid JSON | Retry |
