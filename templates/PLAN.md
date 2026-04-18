<!-- Placeholders: autonomous, created_date, depends_on_json, files_modified_yaml, phase, plan, plan_id, requirements_json, wave -->
---
phase: "{{phase}}"
plan: "{{plan}}"
plan_id: "{{plan_id}}"
type: execute
wave: {{wave}}
depends_on: {{depends_on_json}}
files_modified:
{{files_modified_yaml}}
autonomous: {{autonomous}}
requirements: {{requirements_json}}
---

<objective>
TBD — what does this plan deliver, and why now? One or two sentences.

Purpose: Cover TBD.

Output: TBD (list of artifacts).
</objective>

<context>
TBD — @-reference the CONTEXT.md, RESEARCH.md, prior PLAN.md files, and any
lib modules whose public surface this plan consumes.
</context>

<tasks>

<task type="auto">
  <name>Task 1: TBD</name>
  <files>TBD</files>
  <read_first>
    - TBD
  </read_first>
  <action>
TBD — describe the concrete edit or creation. Keep it to a single commit.
  </action>
  <verify>
    <automated>TBD — runnable command that returns exit 0 on success.</automated>
  </verify>
  <acceptance_criteria>
    - TBD
  </acceptance_criteria>
  <done>TBD — one-line statement of the task's done state.</done>
</task>

</tasks>

<threat_model>
| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-TBD     | TBD      | TBD       | mitigate    | TBD             |
</threat_model>

<verification>
- TBD
</verification>

<success_criteria>
- TBD
</success_criteria>

<output>
After completion, create `.nubos-pilot/phases/{{phase}}-<slug>/{{plan_id}}-SUMMARY.md` covering: TBD.
</output>

---
*Plan drafted: {{created_date}}*
