'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { readHandoff } = require('../../lib/handoff.cjs');

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const id = list.find((a) => !a.startsWith('-'));
  if (!id) {
    throw new NubosPilotError('handoff-read-missing-id', 'handoff id required', {});
  }
  const rec = readHandoff(id, cwd);
  stdout.write(JSON.stringify(rec) + '\n');
  return 0;
}

module.exports = { run };
