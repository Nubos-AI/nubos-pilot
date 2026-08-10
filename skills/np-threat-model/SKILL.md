---
name: np-threat-model
description: "Quality bar for any change that introduces or alters a trust boundary, opens a new attack surface, adds an external integration, or handles sensitive data/assets — new ingress, a webhook/callback, a queue consumer, a third-party API call, a privilege transition, a new datastore for credentials/PII. Triggered for executor and security-reviewer work on such changes. Encodes a lightweight STRIDE reasoning checklist the change MUST satisfy before commit — reasoning over the diff, not a formal report to produce. Language- and framework-agnostic."
user-invocable: false
---

# Threat Model

A new trust boundary is a new promise an attacker will test. Threat modeling here is not a document — it is the act of reasoning over the diff before you commit it: what asset moved, who can now reach it, and what stops them from abusing it. Apply this bar whenever the change touches a boundary, surface, integration, or sensitive asset.

## Before editing

- Read the project's existing boundaries and assumptions first: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "threat model <surface>" --task $TASK_ID`. Reuse the established trust model; do not invent a parallel one.

## Frame the change

- **Name the assets the change touches** — credentials, PII, money, tokens, audit integrity, availability of a path. If it touches none, the surface is the asset.
- **Draw the trust boundary** the diff crosses: where does untrusted input enter, where does privilege change, what is now reachable that wasn't. Everything arriving from across it is hostile until proven otherwise.
- **List the new actors** — anonymous caller, authenticated-but-not-authorized user, a compromised dependency, the integration partner itself.

## Enumerate threats (STRIDE lens)

- **Spoofing** — can an actor claim an identity they don't hold? Is the caller, webhook, or integration authenticated and its origin verified?
- **Tampering** — can request, payload, stored asset, or in-transit data be altered? Integrity checks, signatures, parameterized sinks.
- **Repudiation** — is a security-relevant action attributable? Is there a tamper-evident audit trail for the new path?
- **Information disclosure** — can the asset leak via responses, errors, logs, timing, or an over-broad scope? Least exposure by default.
- **Denial of service** — can the new surface be exhausted (unbounded work, no rate limit, amplification via the integration)?
- **Elevation of privilege** — can the change be used to gain rights? Does any new path default-allow or cross a boundary without an authz check?

## Rank and mitigate

- Rank each credible threat by **likelihood × impact**; spend the diff's effort on the high cells, not the theoretical tail.
- Every credible threat is either **mitigated inside this change** or recorded as an **explicit accepted-risk finding** — never silently left open.
- Mitigations live in the diff, not in a future ticket. Implement the secure default; pair concrete sink/auth hardening with [np-secure-code-review].

## Verification bar (must hold before commit)

- The trust boundary and the assets the change touches are named, and untrusted input across it is treated as hostile.
- Each STRIDE category was applied to the new surface; every credible threat has a mitigation in the diff or an explicit accepted-risk finding.
- The new actor with the least privilege cannot reach an asset they shouldn't — spoofing and elevation paths are closed by default-deny.
- The new path is attributable (audit) and bounded (rate/quota); errors and logs disclose nothing exploitable.
- If a high-likelihood × high-impact threat cannot be mitigated within task scope, stop and surface it — do not commit around it.
