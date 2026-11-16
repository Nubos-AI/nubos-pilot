---
name: np-caching-strategy
description: "Quality bar for changes that add or modify a cache — in-memory caches, Redis/Memcached or other distributed caches, HTTP/CDN response caching, or memoization of a computed value. Triggered for executor work that introduces or alters any layer that stores and reuses a previously computed or fetched result. Encodes caching-correctness rules the change MUST satisfy before commit, not a design document to author. Language- and framework-agnostic."
user-invocable: false
---

# Caching Strategy

A cache is a correctness liability you take on to buy speed, not a free win. Every entry you store is a second source of truth that can lie. Apply this bar to the cache you are about to commit.

## Before editing

- Read the project's existing caching conventions first: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "cache invalidation TTL key" --task $TASK_ID`. Match the established cache layer, key prefix, serialization, and invalidation idiom — don't introduce a second caching mechanism alongside one that already works.

## Justify the cache

- **Cache only when measurement shows it helps and correctness allows it.** Have a real number — the cost being avoided (slow query, expensive computation, remote call) and the hit rate you expect. No cache "just in case"; an unmeasured cache adds risk and buys nothing.
- **The cache is an optimization, not a dependency.** The system MUST stay correct with the cache empty or unavailable — same answer, slower. A miss recomputes the true value; the cache never becomes the only place data lives.

## Key & correctness

- **The key captures every input that changes the value.** Identity, tenant, locale, permission scope, feature flags, API version — anything that varies the result varies the key. A cache that serves one user's data to another is a security incident, not a performance bug.
- **Never store per-user secrets or sensitive data in a shared cache.** Scope sensitive entries per principal or keep them out entirely — pair with [np-secure-code-review] for anything auth- or PII-adjacent.

## Invalidation & bounds (load-bearing)

- **Every cache has an explicit invalidation story** — TTL, write-through, or event-based. "Stale forever" is a bug. State, for this cache, how an entry becomes wrong and what removes or refreshes it; write paths that change cached data must invalidate or update it.
- **The cache is bounded.** Max size plus an eviction policy (LRU/TTL) so it cannot grow until it exhausts memory. An unbounded cache is a memory leak with a delay.
- **Expiry handles the stampede.** When a hot key expires, concurrent misses must not all stampede the backing store — use a lock/single-flight, staggered TTLs, or stale-while-revalidate.

## Verification bar (must hold before commit)

- A measured reason this cache exists; the system is provably correct with the cache empty (miss recomputes the true value).
- The key includes every value-varying input (identity/tenant/locale/permissions) — no cross-principal or cross-context bleed.
- An explicit invalidation path exists and every write that changes the cached value triggers it — no path leaves an entry stale forever.
- The cache is size-bounded with an eviction policy; expiry of a hot key cannot stampede the backing store.
- No per-user secret or sensitive value lands in a shared cache — pair with [np-secure-code-review].
- Cross-link [np-performance] for the hit-rate / latency claim and [np-data-modeling] for what the cached shape represents and how it stays consistent with its source.
