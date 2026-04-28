---
command: np:knowledge
description: Volltext-Suche über .nubos-pilot/**/*.md (PROJECT, REQUIREMENTS, RULES, milestones, codebase, todos, threads, notes). BM25-light Scoring; Index unter .nubos-pilot/state/knowledge-index.json. Read-only — kein Commit, keine STATE-Mutation.
argument-hint: <query> [--limit N]
---

# /np:knowledge

<objective>
Lokale Volltext-Suche über alle Markdown-Artefakte des Projekts. Zweck:
Agents (planner, researcher, verifier) und Operator finden Cross-Milestone-
Bezüge, gelockte Decisions und Codebase-Doku ohne mehrfaches Read.

Read-only — dieser Workflow indexiert/sucht, schreibt keine Source-Dateien
und committet nicht.
</objective>

## Build / Refresh Index

```bash
node .nubos-pilot/bin/np-tools.cjs knowledge-index
```

Erzeugt `.nubos-pilot/state/knowledge-index.json` (idempotent; jeder
Aufruf baut frisch). Output ist eine kleine JSON-Quittung
`{ ok, index_path, total_files, total_chunks, unique_terms }`.

## Search

```bash
node .nubos-pilot/bin/np-tools.cjs knowledge-search "<query>" [--limit 10]
```

Output:

```json
{
  "query": "...",
  "terms": ["..."],
  "total_hits": 12,
  "hits": [
    {
      "rel_path": "milestones/M001/M001-CONTEXT.md",
      "line_start": 41,
      "line_end": 80,
      "score": 7.42,
      "preview": "<first 6 lines of chunk>"
    }
  ]
}
```

Wenn der Index fehlt, wird er beim ersten Search automatisch gebaut.

## Stats

```bash
node .nubos-pilot/bin/np-tools.cjs knowledge-stats
```

Liefert Dateizahl/Chunks/Bytes pro Top-Level-Gruppe (PROJECT.md,
codebase, milestones, todos, threads, notes).

## Scope Guardrail

<scope_guardrail>
**Do:** indexieren, suchen, Stats lesen. Treffer-JSON an Aufrufer reichen.

**Don't:** Source-Dateien mutieren, STATE.md anfassen, Commits machen,
externe URLs abrufen (das ist Sache von `/np:research-phase`).
</scope_guardrail>

## Output

- JSON auf stdout. Keine Datei wird geschrieben außer dem Index unter
  `.nubos-pilot/state/knowledge-index.json` — und der ist gitignored.
