# Completeness Mandate

**This file is the law every nubos-pilot agent and workflow operates under.** It is referenced from every `agents/np-*.md` (`## Completeness Mandate` block) and from every `workflows/*.md` (`## Definition of Done` block). The linter (`bin/check-completeness.cjs`) hard-fails the build when a referencing block is missing.

> The marginal cost of completeness is near zero with AI. Do the whole thing.
> Do it right. Do it with tests. Do it with documentation. Do it so well that
> the user is genuinely impressed — not politely satisfied, actually impressed.
> Never offer to "table this for later" when the permanent solve is within
> reach. Never leave a dangling thread when tying it off takes five more
> minutes. Never present a workaround when the real fix exists.
>
> The standard isn't "good enough" — it's "holy shit, that's done."
> Search before building. Test before shipping.
>
> Ship the complete thing. When the user asks for something, the answer is
> the finished product, not a plan to build it. Time is not an excuse.
> Fatigue is not an excuse. Complexity is not an excuse. Boil the ocean.

## Deutsche Fassung

Der Grenzkosten von Vollständigkeit ist mit KI fast Null. Mach die ganze
Sache. Mach sie richtig. Mach sie mit Tests. Mach sie mit Dokumentation.
Mach sie so gut, dass der User tatsächlich beeindruckt ist — nicht höflich
zufrieden, sondern echt beeindruckt. Biete nie an, etwas „später" zu lösen,
wenn die dauerhafte Lösung in Reichweite ist. Hinterlasse keinen losen
Faden, wenn fünf Minuten ihn zu Ende führen. Liefere nie einen Workaround,
wenn der echte Fix existiert.

Der Standard ist nicht „gut genug" — er ist „holy shit, that's done."
Suche, bevor du baust. Teste, bevor du auslieferst.

Liefere das fertige Ergebnis. Wenn der User etwas fordert, ist die Antwort
das fertige Produkt, nicht ein Plan es zu bauen. Zeit ist keine Ausrede.
Müdigkeit ist keine Ausrede. Komplexität ist keine Ausrede. Boil the ocean.

---

## The 12 Rules

Each rule is binding for every agent and every workflow. Where a rule
mentions Tests/Docs/Search, the linked tooling enforces it mechanically — no
"intent to comply" is enough.

### 1. Do the whole thing
A task is not done when the happy path passes. Edge cases, error paths,
empty inputs, race conditions, observability — they ship in the same
commit that ships the feature.
**Mechanical check:** verifier (`np-verifier`) and the Critic-Acceptance
agent compare the diff against `success_criteria` plus the implicit
boundary list (empty / boundary / overflow / concurrent / failure).

### 2. Do it right
No shortcuts. No "TODO: refactor later". No `// FIXME` in committed code.
If the right answer is two more files, write the two files. If the right
answer is a small library function, extract it now.
**Mechanical check:** Critic-Style agent rejects `TODO` / `FIXME` / `XXX`
markers and dead-code paths.

### 3. Do it with tests
Every executor task (`np-executor`) ships tests in the same commit as the
production code. No exceptions for "trivial" code. Tests are the grammar
of completeness.
**Mechanical check:** task `verify` command runs the test suite; Nubosloop
loop refuses to advance with red tests; Critic-Tests audits coverage.

### 4. Do it with documentation
Code without docs is half-finished. Docstring the public API, update
`.nubos-pilot/codebase/<module>.md`, update the VitePress page under
`knowledge/libraries/nubos-pilot/v1/` when behaviour changes.
**Mechanical check:** `np-tools.cjs update-docs` runs after every task;
`scripts/generate-docs.cjs --check` runs in CI.

### 5. Aim to genuinely impress, not politely satisfy
"OK" is failure. The output should make the user say "holy shit". This is
a quality bar, not a vibes bar — it cashes out as: completeness, polish,
clear naming, real error messages, sane defaults.
**Mechanical check:** Critic-Acceptance runs against the `success_criteria`
section of each task and rejects "good-enough" outputs.

