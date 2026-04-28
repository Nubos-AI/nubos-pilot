# mcp-configs/ — Reference Snippets

> **What this is.** Reference MCP-server configurations that nubos-pilot
> agents (`np-researcher`, `np-architect`) can leverage when present.
> nubos-pilot does NOT auto-install or manage these — operators wire them
> up themselves per host (Claude Code, Codex, Gemini, …).
>
> **What this isn't.** A package manager. A daemon. An auto-config layer.
> The agents probe for MCP availability at runtime (D-21..D-23) and fall
> back to local-only research if a configured server is unreachable.

## Snippets

| File | Purpose | Used by |
|------|---------|---------|
| `claude-code.example.json` | `~/.claude.json` / project `.mcp.json` shape with context7 + firecrawl + exa entries (commented out by default). | All web-touching agents |
| `codex.example.toml` | `~/.codex/config.toml` shape with the same MCP set, codex-flavored. | Same |
| `nubos-knowledge.notes.md` | Notes on optionally exposing nubos-pilot's local knowledge-index as an MCP server (idea, not shipped). | `np-researcher`, `np-architect` |

## How agents use MCPs

- `np-researcher` (`agents/np-researcher.md`) probes WebFetch + Context7 at
  spawn time. If both are unavailable, it enters the Offline-Confirm
  Protocol (D-21) and either runs local-only with a `## Research Coverage`
  section or aborts (D-23).
- `np-architect` (`agents/np-architect.md`) reads only local artifacts —
  it does NOT consume MCPs directly. Architecture decisions are based on
  the researcher's already-validated claims, not on live MCP queries.
- All other nubos-pilot agents (`np-planner`, `np-executor`, `np-verifier`,
  `np-build-fixer`, `np-security-reviewer`, `np-codebase-documenter`) are
  fully local — no MCP dependency.

## Wiring

Pick the snippet that matches your host CLI, copy the relevant block into
your host's MCP config file, and restart the host. nubos-pilot itself
never writes to those config files.

For Claude Code specifically, the project-local `.mcp.json` at the repo
root is preferred over `~/.claude.json` so MCP wiring travels with the
project.
