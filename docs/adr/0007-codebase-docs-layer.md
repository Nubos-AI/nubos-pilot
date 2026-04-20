# ADR-0007: Codebase Documentation Layer as Shared Agent Memory

* Status: Accepted
* Date: 2026-04-20
* Supersedes: None
* Relates-to: [ADR-0001](0001-no-daemon-invariant.md), [ADR-0005](0005-three-orthogonal-file-trees.md)

## Context and Problem Statement

Every dev-agent that nubos-pilot orchestrates (executor, code-fixer,
planner, researcher, code-reviewer, plus user-authored custom agents) reads
project source before it writes source. In practice this means each agent
re-derives context from raw files on every spawn: it opens the same
modules, re-discovers the same public APIs, and re-learns the same
invariants. Three failure modes follow:

* **Token spend** — the same module content is repeatedly paid for across
  agent runs. Over a multi-phase project this dominates cost.
* **Drift** — two agents reading the same file at different times may
  reach different conclusions (one spots an invariant the other misses),
  and downstream decisions diverge.
* **Loss of hard-won context** — when a bug was fixed two phases ago with
  a subtle timing workaround, the next agent has no way to know the
  workaround exists. It will re-introduce the bug.

Nubos-pilot already commits to `.nubos-pilot/` as the Project-State tree
([ADR-0005](0005-three-orthogonal-file-trees.md)). What is missing is a
canonical, incrementally-maintained description of the project's own
source tree that agents treat as ground truth. The planning artifacts
(PROJECT.md, REQUIREMENTS.md, phase CONTEXT.md files) describe *what* the
project is and *what* each phase should do — they deliberately do not
describe *how the code is shaped*.

## Decision Drivers

* **Runtime agnostic** — the docs layer must function identically whether
  the host is Claude Code, OpenAI Agents, Codex, or any other orchestrator.
  No Claude-specific hooks, no Claude-specific invocation paths.
* **Language agnostic** — nubos-pilot ships into arbitrary third-party
  projects; the layer must work for Node, Python, Go, Rust, PHP, Ruby,
  Java, Kotlin, C#, Swift, and unknown-language files alike.
* **Cheap to keep fresh** — stale docs are worse than absent docs. The
  update path must be incremental and must piggyback on the existing
  `np:execute-*` workflow cadence.
* **Physically separated from source** — docs live under `.nubos-pilot/`
  so they cannot pollute the user's code tree, cannot be mistaken for
  source, and can be fully removed with a single directory deletion.
* **Inspectable and editable by humans** — plain Markdown with a skill-
  style frontmatter header, not an opaque binary index.
* **Pluggable where speculative** — a deterministic parser handles
  structure; an agent produces prose. Either component can be swapped
  without invalidating the other.

## Considered Options

* **Option A — No codebase documentation layer.** Status quo. Every agent
  re-reads raw source. Reject: demonstrably wasteful and drift-prone at
  the sizes nubos-pilot targets.
* **Option B — Single large CODEBASE.md summary.** One file per project.
  Reject: dev-agents cannot selectively load what they need; file grows
  unboundedly; a single write destroys a single read target.
* **Option C — Per-file docs mirroring the source tree.** One `.md` per
  source file. Reject: explodes in large repos; does not express module
  boundaries, which is where invariants live.
* **Option D — Module-level docs for coherent units, manifest-tracked,
  skill-style frontmatter, incremental refresh.** Chosen.

## Decision Outcome

Chosen: **Option D — Codebase Documentation Layer**. Module-granularity
docs under `.nubos-pilot/codebase/modules/<id>.md`, indexed by
`.nubos-pilot/codebase/INDEX.md`, tracked for staleness by
`.nubos-pilot/codebase/.hashes.json`, and mapped to source paths by
`.nubos-pilot/codebase/.doc-index.json`. The layer is created and
maintained by three workflows (`np:scan-codebase`, `np:update-docs`,
`np:discuss-project`) and is consumed by every dev-agent under a strict
read-first / write-back protocol.

### Layout

```
.nubos-pilot/
  codebase/
    INDEX.md              # pointer list, generated
    .hashes.json          # per-source-file SHA-256 manifest
    .doc-index.json       # doc → source-paths mapping
    modules/
      <module-id>.md      # one per coherent unit
```

