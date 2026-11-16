'use strict';

const { summarize, describe } = require('../../lib/eval-reliability.cjs');
const { emitErrorEnvelope } = require('./_args.cjs');

function _usage() {
  return [
    'Usage:',
    '  np-tools.cjs verify-reliability --codes <c1,c2,...>',
    '',
    'pass@k reliability: the orchestrator runs a task\'s <verify> command k times',
    'and passes the collected exit codes (0 = pass). Emits a JSON summary whose',
    '`aggregate_exit_code` is 0 only when every run passed (pass^k) — feed it to',
    '`loop-run-round --phase post-executor --verify-exit-code`. A flaky task',
    'aggregates to red and flows through the normal build-fixer path.',
  ].join('\n');
}

function run(argv, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];

  let codesRaw = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') { stdout.write(_usage() + '\n'); return 0; }
    else if (a === '--codes') { codesRaw = args[++i] || ''; }
    else if (a.startsWith('--codes=')) { codesRaw = a.slice('--codes='.length); }
    else {
      stderr.write(JSON.stringify({
        code: 'verify-reliability-unknown-arg',
        message: 'Unknown argument: ' + a,
        details: { arg: a },
      }) + '\n');
      return 1;
    }
  }

  if (codesRaw == null) {
    stderr.write(JSON.stringify({
      code: 'verify-reliability-missing-codes',
      message: '--codes <c1,c2,...> is required',
      details: {},
    }) + '\n');
    return 1;
  }

  try {
    const codes = String(codesRaw).split(',').map((s) => s.trim()).filter((s) => s !== '').map(Number);
    const summary = summarize(codes);
    stdout.write(JSON.stringify(Object.assign({}, summary, { description: describe(summary) })) + '\n');
    return 0;
  } catch (err) {
    emitErrorEnvelope(err, stderr, 'verify-reliability-internal-error');
    return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
