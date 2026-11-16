---
name: np-performance
description: "Quality bar for changes that touch a hot path, data access, or anything that scales with input size — triggered for executor work on loops over collections, query layers, request/render hot paths, batch jobs, or any code whose cost grows with N. Encodes the performance checklist the change MUST satisfy before commit: known complexity, no N+1, bounded result sets, sound caching, lean hot loops. Not a profiling report to author. Language- and framework-agnostic."
user-invocable: false
---

# Performance

A change that scales with input must not degrade as input grows. Optimize the dominant cost; leave micro-noise alone. Never trade correctness or readability for unmeasured speed.

## Before editing
- Read existing conventions / find the hot path: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "<query>" --task $TASK_ID`.
- Establish the baseline before changing anything: measure the current cost (timing, query count, allocations) so you can prove the change helps. Don't guess where the time goes.

## Complexity
- Know the algorithmic complexity of what you wrote and whether it grows with N. State it to yourself before committing.
- Replace nested scans over collections with a set/map lookup (O(N²) → O(N)).
- Do work once: hoist invariant computation out of loops; memoize repeated pure calls.

## Data access
- Kill N+1: no queries inside a loop. Batch, eager-load, or join so the count is constant in the number of rows.
- Paginate or stream unbounded result sets. Never load-all-into-memory when the size is driven by user data or table growth.
- Push filtering, aggregation, and limits down to the data layer instead of fetching wide and discarding in code.

## Hot loops and caching
- Avoid needless allocation and copying inside hot loops; reuse buffers, slice instead of clone where safe.
- Cache only when correctness allows it, and only with a clear invalidation story — no stale-forever. Define the key and the expiry/bust trigger.
- Defer expensive, non-critical work (move it async / to a background job) so it stays off the request or render path.

## Verification bar (must hold before commit)
- The change's complexity is known and does not grow worse than linearly with input unless unavoidable and justified.
- No query runs inside a loop; collection access over the data layer is batched or eager-loaded.
- Every result set whose size scales with input is paginated, streamed, or bounded — nothing loads everything into memory.
- Any cache added has an explicit invalidation trigger; no value can go stale-forever.
- Hot loops do no redundant allocation, copying, or repeated pure work.
- A before/after measurement (or a clear complexity argument) shows the change helps and harms nothing; the dominant cost was the target, not micro-noise.
- Correctness and readability were not sacrificed for unmeasured speed.
- See [np-data-modeling] for indexing that backs these queries and [np-observability] for latency/throughput metrics that confirm the win in production.