A "module" is a **coherent unit**, not a fixed shape. The initial grouping
is directory-based (all code files in one directory form one module), but
the contract is explicit: grouping may be overridden and refined in
future iterations to express bounded contexts, microservice boundaries,
or feature-level units without breaking the read-first protocol.

### Skill-Style Frontmatter

Every module doc carries structured frontmatter that agents (and tooling)
can read without parsing the body:

```yaml
---
name: <human-readable name>
description: <one-sentence summary>
kind: module
module_id: <id>
directory: <repo-relative>
primary_language: <lang>
file_count: <n>
source_paths: [ ... ]
symbols: [ ... ]                # exported API surface
external_deps: [ ... ]
internal_deps: [ ... ]
source_hashes:
  <path>: <sha256>              # per-file integrity anchor
last_documented: <date>
---
```

The body is human-readable Markdown with fixed sections: Purpose, Key
Concepts, Public API, Invariants, Gotchas, Files.

### Hybrid Parser + Agent Generation

* **Deterministic parser** (`lib/codebase-docs.cjs`) extracts symbols and
  imports from 11 languages via line-based regex patterns (JavaScript,
  TypeScript, Python, Go, Rust, PHP, Ruby, Java, Kotlin, C#, Swift; others
  documented as "unknown" but still scanned).
* **Agent** (`np-codebase-documenter`) receives the parser's facts and
  produces strict-JSON prose sections. The agent prompt forbids inventing
  symbols or behaviors; it grounds every claim in the facts or the source
  it is allowed to read.
* **Render** combines both into the final `.md`. The agent never writes
  files directly; the subcommand renders.

### Staleness Detection

`.hashes.json` is the integrity anchor. On every `np:update-docs` run:

1. Rescan the workspace.
2. Diff the new hashes against `.hashes.json` → added / changed / removed
   files.
3. Map touched paths to modules via `.doc-index.json` → stale modules.
4. Refresh only stale modules' prose via the documenter agent.
5. Write back. Overwrite the manifest as the new baseline.

`np:doctor` surfaces three related issues — `codebase-not-scanned`,
`codebase-manifest-stale`, `codebase-tbd-docs` — with `fixable:
'run-workflow'` so `--fix` prints a hint and does not prompt (honors
D-16 whitelist semantics from [ADR-0001](0001-no-daemon-invariant.md)
adjacent conventions).

### Dev-Agent Protocol (runtime-agnostic)

**Pre-edit (read-first) — mandatory for every dev-agent:**

1. Read `.nubos-pilot/codebase/INDEX.md`.
2. For every source file the agent will touch, locate and read the
   owning `.nubos-pilot/codebase/modules/<id>.md`.
3. Respect Invariants and Gotchas as constraints; if a planned change
   would violate an invariant, stop and report.

**Post-edit (write-back) — mandatory for every dev-agent that mutates
source:**

1. Run `np:update-docs`.
2. For each stale module in the diff, dispatch the `np-codebase-
   documenter` agent with the provided facts and apply prose via
   `np:update-docs --apply-prose`.

The protocol is deliberately not a runtime hook. Installing a
`PostToolUse` hook into `.claude/settings.json` would tie correctness to
a specific host. Keeping the protocol in agent prompts means the same
contract applies in Claude Code, OpenAI Agents, Codex, or any future
orchestrator that loads nubos-pilot's agent definitions.

### Orthogonality Preservation

`.nubos-pilot/codebase/` is a strict sub-tree of the Project-State tree
([ADR-0005](0005-three-orthogonal-file-trees.md)). It is owned by the
end user's project, mutated only through nubos-pilot workflows, never
touches Source or Install-Payload trees. The three-tree invariant holds.

### `child_process` Boundary Preservation

`lib/workspace-scan.cjs` exposes the scan surface. Surface-audit (ADR-0001
adjacent) forbids `child_process` in `lib/*.cjs` outside the
`git.cjs` whitelist. The scanner therefore accepts an optional
`opts.gitInfo` callback; the git-info implementation lives in
`lib/git.cjs` and is passed in by the subcommand layer
(`bin/np-tools/*.cjs`). The `no-daemon` / `lib-is-pure` invariant holds.

## Consequences

* Good, because every dev-agent starts with a curated summary of the
  code it will touch, lowering token spend and reducing drift.
