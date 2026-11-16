---
schema_version: 1
agent: np-researcher
spawn_index: 2
seed_delta: 7
task_query_hash: "abc123def456"
task_query: "Choose JWT library + session storage for nubos-pilot auth"
decision_count: 2
risk_count: 1
pattern_count: 1
open_question_count: 0
source_count: 1
---

# Researcher output — spawn 2

## Decisions

### D-1: Use jose@6 for JWT signing
- **Rationale:** Best feature/maintenance ratio
- **Confidence:** high
- **Evidence:** [CITED: npm trends https://npmtrends.com/jose]
- **Reasoning:** Looked at npm trends + GitHub activity. jose has consistent commits over 18mo, 50k+ weekly downloads; closest alternative jsonwebtoken has stale-maintenance flag from author since 2023.

### D-2: Session storage via Redis with sliding window
- **Rationale:** Active session invalidation + analytics
- **Confidence:** med
- **Evidence:** [CITED: Redis Sentinel ops doc]
- **Reasoning:** With Redis we can revoke an entire user's sessions on password reset in one call; with cookies we wait for natural expiry or have to maintain a blocklist. Sliding window also gives session-analytics for free.

## Risks

### R-1: Redis becomes single point of failure
- **Severity:** high
- **Mitigation:** Sentinel cluster
- **Reasoning:** If Redis is down, all auth fails. Sentinel cluster mitigates but adds ops cost.

## Patterns

### P-1: Refresh-token rotation on every use
- **Description:** Rotate RT each call
- **Source-Type:** docs
- **Reasoning:** OWASP-standard; works equally for cookie and Redis backends.

## Open Questions

_None._

## Sources

### S-1: https://redis.io/docs/management/sentinel/
- **Type:** docs
- **Notes:** Sentinel ops cost
