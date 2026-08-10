---
name: np-secure-design
description: "Quality bar for designing a new feature, system, or integration with security implications — a new external surface, a new trust boundary, a new privilege or token model, or the handling of sensitive assets (credentials, PII, money, secrets). Triggered for architect and executor work that shapes how a thing will be built, not how it is coded line-by-line. Encodes design-time security rules the design MUST satisfy before commit — the design-time twin of [np-secure-code-review]. Language- and framework-agnostic."
user-invocable: false
---

# Secure Design

Security is decided at design time. A control you forgot to design in is a vulnerability you will ship; the code review can only catch what the architecture left room for. Apply this bar to the design you are about to commit, before any line of implementation depends on it.

## Before editing

- Read existing security decisions/conventions: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "security design <surface>" --task $TASK_ID`. Locked decisions (RULES/CONTEXT) — established trust boundaries, secret stores, privilege models — override generic defaults.
- Name the trust boundaries this design crosses and the assets it protects. Everything else follows from those two facts.

## Secure by default

- The safe configuration is the default. Security is opt-out, never opt-in: encryption on, public access off, the strict policy selected unless deliberately relaxed.
- Fail securely. An error, timeout, or unparseable input denies the action — it never grants access or falls through to a permissive path.
- Build the security gate into the design now, not as a later hardening pass. A control retrofitted onto a shipped surface is a migration, not a tweak.

## Least privilege & blast radius

- Every component, credential, and token gets the minimum access it needs and nothing more. No shared god-credentials, no wildcard scopes, no standing admin.
- Scope and time-box tokens; isolate secrets in a store, never in code, config, or the same blast radius as the data they unlock.
- Segment so a single compromise is contained. Ask: if this component is fully owned, what else falls? Design to make that answer small.

## Zero trust & defense in depth

- Authenticate and authorize every request at the boundary. Never trust the network, the caller's claimed identity, or a client-supplied role/flag — verify against the acting identity on the specific resource.
- Never rely on a single control. A WAF is not a substitute for input validation; network position is not a substitute for authz. Each layer assumes the one in front of it failed.
- Validate across boundaries even between your own services — internal does not mean trusted.

## Threat-informed

- Design against how this will actually be attacked, not a generic checklist. Enumerate the abuse cases for this specific surface and design the control that defeats each — pair with [np-threat-model] for any new trust boundary or external surface.

## Verification bar (must hold before commit)

- The default state of the design is the secure state; relaxing it is an explicit, visible choice.
- Every component/credential/token in the design is least-privilege and scoped; secrets are isolated and a single compromise is contained.
- Every entry point authenticates and authorizes against the acting identity — no implicit trust in network, caller claims, or a single control.
- The design fails closed on every error path, and the security gate is part of the design, not a deferred follow-up.
- Abuse cases for this surface are named and answered — pair with [np-threat-model] to enumerate them and [np-access-control] for the privilege model. The implementation that follows is bound by [np-secure-code-review].
