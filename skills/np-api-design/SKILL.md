---
name: np-api-design
description: "Quality bar for changes that add or modify an API surface — HTTP/REST endpoints, RPC handlers, GraphQL resolvers, public library/SDK functions, CLI flags, or any contract another system consumes. Triggered for executor work on controllers, routes, handlers, resolvers, or public interfaces. Encodes contract-design rules the change MUST satisfy before commit, not a spec document to author. Language- and framework-agnostic."
user-invocable: false
---

# API Design

An API is a promise. Every endpoint, flag, or exported function you add or touch is a contract you will have to keep. Apply this bar to the contract you are about to commit.

## Before editing

- Read the project's existing API conventions first: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "api endpoint conventions" --task $TASK_ID`. Match the established naming, versioning, error-shape, and pagination idiom — consistency beats personal preference.

## Contract rules

- **Names describe resources and intent**, not implementation. Plural nouns for collections, verbs only where REST nouns don't fit (RPC/CLI). No leaking internal table/class names into the public surface.
- **Inputs are validated and documented at the boundary.** Required vs optional is explicit; unknown fields are rejected or ignored deliberately, never silently mutating behavior.
- **Responses are stable and typed.** One consistent envelope/error shape across the surface. Don't return a bare array where the rest of the API returns an object — additive evolution requires room to grow.
- **Errors are actionable and consistent.** Correct status/category, a stable machine-readable code, and a message that tells the caller what to fix. Same error model everywhere.
- **Idempotency & methods match semantics.** Safe methods don't mutate; retries of idempotent operations don't double-apply. State this for any write path.
- **Pagination, filtering, sorting** follow the existing pattern for any collection that can grow unbounded. No unbounded list endpoints.

## Compatibility (load-bearing)

- A change to an *existing* contract is breaking until proven otherwise: removed/renamed fields, narrowed types, new required inputs, changed defaults, altered error codes. If breaking, either version it or stop and surface it — never silently break consumers.
- Additive change is the default safe move: new optional input, new field, new endpoint.

## Verification bar (must hold before commit)

- Every new/changed input is validated; every response and error follows the surface's existing shape.
- No accidental breaking change to an existing contract (or it is explicitly versioned + flagged).
- Auth and rate/abuse considerations for the new surface are handled — pair with [np-secure-code-review] for any authenticated or input-accepting endpoint.
- The contract is discoverable: types/signatures are explicit enough that a consumer needs no source-reading to call it correctly.
