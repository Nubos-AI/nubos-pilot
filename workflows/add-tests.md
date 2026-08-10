---
command: np:add-tests
description: Persist Pass-SCs from VERIFICATION.md as node:test UAT blocks in test/uat/phase-<padded>-<slug>.test.cjs. Sentinel-preserving (D-20, Pitfall 8).
argument-hint: <phase-number>
---

# /np:add-tests

<objective>
After `/np:verify-work` emits VERIFICATION.md with SC classifications,
convert each Pass-SC into a runnable `node:test` case as a UAT regression
suite. User-authored tests outside the `>>> np:add-tests begin … <<< end`
sentinels survive regeneration.
</objective>

## Initialize

```bash
PHASE="$1"
INIT=$(node .nubos-pilot/bin/np-tools.cjs init add-tests init "$PHASE")
```

Parse: `phase`, `target_path`, `verification_path`, `pass_cases[]`,
`skip_cases[]`. Target path is
`<pkgRoot>/test/uat/phase-<padded>-<slug>.test.cjs`.

## Execution

Emit/merge the Sentinel block:

```bash
node .nubos-pilot/bin/np-tools.cjs init add-tests emit "$PHASE"
```

Smoke-run the generated file to catch syntax errors early:

```bash
node --test "$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).target_path))")"
```

## Critic review (tests-axis focused)

Once the UAT file is emitted and the smoke-run is green, the orchestrator spawns ONE `np-critic` instance (ADR-0010) with the rendered UAT file + the milestone's `M<NNN>-VERIFICATION.md` as inputs. Although `np-critic` covers all three axes, the prompt for this invocation should weight the tests-axis (verify-mismatch, missing-test, weak-assertion, etc.) since the deliverable is the test surface. The critic verifies:

- Every Pass-case in `VERIFICATION.md` has a corresponding test in the UAT file.
- Every test name describes observable behaviour.
- No `test.skip(...)` without a corresponding Fail / Defer marker.
- No vacuous assertions.

Off-host dispatch (ADR-0021): if `np-critic` routes to an `openai-compat` provider, run the single review read-only via `spawn-offhost` instead of a native Agent spawn. The off-host critic CANNOT write to `$TMPDIR` (off-host Write is cwd-confined), so it emits the findings object `{ "critic":"critic", "findings":[…] }` as its FINAL MESSAGE; the orchestrator writes that to the critic-report path. The `critic` axis is validated by `mergeCriticOutputs`, which fails closed on an unknown axis (`critic-output-unknown-axis`) — do not re-implement the axis list here; it drifts from `SUPPORTED_CRITIC_AXES`.

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
mkdir -p "${TMPDIR:-/tmp}/nubos-pilot/critic-reports"
CRITIC_REPORT_PATH="${TMPDIR:-/tmp}/nubos-pilot/critic-reports/critic-addtests-${PHASE}.json"
UAT_FILE=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).target_path))")
VERIFICATION_FILE=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).verification_path))")
CRITIC_KIND=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-critic --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).kind||"native")}catch{console.log("native")}})')
if [ "$CRITIC_KIND" = "openai-compat" ]; then
  # Render the tests-axis-weighted critic prompt (UAT file + VERIFICATION.md as
  # files_to_read) PLUS the emit-as-final-message instruction PLUS $LANG_DIRECTIVE
  # into a TMPDIR file, then spawn read-only.
  ADDTESTS_CRITIC_PROMPT="${TMPDIR:-/tmp}/np-offhost-addtests-critic-${PHASE}.md"
  cat > "$ADDTESTS_CRITIC_PROMPT" <<EOF
You are np-critic reviewing a UAT regression suite (tests-axis weighted).

files_to_read:
- ${UAT_FILE}
- ${VERIFICATION_FILE}

Verify, weighting the tests-axis (verify-mismatch, missing-test, weak-assertion, silenced-failure):
- Every Pass-case in VERIFICATION.md has a corresponding test in the UAT file.
- Every test name describes observable behaviour.
- No test.skip(...) without a corresponding Fail / Defer marker.
- No vacuous assertions.

Emit ONLY the findings JSON object { "critic":"critic", "findings":[…] } as your final message.

${LANG_DIRECTIVE}
EOF
  OFFHOST_CRITIC_OUT=$(node .nubos-pilot/bin/np-tools.cjs spawn-offhost \
    --agent np-critic --task-file "$ADDTESTS_CRITIC_PROMPT" --read-only)
  echo "$OFFHOST_CRITIC_OUT" | CRITIC_REPORT_PATH="$CRITIC_REPORT_PATH" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let env,f;try{env=JSON.parse(s);f=JSON.parse(env.content)}catch{console.error("off-host critic: final message is not the findings JSON object");process.exit(1)}if(!f||typeof f!=="object"){console.error("off-host critic: final message is not a JSON object");process.exit(1)}require("fs").writeFileSync(process.env.CRITIC_REPORT_PATH,JSON.stringify(f))})' || exit 1
else
  # → native Agent spawn of np-critic writes $CRITIC_REPORT_PATH (the existing path).
  true
fi
```

Findings of category `missing-test`, `weak-assertion`, `silenced-failure`, or `verify-mismatch` route per `lib/nubosloop.cjs::routeFindings`. A single Build-Fixer-style round on `init add-tests` closes the loop. Beyond one round the workflow exits non-zero and the user resolves manually.

This is intentionally a one-pass adversarial review (not the full Critic-Schwarm) — the UAT-emitter is mechanical and only one axis (test quality) needs adversarial coverage.

## Meta-commit

UAT tests are a PHASE artifact, not a TASK artifact, so ADR-0004
atomic-per-task does not apply — per D-19 this is a phase-level meta
commit. Scope it tightly to the UAT file only (never `git add .`):

```bash
TARGET=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).target_path))")
git add "$TARGET"
git commit -m "docs(${PHASE}): persist UAT from verification"
```

## Scope Guardrail

**Do:**
- Render only the sentinel-bounded block; preserve everything outside.
- Use `test.skip(..., { todo: ... })` for Fail/Defer cases so the suite
  tracks them without failing CI.
- `git add <target>` — single explicit path.

**Don't:**
- Overwrite user-authored tests outside the sentinels.
- Commit the VERIFICATION.md and the UAT file together (separate commits;
  VERIFICATION.md is committed by `/np:verify-work`).

## Output

- `test/uat/phase-<padded>-<slug>.test.cjs` with the sentinel-bounded
  block updated.
- Meta-commit `docs(<padded>): persist UAT from verification`.
## Definition of Done

This workflow exits successfully only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 3 (Do it with tests) — every persisted Pass-case becomes a `node:test` UAT that runs in CI; no skipped or commented-out asserts.
- Rule 5 (Genuinely impress) — UAT names describe observable behaviour, not implementation incidentals.
- Rule 11 (Ship the complete thing) — every Pass-case from VERIFICATION emerges as a runnable test, none deferred.
- Rule 12 (Boil the ocean) — partial coverage exits non-zero; the workflow does not silently skip cases.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
