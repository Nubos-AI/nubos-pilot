---
name: np-data-privacy
description: "Quality bar for executor or architect work that collects, stores, processes, exports, or logs personal or sensitive data — user profiles, contact data, identifiers, location, tracking and analytics events, anything tied to a natural person. Triggered for changes touching such flows: the change MUST satisfy these privacy obligations before commit, not a GDPR essay or DPIA document to author. Jurisdiction-agnostic, GDPR-informed. Language- and framework-agnostic."
user-invocable: false
---

# Data Privacy (PII)

Personal data is a liability, not a free asset. Every field you collect, store, or move is something the system must protect, justify, and eventually delete. This bar applies the moment a change touches data tied to a person.

## Before editing
- Read existing data-handling conventions/classification: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "<query>" --task $TASK_ID`.

## Classify and minimize
- Know which fields you touch are personal or sensitive (identity, contact, location, health, financial, biometric, behavioral). Treat anything that singles out a person as PII.
- Collect only what the stated purpose needs. No fields gathered "just in case" or because the schema had room.
- Prefer references and derived signals over raw PII where the feature allows; pseudonymize or anonymize when identity is not required for the use case.

## Purpose and retention
- Data collected for one purpose is not silently reused for another. A new use of existing data is a new decision, not a convenience.
- Every piece of personal data has a defined lifetime and a real deletion path — including derived copies, caches, search indexes, message queues, exports, and backups. Retention with no expiry is a bug.
- Deletion must actually remove or irreversibly anonymize, not just hide a row behind a flag, unless a flag is a documented soft-delete with a real purge job.

## Boundaries that leak
- Never write PII into logs, traces, analytics events, error reports, crash dumps, or LLM prompts. Redact or tokenize before it crosses those seams.
- Do not pass raw personal data to third-party services or models unless the purpose and lawful basis explicitly cover it.
- Access to personal data is least-privilege and auditable. A read of someone's record leaves a trail.

## Subject rights
- If the system promises export or deletion of a person's data, the change must keep that promise reachable — new stores and copies are included in export and erasure, not orphaned.

## Verification bar (must hold before commit)
- Every personal/sensitive field the change introduces is identified and justified by a concrete purpose; nothing is collected speculatively.
- Each new store of PII has a defined retention and a deletion/anonymization path that also covers caches, indexes, and backups.
- No PII reaches logs, analytics, error reporting, or LLM prompts — verified against [np-observability] redaction conventions.
- Data is not reused beyond its original purpose without an explicit, recorded decision.
- Sensitive personal data at rest and in transit is encrypted per [np-encryption]; access is least-privilege and audited per [np-access-control].
- Export and deletion flows the system promises still cover every store this change adds.
- Any new high-risk processing flow (large-scale, sensitive, profiling, or cross-border) is flagged for privacy review before it ships, not after.
