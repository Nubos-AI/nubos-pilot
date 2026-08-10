<!-- Placeholders: project_name, created_date -->
# {{project_name}} — RULES

> **What this is.** Project-wide always-follow rules. Authoritative for every
> milestone, slice, and task — including deferred ones. Read by every agent
> before action.
>
> **Precedence.** [`COMPLETENESS.md`](COMPLETENESS.md) (foundation, always) >
> `RULES.md` (project-wide, always) > `M<NNN>-CONTEXT.md` (phase-locked) >
> `S<NNN>-PLAN.md` (slice-scoped) > defaults.
>
> **Foundation.** Every rule below sits on top of the 12-rule Completeness
> Mandate at [`COMPLETENESS.md`](COMPLETENESS.md). When a project rule and
> the Completeness Mandate would conflict, the Completeness Mandate wins —
> it is mechanically enforced by the linter and the Nubosloop.
>
> **Scope.** Anything that should apply on day 1 AND on day 1000. If a rule is
> phase-bound, it belongs in `M<NNN>-CONTEXT.md`, not here.

Created: {{created_date}}

---

> **How to fill this file (agent / human author):**
>
> - Every section below is **MUST FILL** before the project's first `/np:plan-phase` call. A section left as `_TBD` blocks the planner — there is no "fill later" path that produces a clean plan.
> - **Cardinality:** Each section expects **at least 1** concrete rule. Sections that are truly empty for this project use the form `- _none — <one-line reason>_` (e.g. `- _none — purely internal tool, no external secrets._`). Bare `_TBD` is rejected.
> - Use the inline HTML-comment examples in each section as a starting point — replace each `- _TBD —` placeholder with one or more project-specific bullets.
> - Rules are imperatives ("Always X", "Never Y"), not aspirations ("We try to X"). A rule that cannot be checked from the diff or the verify output is not a rule, it's a wish.

---

## Always-Follow

<!-- Bullet list of non-negotiable practices for this project. Examples:
- One commit per task — atomic, message format `task(M<NNN>-S<NNN>-T<NNNN>): …`
- Every external secret resolves via env vars — never inline literals.
- Never silence test failures (no commented-out asserts, no skipped tests
  without a TODO ticket).
- Database migrations are forward-only; rollbacks ship as new migrations.
-->
- _TBD — fill with project-wide invariants._

## Forbidden

<!-- Patterns banned regardless of milestone. Examples:
- No hand-rolled JWT verification — use the configured library.
- No `eval`-style execution of user-controlled strings.
- No `git push --force` against `main` / `master`.
- No silent catches (`catch {}`) — log or rethrow.
-->
- _TBD — fill with banned patterns._

## Dependencies

<!-- Version + provenance policy. Examples:
- Pin direct deps to exact versions (no `^` / `~` in production manifests).
- New deps require an entry in `.nubos-pilot/codebase/<module>.md`.
- Abandoned libs (no commit in 24 months) are forbidden — replace at next touch.
-->
- _TBD — fill with dependency policy._

## Security

<!-- OWASP-aligned defaults; the security-reviewer reads these before flagging.
Examples:
- Password hashing: argon2id with cost ≥ 19 (see OWASP cheatsheet).
- Session tokens: 256-bit random, HTTP-only + SameSite=Lax cookies.
- All user-supplied paths normalized + contained before file ops.
-->
- _TBD — fill with security defaults._

## Logging & Observability

<!-- Examples:
- Never log: passwords, tokens, full request bodies, PII (email/phone/IP).
- Every state-mutating endpoint emits an audit log line.
- Errors above WARN go to the structured log, not stdout-only.
-->
- _TBD — fill with logging policy._

## Conventions

> **How your code must be built.** These rules bind the architect (`np-task-architect`),
> the test-writer (`np-test-writer`), the executor, and the style critic
> (`np-critic-style`). They are read on every task. Each subsection is **MUST FILL** —
> use `- _none — <reason>_` only when a subsection genuinely does not apply.

### Class / Module Structure

<!-- How classes, modules, and units are shaped. Examples:
- One public class per file; file name matches the class name.
- Constructor injection only — no service-locator / static singletons.
- Business logic lives in Services/Actions; controllers stay thin (no DB access).
- Public surface ≤ 5 methods; split when it grows past that.
-->
- _TBD — fill with class/module construction rules._

### Naming

<!-- Identifier conventions. Examples:
- Classes PascalCase, methods camelCase, constants UPPER_SNAKE.
- Booleans read as predicates (`isActive`, `hasAccess`), never `flag`/`status`.
- Table names follow the framework's pluralization — never override.
-->
- _TBD — fill with naming conventions._

### Code Style

<!-- Format/lint/comment policy. Examples:
- No comments inside source — names + tests carry intent.
- Line length: 100. Indent: 2 spaces (or whatever the configured formatter says).
- Tests live next to source, suffixed `.test.<ext>`.
-->
- _TBD — fill with style policy._

### Patterns & Paradigms

<!-- Architectural patterns that are required or banned. Examples:
- Required: Repository pattern for all persistence; Result objects over exceptions for control flow.
- Banned: anemic domain models; inheritance for code reuse (prefer composition).
- Errors are typed and surfaced — never swallowed or stringly-typed.
-->
- _TBD — fill with required/banned patterns._

## Out-of-Scope (Forever)

<!-- Things this project explicitly will never do. Distinct from deferred ideas.
Examples:
- No mobile native client — web + PWA only.
- No multi-tenant architecture — single-tenant per deploy.
-->
- _TBD — fill with permanent exclusions._

---

## How to update this file

1. Anyone can append a draft rule via `/np:add-todo --type rule "<text>"`.
2. The next `/np:discuss-phase` for the active milestone reviews drafts.
3. Locked rules land here verbatim with a date stamp; rejected drafts are
   archived under the relevant milestone's `M<NNN>-CONTEXT.md` deferred section.

Rules promoted from `M<NNN>-CONTEXT.md` should reference the originating
decision: `D-<id> from M<NNN>` for traceability.
