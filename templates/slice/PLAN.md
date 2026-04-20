<!-- Placeholders: slice_id, slice_full_id, slice_name, milestone_id, created_date, requirements_json, tasks_xml -->
---
slice: "{{slice_full_id}}"
milestone: "{{milestone_id}}"
type: plan
status: pending
requirements: {{requirements_json}}
---

<objective>
TBD — what does this slice deliver? One sentence describing the outcome.

Purpose: Cover TBD.
Output: TBD (list of artifacts).
</objective>

<context>
TBD — @-reference CONTEXT, RESEARCH, prior SUMMARY files, and any
code modules whose public surface this slice consumes.
</context>

<tasks>
{{tasks_xml}}
</tasks>

<verification>
- TBD
</verification>

<success_criteria>
- TBD
</success_criteria>

<output>
After completion, fill `{{slice_full_id}}-SUMMARY.md` with:
- What changed (summary across tasks)
- Tests run + results
- Follow-ups or deviations
Then run `/np:validate-phase {{milestone_id}}` to run UAT against `{{slice_full_id}}-UAT.md`.
</output>

---
*Slice plan drafted: {{created_date}}*
