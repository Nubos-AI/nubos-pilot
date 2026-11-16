'use strict';

const { readSnapshot } = require('../../lib/session-snapshot.cjs');

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const snap = readSnapshot(cwd);
  stdout.write(JSON.stringify(snap || { ok: false, reason: 'no-snapshot' }));
  return 0;
}

module.exports = { run };
