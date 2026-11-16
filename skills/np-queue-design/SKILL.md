---
name: np-queue-design
description: "Quality bar for executor work that adds or changes asynchronous job, message-queue, or worker code — producers, consumers, background jobs, event handlers, task processors, and the messages they exchange. Triggered whenever a change enqueues, dequeues, or processes work off the request path, encoding the async-correctness rules the change MUST satisfy before commit (idempotent consumers under at-least-once delivery, no assumed ordering, a real failure path with backoff and dead-letter, ack timeouts above worst-case processing, bounded backpressure, small versioned payloads, observable jobs). This is a bar the change must meet, not a queue spec to author. Language- and broker-agnostic."
user-invocable: false
---

# Queue Design

A queue decouples producer from consumer in time — and in doing so trades synchronous certainty for delivery guarantees that are weaker than they look. Design the consumer for the guarantees the transport actually gives, not the ones you wish it gave.

## Before editing
- Read existing conventions: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "<query>" --task $TASK_ID`. Match the established queue/job idiom (naming, serializer, retry policy, dead-letter convention) rather than inventing a parallel one.

## Assume at-least-once; make consumers idempotent
- Treat every message as possibly delivered more than once. Processing the same message twice MUST produce the same result — dedupe on a message/business key, use a conditional or upsert write, or record processed IDs. Exactly-once is largely a myth; idempotency is the real defense.
- Do not assume ordering. Only rely on order when the transport guarantees it AND the work genuinely needs it; otherwise make handlers order-independent.

## Every consumer needs a failure path
- A handler that can fail needs explicit retry with backoff, a max-attempts cap, and a dead-letter queue for what exhausts it. A poison message that always fails MUST NOT block the queue or retry forever — route it to the DLQ and move on.
- Set the visibility/ack timeout longer than the worst-case processing time. Too short and the broker redelivers in-flight work, double-processing it.

## Bound the queue and the payload
- A queue that grows unbounded is an outage waiting to happen. Define what happens under backpressure — bound depth, shed, or scale consumers — and make lag observable; do not let it silently accumulate.
- Keep the payload small: carry IDs and references, not large blobs. Version the message schema so producer and consumer can evolve independently; a consumer must tolerate an unknown newer field, not crash on it.

## Verification bar (must hold before commit)
- The consumer is idempotent: redelivery of the same message produces the same result, proven by a dedupe key, conditional write, or processed-ID record — not by hoping delivery is exactly-once.
- No unjustified reliance on ordering; where order is required, the transport actually guarantees it.
- A failure path exists: bounded retry with backoff, a max-attempts cap, and a dead-letter destination — a poison message cannot stall or loop the queue. Retry/backoff mechanics align with [np-error-handling].
- Visibility/ack timeout exceeds worst-case processing time; no window where in-flight work is redelivered and run twice.
- Backpressure is bounded and queue depth/lag is observable per [np-observability]; failures, retries, and DLQ arrivals are logged with enough context to diagnose what failed and how often.
- The payload is small and the schema versioned; consumers tolerate additive schema change. Cross-boundary failure handling for the enqueue/dequeue call follows [np-resilience-patterns].
