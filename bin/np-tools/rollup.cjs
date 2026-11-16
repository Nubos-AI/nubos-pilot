'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const rollup = require('../../lib/rollup.cjs');
const { listPhases } = require('../../lib/roadmap.cjs');

function _milestoneArg(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new NubosPilotError(
      'rollup-invalid-milestone',
      'rollup: milestone must be a positive integer, got: ' + String(raw),
      { got: raw == null ? null : String(raw) },
    );
  }
  return n;
}

function _all(cwd) {
  const results = [];
  for (const ph of listPhases(cwd)) {
    const num = ph && Number(ph.number);
    if (!Number.isInteger(num)) continue;
    results.push(rollup.rollupMilestone(num, cwd));
  }
  return { count: results.length, results };
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const raw = list[0];

  if (raw === 'inspect') {
    const mNum = _milestoneArg(list[1]);
    const payload = rollup.inspectMilestone(mNum, cwd);
    stdout.write(JSON.stringify(payload, null, 2));
    return payload;
  }

  const payload = (raw == null || raw === '' || raw === 'all')
    ? _all(cwd)
    : rollup.rollupMilestone(_milestoneArg(raw), cwd);
  stdout.write(JSON.stringify(payload, null, 2));
  return payload;
}

module.exports = { run };
