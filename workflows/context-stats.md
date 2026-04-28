---
command: np:context-stats
description: Markdown-Snapshot des Knowledge-Index — Dateien/Bytes/Token-Schätzung pro Top-Level-Gruppe (PROJECT, REQUIREMENTS, RULES, milestones, codebase, todos, threads, notes). Read-only — kein Commit, keine STATE-Mutation. Komplementär zu /np:stats (Phasen + Metriken).
argument-hint: [json]
---

# /np:context-stats

<objective>
Render eine Übersicht des indexierten Markdown-Materials unter
`.nubos-pilot/`. Antwortet auf "Wie groß ist mein Projekt-Kontext?" — z.B.
um vor `/np:execute-phase` zu sehen, wieviel Material parallele Tasks
durchqueren werden.

Read-only — analog zu `/np:stats` (D-20 SC-5).
</objective>

## Render

```bash
node .nubos-pilot/bin/np-tools.cjs context-stats
```

Falls kein Knowledge-Index existiert, wird er beim ersten Aufruf gebaut.
Sprach-Labels (en/de) folgen `.nubos-pilot/config.json` →
`response_language`. Token-Schätzung per Heuristik (≈ 0.27 tokens/byte
für Markdown).

## JSON Output

```bash
node .nubos-pilot/bin/np-tools.cjs context-stats json
```

Liefert das Stats-Objekt unverändert für Skripte / Dashboards.

## Scope Guardrail

<scope_guardrail>
**Do:** Knowledge-Index lesen oder bauen, Markdown rendern, Stdout schreiben.

**Don't:**
- Source-Dateien mutieren — read-only Surface (D-20 SC-5).
- STATE.md anfassen.
- Commits machen.
- Inline JSON aggregieren — `context-stats.cjs` ist die Single Source.
</scope_guardrail>

## Output

- Markdown auf Stdout mit Knowledge-Index-Header + Gruppen-Tabelle
  (Dateien / Bytes / Tokens-Schätzung pro Top-Level-Dir).
- Keine Datei wird geschrieben außer dem Index-Cache unter
  `.nubos-pilot/state/knowledge-index.json` (gitignored).

## Related

- **`/np:knowledge`** — Volltext-Suche über denselben Index.
- **`/np:stats`** — Phasen + Metriken-Snapshot (komplementär).
- **`/np:dashboard`** — Live-Übersicht über Milestones / Slices / Tasks.
