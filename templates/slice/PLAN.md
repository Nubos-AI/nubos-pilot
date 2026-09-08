<!--
  Placeholders: slice_id, slice_full_id, slice_name, milestone_id, created_date, requirements_json, tasks_xml
  Every `TBD` below is a MUST-FILL slot before the slice can enter /np:execute-phase.
  np-planner fills these; np-plan-checker rejects any remaining `TBD` as `issues_found`.
-->
---
slice: "{{slice_full_id}}"
milestone: "{{milestone_id}}"
type: plan
status: pending
requirements: {{requirements_json}}
---

<objective>
<!-- MUST FILL — one sentence describing the outcome of this slice. -->
TBD — what does this slice deliver?

Purpose: TBD — why this slice exists in the milestone arc.
Output: TBD — list of artifacts (files, schemas, endpoints) the slice produces.
</objective>

<context>
<!-- MUST FILL — @-reference the docs the executor needs to internalize. -->
TBD — list CONTEXT, RESEARCH, prior SUMMARY files, and any code modules whose public surface this slice consumes.
</context>

<reality_check>
<!-- MUST FILL, and MUST stay above <tasks>. np-plan-checker Dimension 12 rejects a
     missing/empty block, or any <assumption> without a resolvable verified_by, as
     `unverified-assumption` (critical). -->
  <files_read>
    - TBD — path:line per load-bearing fact (versions from the lockfile, signatures from the source)
  </files_read>
  <commands_run>
    - TBD — `cmd` → "literal output substring you observed", or empty if none were needed
  </commands_run>
  <assumptions>
    <assumption verified_by="TBD path:line or cmd:<command>">TBD — one load-bearing assumption</assumption>
  </assumptions>
  <pattern_refs>
  <!-- CONDITIONAL — required exactly when a task tells the executor to mirror / copy /
       follow an existing implementation, and forbidden-by-emptiness otherwise (delete
       the block if this slice mirrors nothing). behavior= records what the code
       OBSERVABLY does, not what this slice wants. A <deviation> is mandatory when an
       acceptance criterion needs behaviour the reference does not have — without it,
       "mirror X" plus a differing criterion is `contradictory-requirements` (critical).
       plan-lint enforces the presence and attribute-completeness mechanically;
       plan-checker Dimension 13.2 re-reads the cited line and verifies the claim.
       See ADR-0032. -->
  </pattern_refs>
  <unknowns>
  <!-- Empty in the happy path. Otherwise one entry per unresolved item, each with a
       reason and the Wave-0 reconnaissance task in THIS slice that resolves it. -->
  </unknowns>
</reality_check>

<tasks>
{{tasks_xml}}
</tasks>

<verification>
<!-- MUST FILL — bullet list of automated checks that prove the slice is done.
     Each bullet maps to ≥1 task's <verify> block. Empty list = slice cannot pass /np:validate-phase. -->
- TBD
</verification>

<success_criteria>
<!-- MUST FILL — observable acceptance criteria. Maps to milestone-level SC-N entries.
     Empty list = no acceptance gate = critic-acceptance routes everything to issues_found. -->
- TBD
</success_criteria>

<output>
<!-- INFORMATIONAL (no fill needed) — describes what happens at slice close. -->
After completion, fill `{{slice_full_id}}-SUMMARY.md` with:
- What changed (summary across tasks)
- Tests run + results
- Follow-ups or deviations
Then run `/np:validate-phase {{milestone_id}}` to run UAT against `{{slice_full_id}}-UAT.md`.
</output>

---
*Slice plan drafted: {{created_date}}*
