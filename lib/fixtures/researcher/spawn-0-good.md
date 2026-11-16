---
schema_version: 1
agent: np-researcher
spawn_index: 0
seed_delta: -7
task_query_hash: "abc123def456"
task_query: "Choose JWT library + session storage for nubos-pilot auth"
decision_count: 2
risk_count: 1
pattern_count: 1
open_question_count: 1
source_count: 2
---

# Researcher output — spawn 0

## Decisions

### D-1: Use jose@6 for JWT signing
- **Rationale:** Maintained, ES256-default, zero peer deps
- **Confidence:** high
- **Evidence:** [CITED: https://github.com/panva/jose v6.0.10 release notes]
- **Reasoning:** Compared jose vs jsonwebtoken vs jws. jose has ES256 default and zero peer deps; jsonwebtoken is deprecated by maintainer; jws is unmaintained since 2020.

### D-2: Session storage via signed cookies, no DB session table
- **Rationale:** Stateless, scales horizontally without sticky sessions
- **Confidence:** med
- **Evidence:** [CITED: OWASP Session Management Cheat Sheet 2024]
- **Reasoning:** Weighed cookie-vs-redis-vs-db. Project has no Redis dep; DB sessions add a write per request. Cookies fit our scale (≤10k DAU).

## Risks

### R-1: Cookie size limit (4KB) bounds JWT claim payload
- **Severity:** med
- **Mitigation:** Strip non-essential claims; store profile separately
- **Reasoning:** Claims like permissions[] grow linearly with role count; 4KB cap hits at ~200 permissions.

## Patterns

### P-1: Refresh-token rotation on every use
- **Description:** Reissue refresh on each /refresh call, invalidate predecessor
- **Source-Type:** docs
- **Reasoning:** OWASP recommends rotation to limit theft window; jose supports JTI claim for tracking.

## Open Questions

### Q-1: Should refresh tokens persist across logout?
- **Why-blocked:** Depends on policy; no precedent in CONTEXT.md.

## Sources

### S-1: https://github.com/panva/jose
- **Type:** docs
- **Notes:** v6.0.10 — latest stable

### S-2: https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/
- **Type:** docs
- **Notes:** OWASP 2021 — authentication failures
