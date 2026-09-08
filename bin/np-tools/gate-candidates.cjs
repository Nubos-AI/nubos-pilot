'use strict';

const gates = require('../../lib/learnings/gate-candidates.cjs');
const args = require('./_args.cjs');

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(argv) ? argv : [];

  const opts = {};
  const t = args.getFlag(list, '--threshold');
  if (t !== undefined) opts.threshold = Number(t);
  const m = args.getFlag(list, '--min-cluster');
  if (m !== undefined) opts.minCluster = Number(m);

  const result = gates.gateCandidates(cwd, opts);

  if (list.includes('--json')) {
    stdout.write(JSON.stringify(result) + '\n');
    return 0;
  }

  if (!result.candidates.length) {
    stdout.write('No recurring failure classes found ('
      + result.negatives + ' negative learning(s) of ' + result.scanned + ' scanned).\n');
    return 0;
  }

  stdout.write('Recurring failure classes — candidates for a mechanical gate\n');
  stdout.write('Scanned ' + result.scanned + ' learnings, ' + result.negatives + ' with a failed/reverted outcome.\n\n');
  let n = 0;
  for (const c of result.candidates) {
    n += 1;
    stdout.write('[' + n + '] ' + c.members + ' related learnings, ' + c.occurrences + ' recorded failure(s)\n');
    if (c.shared_tokens.length) {
      stdout.write('    shared: ' + c.shared_tokens.slice(0, 12).join(', ') + '\n');
    }
    for (const p of c.patterns.slice(0, 3)) {
      stdout.write('    - ' + p.replace(/\s+/g, ' ').slice(0, 140) + '\n');
    }
    if (c.patterns.length > 3) {
      stdout.write('    … and ' + (c.patterns.length - 3) + ' more\n');
    }
    stdout.write('\n');
  }
  stdout.write('Each cluster is a class the model got wrong more than once. Prefer encoding it as a\n');
  stdout.write('lint/compiler rule that cannot go green (derived from existing annotations where\n');
  stdout.write('possible) over restating it in a prompt. Register project runners via\n');
  stdout.write('plan_lint.verify_allow_commands.\n');
  return 0;
}

module.exports = { run };
