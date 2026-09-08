---
name: np-error-handling
description: "Quality bar for changes that touch backend, service, integration, or IO code that can fail — network calls, database writes, external APIs, file/queue/process work, batch loops. Triggered for executor work on any failure-prone path; encodes the resilience checklist the change MUST satisfy before commit (fail loud, preserve cause, timeouts, bounded retries, idempotency, resource cleanup, actionable errors), not a doc to author. Language- and framework-agnostic."
user-invocable: false
---

# Error Handling & Resilience

Code that can fail must fail predictably. The bar below is about what the change does on the unhappy path, not the happy one.

## Before editing
- Read existing conventions: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "error handling retry conventions" --task $TASK_ID`. Match the established error/retry idiom rather than inventing a new one.

## Fail loud, preserve context
- No empty catch and no catch-and-continue that hides a failure. If you catch, you handle, rethrow, or log-and-escalate.
- Distinguish recoverable errors (retry, fallback, degrade) from programmer errors (bug — let it crash, don't paper over).
- When wrapping an error, preserve the original cause/stack/chain. Never discard the inner error to throw a vague new one.
- Surface actionable errors to callers: enough to act on, no internals (no stack traces, secrets, SQL, or host details leaking across a trust boundary).

## Outbound calls & retries
- Every outbound or blocking IO call (network, DB, queue, subprocess, lock) has an explicit timeout. No unbounded waits.
- Retry only idempotent operations. Use backoff with a hard attempt/time cap — no tight retry loops, no retry storms against a struggling dependency.
- Write paths that may be retried are idempotent (idempotency key, upsert, or dedup) so a retry can't double-apply.

## Cleanup & partial failure
- The failure path releases what the success path acquired: connections, file handles, locks, temp files, transactions. Prefer finally/defer/with-style guarantees over manual unwind.
- Validate inputs before mutating state where cheap; otherwise make partial mutation recoverable. Don't leave half-written state on error.
- Batch/loop work decides explicitly: fail-fast or collect-and-report. Don't let one bad item silently drop the rest or mask which items failed.

## Verification bar (must hold before commit)
- No silent swallow: every catch handles, rethrows with cause, or escalates — verified, not assumed.
- Every new outbound/IO call has a timeout; every retry has backoff and a cap; retried writes are idempotent.
- Failure paths free all acquired resources; no leaked handles, locks, or open transactions.
- Caller-facing errors are actionable and leak no internals; batch work reports partial failures.
- Error and retry paths are covered, not just the happy path — see [np-test-strategy].
- Failures and retries are observable (logged/metered with cause and context) — see [np-observability].
- Error shapes and status codes returned across an API boundary are consistent — see [np-api-design].
