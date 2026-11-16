<!-- Placeholders: task_id, task_full_id, slice_full_id, milestone_id, created_date, task_name, files_modified_yaml, depends_on_yaml, tier, wave, read_first_text, action_text, verify_text, acceptance_text, done_text -->
---
id: "{{task_full_id}}"
slice: "{{slice_full_id}}"
milestone: "{{milestone_id}}"
type: execute
status: pending
tier: "{{tier}}"
owner: executor
wave: {{wave}}
depends_on: {{depends_on_yaml}}
files_modified: {{files_modified_yaml}}
autonomous: true
must_haves: {}
---

# {{task_full_id}} — {{task_name}}

<read_first>
{{read_first_text}}
</read_first>

<action>
{{action_text}}
</action>

<verify>
{{verify_text}}
</verify>

<acceptance_criteria>
{{acceptance_text}}
</acceptance_criteria>

<done>
{{done_text}}
</done>

<output>
After completion, fill `{{task_full_id}}-SUMMARY.md` with:
- What changed (one line per file touched)
- Tests run + results
- Follow-ups or deviations
</output>

---
*Task: {{task_full_id}}*
*Planned: {{created_date}}*
