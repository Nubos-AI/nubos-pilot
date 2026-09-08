'use strict';

// pass@k reliability: the orchestrator runs a task's <verify> command k times
// and feeds the collected exit codes here. A task that passes only sometimes is
// FLAKY — not green. summarize() folds k runs into a single aggregate exit code
// (0 only when every run passed — pass^k semantics) so flakiness flows through
// the EXISTING verify-red → build-fixer path. No new critic category is
// introduced (that would risk the unknown-category spurious-stuck trap).

const { NubosPilotError } = require('./core.cjs');

/**
 * @param {number[]} exitCodes  one exit code per verify run (0 = pass)
 * @returns {{runs:number, passes:number, fails:number, pass_at_1:boolean, pass_at_k:boolean, flaky:boolean, verdict:string, aggregate_exit_code:number}}
 */
function summarize(exitCodes) {
  if (!Array.isArray(exitCodes) || exitCodes.length === 0) {
    throw new NubosPilotError(
      'eval-reliability-no-runs',
      'summarize requires a non-empty array of exit codes',
      { got: exitCodes },
    );
  }
  const codes = exitCodes.map((c) => Number(c));
  if (codes.some((c) => !Number.isInteger(c))) {
    throw new NubosPilotError(
      'eval-reliability-bad-code',
      'every exit code must be an integer',
      { codes: exitCodes },
    );
  }

  const runs = codes.length;
  const passes = codes.filter((c) => c === 0).length;
  const fails = runs - passes;
  const passAt1 = codes[0] === 0;
  const passAtK = passes === runs;
  const flaky = passes > 0 && fails > 0;

  let verdict;
  if (passAtK) verdict = 'reliable-pass';
  else if (passes === 0) verdict = 'reliable-fail';
  else verdict = 'flaky';

  // pass^k: green only if every run passed. Flaky and all-fail both aggregate
  // to non-zero so the loop treats them as verify-red.
  const aggregate_exit_code = passAtK ? 0 : 1;

  return { runs, passes, fails, pass_at_1: passAt1, pass_at_k: passAtK, flaky, verdict, aggregate_exit_code };
}

/** One-line human summary for the verify log the build-fixer reads. */
function describe(s) {
  if (s.runs === 1) {
    return s.pass_at_k ? 'verify passed (1 run)' : 'verify failed (1 run)';
  }
  if (s.verdict === 'reliable-pass') return 'verify reliably passed (' + s.passes + '/' + s.runs + ' runs)';
  if (s.verdict === 'reliable-fail') return 'verify reliably failed (0/' + s.runs + ' runs passed)';
  return 'FLAKY: verify passed only ' + s.passes + '/' + s.runs + ' runs — non-deterministic, treated as red. '
    + 'Make the verified behaviour deterministic (no sleeps/real clock/network/ordering) before this task can go green.';
}

module.exports = { summarize, describe };