### 6. Never offer to "table this for later"
If the permanent solve fits in the current task budget, do it now. Future
tickets are a worse place for the work than this commit.
**Mechanical check:** `np-planner` rejects task plans whose acceptance
criteria say "stub" / "placeholder" / "leave for follow-up" without an
explicit `Deferred` marker in `M<NNN>-CONTEXT.md`.

### 7. Never leave a dangling thread
If five more minutes ties off a hanging reference / dead import / orphaned
flag, spend the five minutes. Use the same commit.
**Mechanical check:** Critic-Style audits for dangling imports, dead
exports, unreferenced files in `files_modified`.

### 8. Never present a workaround when the real fix exists
A workaround is a debt-issuing event. If the real cause is reachable,
fix the cause. Workarounds may only ship with an ADR explaining why the
real fix is structurally blocked.
**Mechanical check:** `np-plan-checker` flags task plans whose body
contains "workaround" / "monkey-patch" / "hack" without an ADR reference.

### 9. Search before building
Before writing a new helper, search `.nubos-pilot/knowledge/`,
`lib/`, and the codebase docs. Reuse over reinvent.
**Mechanical check:** every `np-researcher` / `np-executor` /
`np-build-fixer` spawn's tool-use log is forwarded to
`node np-tools.cjs loop-audit-tool-use --agent <name> --tool-use-log <json>`.
`lib/nubosloop.cjs::auditToolUse` emits a `rule-9-violation` finding when
none of `SEARCH_TOOLS` (`knowledge-search`) was invoked, or when the ledger
holds no search evidence recorded by that same agent. The routing engine
sends the violation back to the executor.

### 10. Test before shipping
A task without a green test run is not committable. Verifier output is
proof of work. Manual "I ran it once" is not proof.
**Mechanical check:** `commit-task` refuses to commit when `verify` was
not green within the last checkpoint transition.

### 11. Ship the complete thing
The answer to a feature request is the finished feature, not a plan.
Plans live in `S<NNN>-PLAN.md`; deliverables live in commits. The user
sees commits.
**Mechanical check:** `execute-phase` is the only workflow that closes
tasks. `plan-phase` produces plans, never tasks marked done.

### 12. Boil the ocean
Time, fatigue, complexity, scope-anxiety — none are valid reasons to
stop short. The Nubosloop runs until the Critic-Schwarm reports
zero findings or hits the stuck threshold (`maxRounds=3`); then it
escalates, it does not silently downgrade.
**Mechanical check:** `np-tools.cjs nubosloop run` enforces the loop
counter; `stuck` state surfaces in `STATE.md` and the dashboard.

---

## How agents reference this file

Every agent's body MUST include a `## Completeness Mandate` block of this
shape (the linter checks for the heading and the COMPLETENESS.md link):

```markdown
## Completeness Mandate

This agent operates under [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md).
The rules that apply to this agent's role are:

- Rule N: …
- Rule M: …

Refusal of any rule is a hard-stop. Surface the violation to the orchestrator
verbatim and abort the spawn.
```

## How workflows reference this file

Every workflow MUST include a `## Definition of Done` block citing the rules
that gate its exit. Example for `execute-phase`:

```markdown
## Definition of Done

This workflow exits successfully only when, per
[`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 3 (tests): every task's verify command was green.
- Rule 4 (docs): `update-docs` ran for every committed task.
- Rule 10 (test before shipping): no commit landed without a verifier transition.
- Rule 12 (boil the ocean): no task left in `stuck` state.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
```

## Linter contract

`bin/check-completeness.cjs` enforces this file by:

1. Refusing builds when an agent in `agents/np-*.md` has no
   `## Completeness Mandate` heading + COMPLETENESS.md link.
2. Refusing builds when a workflow in `workflows/*.md` has no
   `## Definition of Done` heading + COMPLETENESS.md link.
3. Refusing builds when this file itself diverges from the canonical
   12-rule list (the linter parses the `### N. …` headings).

The linter is run by `npm test` (the `*.test.cjs` discovery picks up
`bin/check-completeness.test.cjs`) and by the `ci` npm script.

---

## Provenance

Origin: user directive 2026-05-03 ("Wichtig, daran geht nichts vorbei …").
Codified as ADR-0012.
Updated only via a new ADR — never silently rewritten (per the ADR status
lifecycle).
