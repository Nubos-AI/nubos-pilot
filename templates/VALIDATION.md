<!--
  Template placeholders use {{name}} syntax consistently across nubos-pilot templates.
  Every placeholder below is REQUIRED unless its row/section is explicitly marked optional.
  Workflows fill these via the standard template-accumulator; unknown keys raise
  NubosPilotError('template-missing-key', ...) — do NOT swallow.
-->
---
phase: {{phase_number}}
slug: {{phase_slug}}
status: draft
nyquist_compliant: false
wave_0_complete: false
created: {{created_date}}
---

# Phase {{phase_number}} — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | {{test_framework}}        <!-- e.g. pytest 7.x / jest 29.x / vitest / go test --> |
| **Config file** | {{test_config_path}}    <!-- path or "none — Wave 0 installs" --> |
| **Quick run command** | `{{quick_run_command}}` |
| **Full suite command** | `{{full_suite_command}}` |
| **Estimated runtime** | ~{{full_suite_seconds}} seconds |

---

## Sampling Rate

- **After every task commit:** Run `{{quick_run_command}}`
- **After every plan wave:** Run `{{full_suite_command}}`
- **Before `/np:verify-work`:** Full suite must be green
- **Max feedback latency:** {{max_feedback_seconds}} seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| {{task_full_id}} | {{slice_number}} | {{wave_number}} | REQ-{{requirement_number}} | T-{{threat_ref}} / — | {{secure_behavior_or_na}} | unit | `{{automated_command}}` | ✅ / ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `{{test_file_path}}` — stubs for REQ-{{requirement_number}}
- [ ] `{{shared_fixtures_path}}` — shared fixtures
- [ ] `{{framework_install_command}}` — if no framework detected

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| {{manual_behavior}} | REQ-{{requirement_number}} | {{manual_reason}} | {{manual_steps}} |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < {{max_feedback_seconds}}s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** {{approval_status}}        <!-- "pending" or "approved {{approved_date}}" -->
