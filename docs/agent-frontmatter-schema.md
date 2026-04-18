# Agent Frontmatter Schema

Canonical schema for every `agents/*.md` file shipped by nubos-pilot. Enforced by `lib/agents.cjs` at load time. Introduced in Phase 5 (CONTEXT decisions D-09..D-14).

## Canonical Schema (D-09)

```yaml
---
name: <string>              # required; MUST equal the filename stem
description: <string>       # required; single-line summary
tier: haiku|sonnet|opus     # required; see Tier Enum (D-11)
tools: <comma-list string>  # required; e.g. "Read, Write, Bash, Grep"
color: <string>             # optional; UI hint only
---
```

Agent body follows the closing `---`. Body content is free-form markdown, consumed verbatim by the runtime when the agent is spawned.

## Required Fields

Every required field must be present with a truthy value. Missing or empty fields throw `NubosPilotError('agent-invalid-frontmatter', …)` with `details.field` set to the offender.

| Field | Type | Validator Rule | Example |
|-------|------|----------------|---------|
| `name` | string | Must equal the filename stem (e.g. `planner.md` → `planner`). | `name: planner` |
| `description` | string | Non-empty single-line summary; shown in `listAgents` UIs. | `description: Creates executable phase plans …` |
| `tier` | enum string | Must be one of `haiku`, `sonnet`, `opus`. | `tier: opus` |
| `tools` | comma-list string | Flat comma-separated list; parsed later by the runtime adapter. | `tools: Read, Write, Bash, Glob, Grep` |

Order of checks inside `validateAgentFrontmatter`: REQUIRED → FORBIDDEN → TIER_ENUM → name-match. First failure throws; the remaining checks are short-circuited.

## Forbidden Fields (D-10)

Presence of any of these fields — even with a falsy value — throws `NubosPilotError('agent-forbidden-field', …)` with `details.field` and `details.hint`.

| Field | Why forbidden | Hint returned |
|-------|---------------|---------------|
| `model` | Model routing is tier-based in nubos-pilot (D-12..D-14). A concrete model id bypasses the tier abstraction and breaks multi-runtime adapters (Phase 7/8). | `Use "tier" instead.` |
| `model_profile` | Same reason as `model`: profile-based selection is an out-of-band concern; `tier` is the single source of truth. | `Use "tier" instead.` |
| `hooks` | Runtime-specific syntax (Claude Code ≠ Codex ≠ Gemini). Hooks live in the runtime-adapter layer introduced in Phase 7/8; they are NOT part of the portable agent contract. | `hooks are runtime-specific and deferred to Phase 7/8.` |

Rationale: the FORBIDDEN list is what makes D-09/D-10 testable. Every agent file that slips a forbidden field in gets rejected at load time before the runtime adapter ever sees it.

## Tier Enum (D-11)

`TIER_ENUM = ['haiku', 'sonnet', 'opus']`. Any other value throws `NubosPilotError('agent-invalid-tier', …)` with `details.value` (the offending input) and `details.allowed` (the canonical enum).

Pre-classified assignments (D-13, locked in ROADMAP SC-4):

| Agent | Tier | Rationale |
|-------|------|-----------|
| `planner` | `opus` | Goal-backward decomposition, dependency-graph reasoning, decision-fidelity checks — deepest model. |
| `plan-checker` | `opus` | Adversarial validator for planner output; equivalent reasoning depth required. |
| `researcher` | `sonnet` | Web/MCP fetch + synthesis; wider context tolerance, lighter reasoning load. |

No mid-run tier re-selection (D-14). `loadAgent()` re-reads the file on every call — never cached — so edits to the markdown are picked up immediately but cannot be tampered with at runtime.

## Plan-Checker Finding Categories (starting set)

Canonical identifiers for findings that `agents/np-plan-checker.md` emits. Starting set — extensible by the plan-checker agent as new failure modes are observed.

- `missing-success-criterion` — a ROADMAP SC-X is not mapped to any task.
- `non-atomic-task` — a task bundles multiple distinct deliverables that should be split.
- `unbounded-scope` — `<action>` uses words like "etc.", "and related", "as needed" without concrete enumeration.
- `broken-dependency` — `depends_on` references a plan or task that does not exist.
- `cyclic-dependency` — the wave-graph computation detects a cycle.
- `fake-promotion-trigger` — plan claims a `tasks/` promotion trigger (parallelism / mixed-tiers / non-linear-deps) that its own task list does not substantiate (D-18..D-20).
- `missing-coverage-annotation` — a task modifies production code without a `tdd="true"` task or a `<verify><automated>` command (Nyquist rule).
- `bare-askuser-call` — workflow MD emits `AskUserQuestion` directly instead of `node np-tools.cjs askuser --json '{…}'` (D-04).
- `hook-field-present` — agent frontmatter contains `hooks:` (D-10).
- `forbidden-agent-field` — agent frontmatter contains `model:` or `model_profile:` (D-10).

Each finding returned by plan-checker carries one of these codes plus an anchor `{file, line}` pair so the planner's revise-mode can address them without re-deriving context.

## Validation Flow

`validateAgentFrontmatter(fm, agentName)` runs four gates in strict order, throwing the first violation and skipping the rest:

1. **REQUIRED** — every field in `REQUIRED = ['name', 'description', 'tier', 'tools']` must be truthy; otherwise `agent-invalid-frontmatter` with `details.field`.
2. **FORBIDDEN** — no field in `FORBIDDEN = ['model', 'model_profile', 'hooks']` may be defined; otherwise `agent-forbidden-field` with `details.field` and `details.hint`.
3. **TIER_ENUM** — `fm.tier` must be in `TIER_ENUM = ['haiku', 'sonnet', 'opus']`; otherwise `agent-invalid-tier` with `details.value` and `details.allowed`.
4. **Name match** — `fm.name` must equal the `agentName` passed in (which `loadAgent` derives from the filename stem); otherwise `agent-invalid-frontmatter` with `details.field === 'name'`, `details.expected`, `details.got`.

All error codes are stable identifiers; callers (workflows, plan-checker, test suites) match on `err.code` verbatim rather than on message strings.
