---
name: np-resilience-patterns
description: "Quality bar for executor work where code calls across a process or network boundary — an external API, another internal service, a queue, or a database under load. Triggered whenever a change introduces or modifies a remote call, encoding the resilience rules the change MUST satisfy before commit (bounded timeouts, fail-fast on persistent failure, isolation to stop cascades, degradation over hard error, load shedding under overload, retry-safe idempotency). This is a bar the change must meet, not a resilience spec to author. Language- and framework-agnostic."
user-invocable: false
---

# Resilience Patterns

A call across a process or network boundary WILL fail — slowly, partially, or completely. Design for that as the normal case, not the exception. Match each pattern to the actual failure mode you face; do not bolt on machinery the call does not need.

## Before editing
- Read existing conventions: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "<query>" --task $TASK_ID`. Match the established resilience idiom (timeout helper, circuit-breaker wrapper, fallback shape) rather than inventing a parallel one.

## Bound every remote call
- Every call leaving the process gets an explicit timeout — connect AND read. No client default, no unbounded wait. A hung dependency must surface as a fast, typed failure, never a stuck caller.
- Set the budget from the caller's deadline, not the dependency's optimism. A downstream timeout longer than the request budget is a bug.

## Fail fast on a dependency that stays down
- For a dependency that can be down for seconds-to-minutes, a circuit breaker beats hammering it: trip after a failure threshold, reject immediately while open, probe before closing.
- A breaker is for sustained failure. For a single transient blip, a bounded timeout (or one retry — see [np-error-handling]) is enough; do not reach for a breaker where a timeout suffices.

## Isolate so one failure does not sink the ship
- Cap the resources any single dependency can consume — connection-pool slice, concurrency limit, dedicated worker set. One slow dependency must not drain the shared pool and freeze unrelated work (bulkhead).
- Make the blast radius explicit: when dependency X is exhausted, exactly which calls degrade — and which stay healthy?

## Degrade instead of erroring, shed instead of collapsing
- Where a stale, cached, or partial answer beats a hard error, define the fallback and return it on failure. State plainly when a response is degraded.
- Under overload, shed or queue with a bound rather than accept everything and fall over. Reject early with a clear signal; protect the work already in flight.

## Make retries safe
- Any call that may be retried (by you, a client, or infrastructure) must be idempotent — idempotency key, conditional write, or natural dedupe. A retried non-idempotent write is data corruption waiting to happen.

## Verification bar (must hold before commit)
- Every new or modified remote call has an explicit, deadline-derived timeout; no unbounded waits remain.
- The pattern matches the failure mode: breaker only where failure is sustained, bulkhead only where a shared resource can be exhausted, fallback only where a degraded answer is acceptable. No unjustified machinery.
- A failing or slow dependency cannot cascade: its resource consumption is capped and the degraded path is exercised, not just declared.
- Overload is shed or bounded, not absorbed until collapse.
- Anything retryable is idempotent; retry/backoff itself lives in [np-error-handling].
- Trips, rejections, fallbacks, and shed load are observable per [np-observability]; added latency budgets respect [np-performance].
