# Authoring gates that can fail honestly

A gate is a completion contract. nubos-pilot enforces the mechanical half — `commit-task` refuses a task without a green verify transition, `loop-run-round --phase post-executor` records the exit code — but no tool can tell whether an English criterion and a shell command mean the same thing. That half is the author's job.

## Shape of a runnable gate

In a task plan the runnable gate is the `<verify>` block:

```xml
<verify>
npm test -- --test-name-pattern="import rejects malformed records"
</verify>
```

It is met only when:

1. the command exits `0`,
2. its output contains a success marker that a failing run cannot print (the runner's pass summary, a `verification passed` line emitted after the last assertion), and
3. it ran after the last change to the code under test, the plan, or the command.

A non-zero exit never passes because its error text contains the marker. A timeout, a missing binary, a linter that was skipped because it is not installed, or a filtered test run that matched zero tests is unmet.

## Rules

- **Observe the outcome directly.** The command reads the artifact, endpoint or measurement the criterion names. `AC-2: invoices reconcile` checked by `node -e "console.log('ok')"` is syntactically valid and worthless.
- **Emit a success-only marker.** The check performs every assertion, exits non-zero on any failure, and prints its marker only after all assertions passed.
- **Prove the test can fail.** A new test is trusted only after it was observed failing against the missing or broken behaviour. A test that passes before the implementation exists proves nothing.
- **Give absence checks a positive control.** Before trusting "no `TODO` in the diff" or "no secret in the bundle", run the same logic against a fixture that contains the thing and confirm the check fails. A wrong path or a malformed pattern otherwise looks like a clean absence.
- **Measure numbers, never copy them.** A figure from the brief ("p95 under 200 ms", "coverage ≥ 80 %") is computed by the check from source data and compared against the threshold. Copying the number into the expected output makes it its own proof.
- **Guard filtered runs.** A `--grep` / `--filter` / `-t` pattern that matches nothing exits `0` on many runners. Assert the executed test count is non-zero.
- **Use the project's toolchain.** Derive linters and runners from `node .nubos-pilot/bin/np-tools.cjs detect-stack --lint-commands` and the manifests present. Never hardcode a stack. Do not assume `grep`, `tail` or `tr` exist on every host; prefer the project's own scripts.
- **Re-run in the same environment.** Orchestrator re-verification uses the same toolchain and working directory as the executor. An environment mismatch is a failed verification to resolve, not evidence.
- **Keep evidence decisive and small.** Record the command, exit code and the marker line. Do not paste full logs into SUMMARY files; `verify_output_excerpt` in the checkpoint already carries the bounded excerpt.

## Manual gates

Some outcomes no command can decide — visual polish, wording against a product decision, a UX flow. For each manual gate:

- cite the exact artifact, file:line, screenshot or measurement,
- review consequences, not only surface polish,
- obtain independent review (critic, verifier, `np-council`) when the consequence is high,
- keep the gate unmet while evidence is ambiguous — in `/np:verify-work` that is `needs_user_confirm`, never `Pass`.

Try to make the riskiest outcome runnable. Do not accept "manual" as the default because writing the check is harder.

## Placement: task gates versus slice gates

Place a gate where its evidence lives.

- A task gate reads only what that task's `files_modified` can change. A whole-project regression suite smuggled into every task's `<verify>` re-runs the entire tree for each task and hides which task broke it.
- Cross-task outcomes — interface compatibility, end-to-end behaviour, regressions across the joined work — belong in the slice `<verification>` / `<success_criteria>` and run once after every task of the slice returned.
- Milestone SCs are verified by `/np:verify-work` against the integrated result, never by aggregating task SUMMARY claims.

## Lint signals for plan-checkers

Flag a gate as a finding when:

- the command is a fixed-output emitter (`echo`, `true`, `console.log` of a constant),
- the expected marker is vocabulary that failure output also prints (`error`, `done`, `finished`),
- a number in a criterion is not computed by any check,
- an absence check has no positive control,
- a title names an activity ("refactor the importer") instead of an observable outcome ("importer rejects malformed rows with `E_ROW_SHAPE`"),
- a slice is mostly manual gates while runnable checks were feasible.

A lint signal is a prompt to sharpen the gate, not proof the outcome is wrong.

## Abandonment

Use abandonment only when a required outcome is genuinely impossible within the authorized task. Keep the original gate, record one non-empty reason, route it through `Deferred` / `stuck` / `needs_user_confirm` / `askuser`, and name it in the final report. A handed-off gate is terminal and never successful: its task, slice and milestone are not done.
