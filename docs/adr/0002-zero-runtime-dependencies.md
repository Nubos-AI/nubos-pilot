# ADR-0002: Zero Runtime Dependencies

* Status: Accepted
* Date: 2026-04-14
* Supersedes: None
* **Amendment:** [ADR-0006](0006-yaml-dependency-amendment.md) permits `yaml@^2.8` as a narrowly-scoped runtime dependency (2026-04-15).

## Context and Problem Statement

`package.json`'s `dependencies` block is the only way nubos-pilot can ship transitive complexity to end users through `npx`. Every runtime dependency is a three-headed cost: a supply-chain surface, a version-compatibility constraint, and an install-failure mode (Windows path quirks, corporate proxies, air-gapped networks, peer-dep conflicts, abandoned maintainers). The question: should nubos-pilot ever declare runtime dependencies?

## Scope

This ADR is about `package.json.dependencies` specifically — the subset of `package.json` that ships to end users via `npm install` / `npx`:

* **"Zero runtime deps" means:** `package.json.dependencies === {}` (empty object, not absent) — no library is pulled down at install time on an end-user machine.
* **`devDependencies` are explicitly permitted.** Test runners (`c8` for coverage), optional hook bundlers (`esbuild`, for patterns like a future `scripts/build-hooks.js`), and similar authoring-time tooling live there. They are never shipped to end users.
* **Environment assumptions are not dependencies.** `git` (FND-04 commits), `node >=22` (the engine we target), and the host agent CLI (Claude Code / Codex / Gemini / OpenCode) are assumed to exist on the user's machine — they are prerequisites, not things nubos-pilot ships.

## Decision Drivers

* **Sufficiency of Node builtins** — the full markdown-workflow surface (frontmatter parsing, readline prompts, file locking, ANSI output, child-process spawn) is reachable through `fs`, `path`, `os`, `child_process`, `readline`, `crypto`, and `util` alone.
* **`npx` install reliability** — zero deps ≈ zero failure modes on Windows, corporate networks, and air-gapped environments where `npm install` is notoriously flaky.
* **Patchability (Core Value)** — users copy `.cjs` files verbatim into `.claude/nubos-pilot/` and sometimes patch them locally; there is no `node_modules/` tree to keep in sync.
* **Security** — zero runtime deps ≈ zero supply-chain surface. No transitive vulnerabilities, no "abandoned maintainer" risk, no post-install script execution from third parties.

## Considered Options

* **Zero runtime dependencies** — Node builtins (`fs`, `path`, `os`, `child_process`, `readline`, `crypto`, `util`) + hand-rolled helpers. (CHOSEN)
* **Rich dependency tree** — adopt a broad runtime surface (e.g. a coding-agent SDK, `playwright`, `sharp`, `sql.js`, `chokidar`, an image-processing native addon, `@modelcontextprotocol/sdk`, `chalk`/`picocolors`).
* **Native Rust N-API engine** — publish per-platform prebuilt binaries (`-darwin-arm64`, `-linux-x64`, etc.) as `optionalDependencies`.
* **Accept a single narrow dependency pragmatically** — e.g. `yaml` for frontmatter parsing, because a hand-rolled regex is limited; ship it as a runtime dep rather than write a small parser.

## Decision Outcome

Chosen: **"Zero runtime dependencies"**, because it is the only option that reinforces the Core-Value patchability story and minimizes install-failure modes on the weakest user environments (Windows + corporate proxy + air-gapped) simultaneously. The `devDependencies` escape hatch covers authoring-time needs without leaking into end-user installs.

**Escape hatch for future exceptions:** if a concrete future feature genuinely requires a runtime dep that builtins cannot satisfy, the exception is introduced by a new ADR (e.g. `NNNN-accept-yaml-dependency.md`) that either supersedes ADR-0002 wholesale or amends it narrowly with a name-scoped exemption. The escape is deliberately bureaucratic so that "just add a dep" never becomes the reflex answer (per CONTEXT.md D-07, existing ADRs are not rewritten — they are superseded).

### Consequences

