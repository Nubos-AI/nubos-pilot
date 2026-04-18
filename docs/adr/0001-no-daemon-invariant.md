# ADR-0001: No-Daemon Invariant

* Status: Accepted
* Date: 2026-04-14
* Supersedes: None

## Context and Problem Statement

nubos-pilot must run inside existing agent CLIs (Claude Code, Codex, Gemini, OpenCode). Any long-lived background process, RPC server, or OS-level service registration would break the install-anywhere promise and directly violate PROJECT.md's Core Value ("ohne eigenes Daemon"). The question is binary: should nubos-pilot ever spawn or require a background process?

For the purposes of this ADR, **"daemon" means any one of:**

1. An OS-level service (systemd unit, launchd agent, Windows service).
2. A long-lived runtime process kept alive between slash-command invocations.
3. An RPC server exposing a local port, socket, or pipe.
4. A between-invocation file-watcher or async-job runner.

**What does NOT count as a daemon:** a short-lived, foreground `node` process launched by a slash-command's bash block that exits when its work completes. That is an ordinary synchronous invocation, not a background process.

## Decision Drivers

* **Install-anywhere** — no `sudo`, no `systemd`/`launchd`, no Windows service registration.
* **Multi-runtime compatibility** — all four target runtimes (Claude Code, Codex, Gemini, OpenCode) treat this tool as a synchronous set of slash-commands. None of them host background services.
* **Simplicity** — no process lifecycle to reason about; no "is it running?" diagnostics; no log rotation; no PID files.
* **Security / footprint** — no always-on listener, no accidental RPC surface, no persistent state in a running process.

## Considered Options

* **Stay daemon-free** — in-session, foreground-only execution via short-lived `node` invocations. (CHOSEN)
* **SDK-embedded coding-agent runtime** — adopt a persistent coding-agent SDK as a runtime layer (e.g. an `@anthropic-ai/claude-agent-sdk`-style loader pattern).
* **Cross-session daemon via launchd/systemd** — a user-installed service that auto-advances plans while no agent CLI is open (REQUIREMENTS.md FUT-06).
* **RPC multi-agent system** — spawn local worker processes communicating over sockets to achieve real parallelism beyond Claude's `Task` tool.

## Decision Outcome

Chosen option: **"Stay daemon-free"**, because it is the only option that satisfies install-anywhere + multi-runtime compatibility + simplicity drivers simultaneously. Any feature that would require a persistent background process is out of scope by construction; the same user intent can be satisfied via the in-session auto-advance loop (`np:autonomous` — forward-reference Phase 6 / EXEC-03) which runs inside the agent CLI's own session.

### Consequences

* Good, because any feature that requires a daemon is out of scope by construction — the invariant resolves scope disputes before they start.
* Good, because the tool is fully removable by deleting files — there is no service to stop, no PID to kill, no socket to clean up.
* Good, because there is no security surface from an always-on listener; no accidental RPC port; no attack surface grown by simply installing nubos-pilot.
* Good, because install works on machines where the user cannot `sudo` (corporate/managed environments, air-gapped dev boxes).
* Bad, because background auto-advance while the user's agent CLI is closed is impossible. Mitigated by `np:autonomous` (in-session loop, Phase 6 / EXEC-03). The cross-session variant is explicitly deferred (REQUIREMENTS.md FUT-06) and would require a future ADR that supersedes this one.
* Bad, because we forgo a richer SDK-embedded interactive loop; mitigated by the fact that the four supported agent CLIs already provide their own interactive loops — we compose with them instead of competing.

## Pros and Cons of the Options

### Stay daemon-free — chosen

* Good, because `.cjs` files invoked inline from slash-command bash blocks require zero persistent processes — the implementation cost is bounded and well-understood.
* Good, because it gives us zero supply-chain exposure from a daemon framework (no coding-agent SDK transitive tree, no `@modelcontextprotocol/sdk` runtime dep).
* Good, because it lines up with PROJECT.md Constraint "Keine eigenen Prozesse".
* Bad, because we must implement auto-advance as an in-session loop rather than a scheduled background worker — accepted cost, captured by `np:autonomous` design in Phase 6.

### SDK-embedded coding-agent runtime — rejected

* Good, because it provides a richer interactive loop and a unified tool/capability abstraction.
* Bad, because it reintroduces a runtime — directly contradicts PROJECT.md Constraint "Keine eigenen Prozesse".
* Bad, because it couples nubos-pilot's lifecycle to a library's API-stability — a coupling CLAUDE.md §"External runtime SDKs" calls out as prohibited.
* Bad, because maintaining a process means maintaining crash-recovery, log files, and version migrations — all scope we explicitly reject.

### Cross-session daemon via launchd/systemd — rejected (deferred)

* Good, because it would enable true "leave it running overnight" plan execution.
* Bad, because it requires per-OS service registration (root on Linux, `launchctl` on macOS, Service Control Manager on Windows) — install-anywhere dies.
* Bad, because it requires a PID/lock management story that the synchronous in-session model avoids entirely.
* Deferred: REQUIREMENTS.md FUT-06 captures this as a future-scope item. Adoption would require a new ADR superseding ADR-0001.

### RPC multi-agent system — rejected

* Good, because it would unlock true multi-agent parallelism beyond Claude's in-session `Task` tool.
* Bad, because it requires a long-lived server process — the exact thing this ADR forbids. (REQUIREMENTS.md §"Out of Scope" row "Echtes RPC-basiertes Multi-Agent-System".)
* Bad, because the parallelism Claude's `Task` tool already provides is sufficient for the scope outlined in PROJECT.md; RPC would be a solution in search of a problem.
* Bad, because it introduces local-socket attack surface for negligible benefit over in-session `Task`.

## More Information

* **Related ADR:** [ADR-0004](0004-atomic-commit-per-unit.md) — atomic-commit-per-unit works precisely because no daemon holds state across sessions; each commit is self-contained.
* **PROJECT.md:** §"Constraints" — "Keine eigenen Prozesse: alles läuft inline im Agent-CLI".
* **CLAUDE.md:** §"External runtime SDKs" — runtime coding-agent SDKs (including `@anthropic-ai/claude-agent-sdk` and similar) are explicitly prohibited.
* **REQUIREMENTS.md:** §"Out of Scope" → rows "Eigene Runtime / Daemon / Background-Prozess", "Cross-Session Daemon für Auto-Advance ohne offene Session", "Echtes RPC-basiertes Multi-Agent-System".
