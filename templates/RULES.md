<!-- Placeholders: project_name, created_date -->
# {{project_name}} — RULES

> **What this is.** Project-wide always-follow rules. Authoritative for every
> milestone, slice, and task — including deferred ones. Read by every agent
> before action.
>
> **Precedence.** `RULES.md` (global, always) > `M<NNN>-CONTEXT.md` (phase-locked)
> > `S<NNN>-PLAN.md` (slice-scoped) > defaults.
>
> **Scope.** Anything that should apply on day 1 AND on day 1000. If a rule is
> phase-bound, it belongs in `M<NNN>-CONTEXT.md`, not here.

Created: {{created_date}}

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

## Code Style

<!-- Format/lint/comment policy. Examples:
- No comments inside source — names + tests carry intent.
- Line length: 100. Indent: 2 spaces (or whatever the configured formatter says).
- Tests live next to source, suffixed `.test.<ext>`.
-->
- _TBD — fill with style policy._

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