* Good, because `npm install` is effectively a no-op for end users — nothing to download, nothing to audit, nothing to break.
* Good, because supply-chain audits are trivial (there is no chain beyond what ships with Node itself).
* Good, because users can copy-patch `.cjs` files without module-resolution confusion — no `require()` path that resolves differently in their project vs. ours.
* Good, because the install-payload tree (see [ADR-0005](0005-three-orthogonal-file-trees.md)) contains only `.cjs` files and markdown — no `node_modules/` subtree ever appears there.
* Bad, because we reimplement small utilities — YAML frontmatter via hand-rolled parser (`lib/frontmatter.cjs`), readline prompts instead of `inquirer`/`@clack/prompts`, raw ANSI escape constants instead of `chalk`. This is an accepted cost documented at length in CLAUDE.md §"Alternatives Considered".
* Neutral, because `devDependencies` are permitted and do not ship to users — we can still adopt `c8` for coverage, `esbuild` for optional hook bundling, or `node:test` (builtin) for the test runner.
* Neutral, because `optionalDependencies` for native prebuilt binaries is ALSO rejected by this ADR — see Rust N-API option below — so no accidental backdoor.

## Pros and Cons of the Options

### Zero runtime dependencies — chosen

* Good, because Node builtins cover the entire markdown-workflow surface without external packages.
* Good, because it preserves the Core Value "markdown-only, multi-runtime, ohne eigenes Daemon" — any dep is one step toward a runtime.
* Good, because `devDependencies` remain available for the authoring-time needs that do not leak to users.
* Bad, because every small utility must be hand-rolled — accepted, documented exhaustively in CLAUDE.md §"Alternatives Considered".

### Rich dependency tree — rejected

* Good, because `chalk`/`picocolors` produce nicer terminal output; `@clack/prompts` produces nicer Q&A flows; `marked` and image-processing addons enable TUI rendering.
* Bad, because `playwright`, `sharp`, `sql.js`, `chokidar`, image addons target TUI/image/async-job features we do not implement.
* Bad, because `@modelcontextprotocol/sdk` as a runtime dep contradicts REQUIREMENTS.md §"Out of Scope" row "Nubos-MCP als First-Class-Dependency". MCP integration is the user's agent CLI's concern, not ours.
* Bad, because `@anthropic-ai/claude-agent-sdk` implies we spawn agents — that's the daemon pattern ADR-0001 forbids.
* Bad, because every transitive node_module is an install-failure risk on Windows + corporate proxies, the environments that most need nubos-pilot to "just work".

### Native Rust N-API engine — rejected

* Good, because native binaries offer raw-speed `grep`/`ast-grep`/syntax-highlighting.
* Bad, because it requires publishing per-platform prebuilt binaries (`-darwin-arm64`, `-linux-x64`, `-linux-arm64`, `-win32-x64`, ...) as `optionalDependencies`, with the associated CI/release plumbing.
* Bad, because nubos-pilot has no TUI, no image pipeline, and no watcher — the use cases a native engine is built for do not exist in our scope.
* Bad, because Claude Code already exposes `Grep`, `Read`, `Bash` as first-class tools; we don't need a native re-implementation of grep/ast/read.
* Bad, because introducing a binary-ship story violates Core Value patchability (users can't copy-patch a `.node` binary the way they can a `.cjs` file).

### Accept a single narrow dependency pragmatically — rejected (for now)

* Good, because one dep like `yaml@^2.8` would make frontmatter parsing robust against multiline sequences and anchors.
* Bad, because "just one dep" is a slippery slope; the hand-rolled parser covers the subset we actually use, and once the door is open, `semver`, `glob`, `minimatch` follow.
* Bad, because the escape-hatch route (new ADR superseding ADR-0002) exists for exactly this situation — it forces the author to demonstrate the concrete need. Open-ended "pragmatism" removes the forcing function.
* The escape hatch in Decision Outcome explicitly permits this option on demonstrated need via a new ADR — so rejecting it today is not a permanent closure.

## More Information

* **Related ADR:** [ADR-0005](0005-three-orthogonal-file-trees.md) — the install-payload tree contains only `.cjs` + markdown; no `node_modules/` subtree ever ships.
* **CLAUDE.md:** §"Technology Stack" → "Installation" (matches `"dependencies": {}` shape); §"External runtime dependencies" (row-by-row rejection rationale for the heavy deps enumerated above); §"Alternatives Considered" (accepted-cost catalogue).
* **REQUIREMENTS.md:** §"Out of Scope" → rows "Nubos-MCP als First-Class-Dependency", and (implicitly) the runtime/daemon rows that would require heavy deps.

---

*This ADR does not describe CI enforcement. CI-gate enforcement of the zero-deps rule (dep-growth-block) is deferred to a later deploy/CI phase per ROADMAP.md; Phase 1 enforcement consists of human PR review and this ADR as the authoritative reference.*
