# Notes — exposing nubos-pilot knowledge as an MCP server

> **Status.** Idea, not shipped. nubos-pilot today exposes the
> knowledge-index via the local CLI (`np-tools.cjs knowledge-search`).
> This note records what an MCP wrapping would look like if a future
> milestone decides to ship it.

## Why this could be useful

The local CLI is fine when an agent is spawned by a nubos-pilot
workflow — the workflow can shell out to `np-tools.cjs knowledge-search`
and inject the result via `<files_to_read>`. It is awkward when an
external IDE / chat session wants ad-hoc access to the same index without
running a workflow.

An MCP server would let any host (Claude Code, Cursor, etc.) call:

- `nubos-knowledge.search(query, limit)` → top-N hits
- `nubos-knowledge.stats()` → index size + groups
- `nubos-knowledge.refresh()` → rebuild the index

against the same `.nubos-pilot/state/knowledge-index.json` the local
agents read.

## Sketch

A thin Node MCP server (using the official `@modelcontextprotocol/sdk`)
that:

1. resolves the project root via the same `findProjectRoot` heuristic;
2. delegates each tool call to `lib/knowledge.cjs` directly (no subprocess);
3. ships nothing else — no write tools, no shell, no codebase access.

## Why it's not shipped

- Adds a runtime dependency outside nubos-pilot's "no daemon, short-lived
  node invocations" philosophy (README.md).
- Adds a second source of truth to keep in sync with the CLI.
- Solves a problem the operator can already solve via the CLI.

If a future milestone decides to ship this, the MCP entry would land in
`mcp-configs/claude-code.example.json` next to context7 / firecrawl / exa.
