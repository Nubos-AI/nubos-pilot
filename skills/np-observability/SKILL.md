---
name: np-observability
description: "Quality bar for changes that add or modify a code path that should be observable — services, request handlers, background jobs, integrations with external systems, and any new failure path. Triggered for executor work on handlers, workers, clients, or error branches. Encodes the logging/metrics/tracing rules the change MUST satisfy before commit so the path is diagnosable from telemetry alone, not a runbook or dashboard to author. Language- and framework-agnostic."
user-invocable: false
---

# Observability

If something breaks at 3am, can the on-call person see what happened from logs and metrics alone — without you adding logging during the incident? Apply this bar to the code path you are about to commit.

## Before editing

- Read the project's existing telemetry conventions first: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "logging metrics conventions" --task $TASK_ID`. Match the established log idiom, metric naming, and trace-context propagation — consistency beats personal preference.

## Logging

- **Structured, not string-concatenated.** Emit key-value fields (`order_id`, `duration_ms`), never bake variables into a prose sentence. Machines query fields; they can't grep your prose.
- **Levels mean something.** `error` = actionable, someone must look; `warn` = degraded but handled; `info` = significant state change at a boundary; `debug` = development detail. Don't log expected control flow as `error` — error noise hides real errors.
- **Carry the correlation/request/trace id** on every log line so a single request can be reconstructed across the path.
- **Never log secrets, tokens, credentials, or PII.** Redact at the logging boundary, not by hoping callers don't pass them.
- **Log once at the boundary**, not at every layer the value passes through. Don't log inside hot loops or per-iteration — aggregate and emit once.

## Metrics

- **Emit a metric for what you'll need to answer "is it healthy / how often / how slow."** Counter for occurrences, histogram/timer for latency, and a way to compute error rate (success vs failure count) on any path that can fail.
- **Follow the existing metric naming** and label/tag conventions. Don't invent a parallel scheme. Keep label cardinality bounded — no user ids or raw inputs as labels.

## Tracing

- **Propagate trace context across every service and async boundary** — outgoing requests, queue publishes, job pickups. A dropped context turns one trace into orphans.

## Verification bar (must hold before commit)

- Every new failure path is diagnosable from logs + metrics alone: a structured log at `warn`/`error` with the correlation id, and a counter that increments on failure.
- Logs are structured key-value with correct levels; no secrets/tokens/PII reach any sink — pair with [np-secure-code-review].
- Error branches carry actionable context (what failed, identifying ids) so the cause is clear without re-reading source — align with [np-error-handling].
- New metrics follow existing naming/labels; latency and error rate are observable for any path that can be slow or fail.
- Trace context is propagated across every service/async hop the change introduces.
- No logging in hot loops; the path logs once at its boundary, not at every layer.
