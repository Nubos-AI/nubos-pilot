---
schema_version: 1
agent: np-researcher
spawn_index: 1
seed_delta: 0
task_query_hash: "abc123def456"
task_query: "Choose JWT library + session storage for nubos-pilot auth"
decision_count: 2
risk_count: 1
pattern_count: 1
open_question_count: 0
source_count: 1
---

# Researcher output — spawn 1

## Decisions

### D-1: Use jose@6 for JWT signing
- **Rationale:** Modern, secure, actively maintained
- **Confidence:** high
- **Evidence:** [CITED: https://github.com/panva/jose v6.0.10]
- **Reasoning:** Benchmark vs other libraries — jose is the only one supporting modern WebCrypto with zero-runtime-deps; alternatives (jsonwebtoken) have CVE-2022-23529 history.

### D-2: Session storage via signed cookies, no DB session table
- **Rationale:** Stateless design, no horizontal-scale state
- **Confidence:** med
- **Evidence:** [CITED: Auth.js docs https://authjs.dev/concepts/session-strategies]
- **Reasoning:** Auth.js documents three strategies; cookies are the default for the stateless pattern; DB sessions only justified when concurrent-session-invalidation is required, which our spec does not require.

## Risks

### R-1: Cookie size limit (4KB) bounds JWT claim payload
- **Severity:** med
- **Mitigation:** Minimal claims; profile fetched on demand
- **Reasoning:** Most browsers cap individual cookie at 4096B; JWT base64-encoded grows ~33% over raw JSON.

## Patterns

### P-1: Refresh-token rotation on every use
- **Description:** Each refresh call returns a new RT and invalidates the prior one
- **Source-Type:** docs
- **Reasoning:** Standard OWASP guidance; prevents long-lived stolen-RT abuse.

## Open Questions

_None._

## Sources

### S-1: https://authjs.dev/concepts/session-strategies
- **Type:** docs
- **Notes:** Three strategies documented; cookie default
