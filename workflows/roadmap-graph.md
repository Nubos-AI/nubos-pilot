---
command: np:roadmap-graph
description: Render roadmap.yaml as a dependency graph (Mermaid or Graphviz DOT) at milestone, slice or task level. Draws milestone depends_on, task depends_on, and the serial slice order the executor enforces but the YAML only implies. Read-only — never writes roadmap.yaml.
argument-hint: "[--format mermaid|dot] [--level milestone|slice|task] [--direction TD|LR] [--milestone <N>] [--out <path>]"
---

# /np:roadmap-graph

<objective>
Show the roadmap as the graph it already is. The edges exist in the data —
milestone `depends_on` (ADR-0006), task `depends_on` in the plan frontmatter, and
the serial slice order the executor enforces — but every existing view flattens
them: `roadmap-render` gives a table, `dashboard` a status block, `stats`
counters. None of them answers "what unblocks when this slice lands" without the
reader reconstructing the edges by hand.

Read-only. There is no verb that writes `roadmap.yaml`.
</objective>

## Initialize

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).** Obey
`$LANG_DIRECTIVE` for the narration around the diagram. The diagram itself is
**not** translated: node labels are milestone, slice and task ids plus their
recorded names, and renaming them in the output would break the correspondence
to `roadmap.yaml`. Supersedes CLAUDE.md.

## Render

```bash
node .nubos-pilot/bin/np-tools.cjs roadmap-graph
```

Useful variations:

| Command | When |
|---|---|
| `roadmap-graph --level milestone` | Project-level overview; one node per milestone. |
| `roadmap-graph --level slice` | Wave ordering without task noise. |
| `roadmap-graph --milestone 3` | One milestone only — the default view of a large project is unreadable. |
| `roadmap-graph --format dot` | Graphviz, when you want layout control or a rendered image. |
| `roadmap-graph --direction LR` | Wide-and-shallow plans read better left-to-right. |
| `roadmap-graph --markdown --out docs/roadmap.md` | Fenced Mermaid block for a docs page. |

## Reading the diagram

- **Shape** carries the level: milestones are stadium-shaped, slices
  rectangles, tasks rounded.
- **A bold `==>` edge is a wave boundary.** Slices run serially; tasks inside one
  slice run in parallel. This edge is the ordering the executor enforces, and it
  appears nowhere in `roadmap.yaml` as an explicit field — it is implied by list
  order, which is exactly the kind of thing a diagram should make visible.
- **A thin `-->` edge is a declared dependency** — either milestone `depends_on`
  or a task `depends_on` inside its slice. An intra-wave task edge is the
  exception worth looking at: it means that wave is not fully parallel.
- **Colour is status**, collapsed into five buckets (done, active, pending,
  skipped, failed). For the exact enum value use `/np:state` or
  `roadmap-render` — this view answers "what is blocked", not "what is the
  precise status string".

## Dangling dependencies

A `depends_on` naming a milestone no roadmap entry declares is printed to stderr
as a `dangling dependency` and **not drawn**. That combination is deliberate: the
edge cannot be drawn because one endpoint does not exist, and drawing nothing
without saying so would leave a diagram that reads as complete while hiding a
defect in `roadmap.yaml`. Fix the reference, do not fix the diagram.

The render still exits zero — a roadmap defect is a finding, not a reason to
refuse the view that surfaced it.

## Publishing into the docs

```bash
node .nubos-pilot/bin/np-tools.cjs roadmap-graph --markdown --title "Roadmap" --out docs/roadmap.md
```

The generated block carries a do-not-edit header. Regenerate it rather than
editing it: the diagram is a projection of `roadmap.yaml`, and a hand-edited
diagram is a second source of truth that will disagree with the first.

## Scope Guardrail

**Do:** read `roadmap.yaml` and the task plans; render; optionally write the
rendered diagram to `--out`.
**Don't:** write, reorder or repair `roadmap.yaml`; translate node labels; edit a
generated diagram in place; treat a dangling-dependency warning as cosmetic.

## Output

- The diagram on stdout, or a `{ ok, out, stats }` receipt when `--out` is given.
- `--json` adds `stats` and `dangling_dependencies` alongside the text.
- Any dangling dependency on stderr, one line each.

## Definition of Done

This workflow exits successfully only when, per
[`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 1 (do the whole thing) — every declared unit at the requested level is in
  the diagram; a unit is never dropped to make the layout tidier.
- Rule 4 (documentation) — when the diagram is published with `--out`, it is
  regenerated rather than hand-edited, so the docs cannot drift from
  `roadmap.yaml`.
- Rule 7 (never leave a dangling thread) — a dangling `depends_on` is reported,
  not silently omitted from the drawing.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
