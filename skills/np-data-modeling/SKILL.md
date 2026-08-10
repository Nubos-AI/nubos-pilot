---
name: np-data-modeling
description: "Quality bar for changes that touch a data model, database schema, or migration — new tables/columns/entities, type or nullability changes, constraints, indexes, ORM model edits, or any backfill/transform of persisted data. Triggered for executor work on migrations, schema definitions, entity/model classes, or data-shape changes. Encodes modeling-correctness and migration-safety rules the change MUST satisfy before commit, not a schema document to author. Language- and database-agnostic."
user-invocable: false
---

# Data Modeling

Persisted data outlives the code that writes it. A schema change is a one-way door under load: it runs against live data, against the old code still in flight, and it cannot be casually undone. Apply this bar to the change you are about to commit.

## Before editing

- Read the project's existing schema and migration conventions first: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "schema migration conventions" --task $TASK_ID`. Match the established naming, key strategy, timestamp/soft-delete idiom, and migration tooling — consistency beats personal preference.

## Modeling correctness

- **Model the domain, not the screen.** Shape tables around entities and their real relationships, not around one view's convenience. Normalize by default; denormalize only with a stated reason.
- **Types and precision are exact.** Money is not a float; timestamps carry timezone/UTC intent; enums/identifiers use a bounded type. No string-typing of structured data.
- **Nullability and defaults are deliberate.** NULL must mean "unknown/absent" by design, never "I didn't decide." Every default is chosen, not inherited by accident.
- **Invariants live in the database.** Enforce with FK, unique, and check constraints — not application code alone. App-only invariants drift the moment a second writer or a backfill appears.
- **Index what you query, not everything.** Add indexes for real read paths and FK lookups; each index taxes every write, so don't over-index. Justify composite-column order.

## Migration safety (load-bearing)

- **Backward-compatible and reversible.** Old and new code must both work during rollout. Provide a real down/rollback path, or stop and surface why none exists.
- **Expand then contract** for any rename, type change, or drop: add the new column → backfill → switch reads then writes → drop the old — as separate, independently deployable steps. Never rename/drop in the same step that introduces the replacement.
- **No long locks, no online table rewrites.** Adding NOT NULL or a default to a large table, or rewriting it in place, must not hold a blocking lock. Split into add-nullable → batched backfill → enforce.
- **Backfills are batched and idempotent.** Process in bounded chunks; re-running the migration must not double-apply or corrupt. No single statement that rewrites an unbounded table at once.
- **Destructive is never silent.** Dropping a column/table, narrowing a type, or deleting rows requires an explicit, surfaced accepted-risk finding — never folded quietly into an unrelated change.

## Verification bar (must hold before commit)

- Types, nullability, and defaults are each a deliberate decision, not a copy-paste default; structured data is not string-typed.
- Every modeled invariant is backed by a DB constraint, not only app code.
- The migration is reversible and backward-compatible: old code keeps working mid-rollout, and renames/drops/type-changes use separate expand-then-contract steps.
- No long lock or unbatched rewrite on a large table; backfills are chunked and idempotent.
- Any destructive operation carries an explicit, surfaced accepted-risk finding — see [np-secure-code-review] for data exposure and retention, [np-performance] for index/query-shape impact.
