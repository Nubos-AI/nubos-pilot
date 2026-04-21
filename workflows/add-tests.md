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
