---
name: np-secure-code-review
description: "Quality bar for any change that touches authentication, authorization, session handling, secrets, cryptography, file uploads, deserialization, SQL or shell construction, SSRF-prone outbound requests, or user-controlled input that reaches a sink. Triggered for executor and security-reviewer work on auth/crypto/SQL/input-handling code. Encodes an OWASP-aligned review checklist the change MUST satisfy before commit — not a document to produce. Language-agnostic."
user-invocable: false
---

# Secure Code Review

A change that touches a security-sensitive surface is not done when the test passes — it is done when it survives this checklist. Apply every relevant section to the diff you are about to commit. A single unaddressed item is a blocking finding, not a nit.

## Before editing

- Read the existing pattern first: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "auth <surface>" --task $TASK_ID`. Match the project's established auth/validation idiom; do not introduce a second one.
- Identify the trust boundary the change crosses. Everything arriving from across it is hostile until validated.

## Input handling

- Validate at the boundary: type, length, range, format, allow-list over deny-list. Reject, don't sanitize-and-hope.
- Parameterize every query. No string-concatenated SQL/NoSQL/LDAP, ever. No shelling out with interpolated user input — pass argv arrays.
- Encode on output for the destination context (HTML, attribute, JS, URL, SQL). Escaping is contextual, not global.
- Treat file paths, redirect targets, and outbound URLs from user input as SSRF/path-traversal vectors: canonicalize and allow-list.

## AuthN / AuthZ

- Authorization is checked server-side on every protected action, against the *acting* identity, on the *specific* resource (no IDOR). Never trust a client-supplied role, id, or `isAdmin`.
- New endpoints/handlers default to deny. Adding a route never silently widens access.
- Session/token: rotate on privilege change, expire, and invalidate on logout. No auth material in URLs or logs.

## Secrets & crypto

- No hardcoded secrets, keys, or tokens in source or fixtures. Read from config/env/secret store.
- Use the platform's vetted crypto primitives. No home-rolled crypto, no MD5/SHA1 for passwords (use the project's password hasher), no ECB, no static IVs.
- Compare secrets in constant time. Generate tokens from a CSPRNG.

## Errors, logging, dependencies

- Error responses leak nothing exploitable (no stack traces, SQL, or internal paths to clients). Log the detail server-side instead.
- Never log secrets, tokens, full PANs, or full PII.
- New dependency? Justify it, pin it, and confirm it is maintained — a new transitive supply-chain surface is a review item.

## Verification bar (must hold before commit)

- Every user-input path in the diff is validated and its sinks are parameterized/encoded.
- Every protected action has a server-side authz check on the acting identity and resource.
- No secret, no home-rolled crypto, no leaking error path introduced.
- If any item cannot be satisfied within task scope, stop and surface it as a security finding — do not commit around it. Pair with [np-threat-model] when the change introduces a new trust boundary.
