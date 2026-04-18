# External Audit — Milestone v1.0

Author: external reviewer
Date: 2026-04-10

This audit was commissioned after Phase 7 verification revealed partial gaps
not covered by the automatic VERIFICATION.md scan. Two corrective items are
proposed here for inclusion as new phases in the roadmap.

## Gap: CORS policy too permissive on /api/admin

**Source phase:** 7

The current configuration allows `*` on the admin endpoints. This should be
restricted to the first-party frontend origins only.

Recommended remediation: introduce a hardened CORS middleware scoped to the
admin router, backed by an allow-list sourced from config.

## Gap: Audit log retention misconfigured

**Source phase:** 7

Audit logs are currently purged after 7 days; compliance requires 90 days.
The retention window is set in `config/logging.yml` and must be raised along
with the corresponding backup job.
