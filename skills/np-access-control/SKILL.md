---
name: np-access-control
description: "Quality bar for any change that adds or modifies authorization — roles, permissions, policies, scopes, resource ownership, RBAC/ABAC rules, or the checks that gate a protected action. Triggered for executor and architect work on policies, guards, middleware, permission tables, ownership lookups, or anywhere code decides what an identity may do. Encodes authorization rules the change MUST satisfy before commit — not a document to author. Language- and framework-agnostic."
user-invocable: false
---

# Access Control

Authorization decides what an authenticated identity may do. It is the layer attackers reach *after* login, so a logged-in user is not an authorized one. Apply this bar to every access decision the change adds or touches. A missing check is a blocking finding, not a nit.

## Before editing

- Read the existing authz model: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "authorization policy roles permissions" --task $TASK_ID`. Match the established enforcement pattern, role names, and policy idiom; do not introduce a second one.
- Locate the single point where access is enforced for this surface. Add your check there, not in a new ad-hoc spot.

## Deny by default

- Access is granted explicitly, never assumed. A new action, route, field, or resource starts forbidden and is opened deliberately.
- A missing or unrecognized role/permission means deny, not allow. No fail-open branches, no "if no rule matched, proceed".
- Adding a route or handler never silently widens access.

## Enforce server-side, at the right object

- Every protected action is authorized on the server. Client-side hiding is UX, never a control — the agent and the user can both call the endpoint directly.
- Check against the *acting* identity, resolved from the session/token — never a role, user id, or `isAdmin` supplied in the request body or params.
- Check against the *specific* resource (object-level authz). Prevent IDOR: a resource id from the request is untrusted until an ownership/permission lookup confirms this identity may act on *that* object. Listing endpoints filter to the caller's scope; they do not return all rows and trim client-side.

## Model least privilege, keep it auditable

- Grant the narrowest role/scope that makes the change work. No "admin to ship it", no wildcard scope where a specific one suffices.
- Separate authentication from authorization: who-you-are and what-you-may-do are distinct decisions; passing the first never implies the second.
- Roles, permissions, and policies are modeled explicitly and centrally — readable as data/code, not scattered as inline `if user.email ==` conditionals across handlers.
- Privilege changes (grant, revoke, role change) take effect immediately on the next request — no stale cached grant — and are logged with who/what/when.

## Verification bar (must hold before commit)

- Every protected action has a server-side check on the acting identity and the specific resource; no IDOR path remains.
- Default is deny: unmatched/unknown permissions reject, and the new surface is not reachable without an explicit grant.
- The change uses the existing authz model and the narrowest privilege that works — no scattered, no client-trusted, no over-broad grant.
- Grant/revoke takes effect immediately and is logged.
- The forbidden case is proven forbidden: a negative-path test asserts an unauthorized identity and a wrong-owner resource are denied — not just that the happy path is allowed. Pair with [np-test-strategy] for those negative cases, [np-secure-code-review] for the surrounding input/auth surface, and [np-secure-design] when the change introduces a new trust boundary or privilege tier.
- If any item cannot be satisfied within task scope, stop and surface it as an authorization finding — do not commit around it.