* Good, because Invariants and Gotchas persist across phases — a
  workaround documented in module X's Gotchas section is seen by every
  future agent that touches module X.
* Good, because incremental refresh (`np:update-docs`) costs only the
  modules whose source hashes changed, so the steady-state price of
  keeping docs fresh scales with change volume, not repo size.
* Good, because the layer is inspectable, editable, removable — a plain
  directory of Markdown files, no database, no daemon.
* Good, because the split between deterministic parser and agent-
  produced prose preserves ADR-0001's no-daemon invariant: the parser
  is a library function, and the agent runs only inside a workflow the
  user already invoked.
* Good, because language coverage is extensible — adding a new language
  means adding a regex entry to `SYMBOL_PATTERNS` and `IMPORT_PATTERNS`
  in `lib/codebase-docs.cjs`; no schema change, no manifest migration.
* Bad, because initial scans of large repos are expensive. Mitigation:
  `np:scan-codebase` batches (user can pause between batches) and the
  workflow shows a progress counter.
* Bad, because parser-extracted symbols are regex-best-effort, not AST-
  precise. Mitigation: the documenter agent is instructed to omit
  signatures it cannot confirm from source rather than guess, and the
  Gotchas section allows surfacing parser gaps explicitly.
* Bad, because the protocol is contract-enforced in agent prompts, not
  in the runtime. A custom agent that ignores the protocol can still
  write source without refreshing docs. Mitigation: `np:doctor` reports
  `codebase-manifest-stale` any time post-change refresh was skipped;
  the user sees the drift.
* Neutral, because ADR-0002 (zero runtime deps) is not challenged —
  the layer uses only Node built-ins plus the already-accepted
  `yaml@^2.8` via `lib/codebase-manifest.cjs` (JSON only — not even
  yaml in practice).

## Pattern Conformance

* **S-1 atomic write + file lock** — every doc write in the codebase
  layer goes through `atomicWriteFileSync`. No partial files.
* **S-2 NubosPilotError envelope** — all error paths in
  `scan-codebase` / `update-docs` / `discuss-project` subcommands
  throw typed errors (`scan-codebase-not-initialized`,
  `update-docs-module-not-found`, `discuss-project-missing-field`,
  `proposed-reqs-invalid-id`, etc.).
* **S-5 sandboxed tests** — every new test (65 across lib + bin)
  creates a fresh tmp directory and tears it down in `afterEach`.
* **S-6 CJS module footer** — every new `.cjs` file ends with a
  `module.exports = {...}` block.

## More Information

* **Implementation:**
  * `lib/workspace-scan.cjs` — sprachagnostischer Scanner (15 tests)
  * `lib/codebase-manifest.cjs` — `.hashes.json` read/write/diff (10 tests)
  * `lib/codebase-docs.cjs` — module grouping + symbol/import extraction + render (14 tests)
  * `bin/np-tools/scan-codebase.cjs` — initial scan subcommand (6 tests)
  * `bin/np-tools/update-docs.cjs` — incremental refresh subcommand (5 tests)
  * `bin/np-tools/discuss-project.cjs` — project-level interview subcommand (13 tests)
  * `agents/np-codebase-documenter.md` — runtime-agnostic documenter agent
  * `workflows/scan-codebase.md`, `workflows/update-docs.md`,
    `workflows/discuss-project.md`, `workflows/new-project.md`
* **Consumer updates:** `np-executor`, `np-code-fixer`, `np-planner`,
  `np-researcher`, `np-code-reviewer` received the read-first / write-
  back protocol in their agent frontmatter-adjacent prose.
* **Related ADRs:**
  * [ADR-0001](0001-no-daemon-invariant.md) — the runtime-agnostic
    protocol exists to avoid a daemon.
  * [ADR-0002](0002-zero-runtime-dependencies.md) — layer adds no new
    runtime deps.
  * [ADR-0005](0005-three-orthogonal-file-trees.md) — `.nubos-pilot/
    codebase/` is strictly inside the Project-State tree.

---

*This ADR describes the source-level design of the Codebase Documentation
Layer. CI-gate enforcement of the read-first / write-back protocol
(static analysis of agent prompts) and release/publish of the new
workflows are deferred to later deploy-phase ADRs per the source-vs-
deploy separation in [ADR-0005](0005-three-orthogonal-file-trees.md).*
