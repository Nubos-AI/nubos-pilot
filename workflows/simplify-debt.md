---
command: np:simplify-debt
description: Economy-debt ledger — record, list, and resolve simplifications you deferred rather than fixed now, so "later" doesn't become "never". CRUD-only (no agent spawn unless you harvest from a review). Manual twin of the in-loop Economy critic (agents.economy full/ultra).
argument-hint: "[list [--status open|resolved|all]] | [add --file <f> --line <n> --category <c> --note <text>] | [resolve <id>] | [harvest [<git-range>]]"
---

# /np:simplify-debt

<objective>
Keep a durable ledger of over-engineering you chose NOT to fix this round. `/np:simplify-review` finds what could be deleted, reused, or condensed; whatever you defer goes here as a tracked entry, so the shortcut is harvested rather than lost. Each entry carries a `file`, optional `line`, one of the four Economy categories (`over-engineering` / `stdlib-reinvention` / `native-duplication` / `shrinkable`), and a one-line note. This command is CRUD over `.nubos-pilot/economy-debt/` — it does not edit source and does not commit code. It is the deferred-work counterpart of the in-loop Economy critic (`/np:execute-phase` with `agents.economy` set to `full` or `ultra`).
</objective>

## Initialize

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
VERB="${1:-list}"
```

`$LANG_DIRECTIVE` governs the prose you wrap around the CLI output; the ledger lines (id, category, `file:line`, note) stay canonical. Supersedes CLAUDE.md.

## Route by verb

This is a pure-CRUD workflow — the ledger lives behind `node .nubos-pilot/bin/np-tools.cjs simplify-debt`; never read or write `.nubos-pilot/economy-debt/` directly.

### `list` (default)

```bash
node .nubos-pilot/bin/np-tools.cjs simplify-debt list --status "${2:-open}"
```

Prints the open ledger (oldest debt first — longest-deferred is most urgent). `--status resolved` or `--status all` widen the view; append `--json` for the machine shape. Print the output verbatim.

### `add`

```bash
node .nubos-pilot/bin/np-tools.cjs simplify-debt add \
  --file "$FILE" --line "$LINE" --category "$CATEGORY" --note "$NOTE"
```

`--category` MUST be one of `over-engineering`, `stdlib-reinvention`, `native-duplication`, `shrinkable` (the CLI rejects anything else). `--line` is optional (omit for a file-level note). Adds are idempotent: re-adding an identical finding is a no-op (`was_new=false`), so re-harvesting the same review never duplicates.

### `resolve`

```bash
node .nubos-pilot/bin/np-tools.cjs simplify-debt resolve "$ID"
```

Moves the entry from `open/` to `resolved/` and stamps the resolution time. Use it once the simplification has actually landed (by hand or via a later `/np:execute-phase` round).

### `harvest [<git-range>]`

Spawn ONE read-only reviewer — `Agent(subagent_type="np-simplifier", prompt=<…>)` — over the diff (default: working tree + staged vs `HEAD`; or the passed git range). Its prompt MUST carry `agents/np-critic-economy.md` as the rubric (the canonical ladder + safety boundaries) and the captured `git diff --no-color`. For each finding the reviewer returns that you are NOT fixing now, record it with one `simplify-debt add` call (mapping the report tag to the matching `--category`). Findings you fix immediately are not harvested. Print the resulting open ledger when done.

## No Source Mutation

CRUD over the ledger only. This workflow NEVER edits source, NEVER stages, NEVER commits code. The ledger files under `.nubos-pilot/economy-debt/` are the only writes; commit them with your normal docs/artifact flow if `workflow.commit_docs` is set.

## Scope Guardrail

<scope_guardrail>
**Do:**
- Route every ledger read/write through `node .nubos-pilot/bin/np-tools.cjs simplify-debt <verb>` — never touch `.nubos-pilot/economy-debt/` directly.
- Use one of the four Economy categories on `add`; the CLI is the source of truth and rejects others.
- On `harvest`, pass `agents/np-critic-economy.md` to the reviewer so the ledger and the in-loop critic apply the identical bar.

**Don't:**
- Edit, stage, or commit source — this command only records deferred work. No `Write`/`Edit` of source, no `git add` of code.
- Log a test, input-validation, error-handling, security, or required-edge-case removal as debt — those are completeness, never economy (the rubric's safety boundaries; completeness wins).
- Record low-confidence "could be cleaner" noise — every entry needs a concrete file + replacement, same bar as `/np:simplify-review`.
</scope_guardrail>

## Output

- The ledger view (open / resolved / all) or the result of an `add` / `resolve`, printed verbatim.
- On `harvest`: one ledger entry per deferred finding, then the refreshed open ledger.
- No source changes, no code commits.

## Definition of Done

Ledger CRUD. Definition of Done, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 3 (Do it with tests) — the ledger NEVER records deleting or weakening test code; coverage is completeness, not debt.
- Rule 8 (Never present a workaround when the real fix exists) — entries point at the root-cause-simple form, not an obscure golfed one-liner.
- Rule 11 (Ship the complete thing) — deferred simplifications are tracked, not silently dropped; "later" stays visible until `resolve`.

Any violation = the operation is incomplete; surface it and exit non-zero. The orchestrator does not relax these.

## Related Workflows

- **`/np:simplify-review <git-range>`** — read-only economy audit of a diff (the finder; this command is the ledger that outlives a single review).
- **`/np:execute-phase`** — runs the Economy critic in-loop when `agents.economy` is `full` or `ultra`, enforcing the same rubric during execution.
- **`/np:add-todo`** — general pending-todo capture (this command is the economy-specific deferred-work ledger).
