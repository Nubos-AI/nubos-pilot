'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { setHandoffStatus } = require('../../lib/handoff.cjs');

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const positional = list.filter((a) => !a.startsWith('-'));
  const id = positional[0];
  const newStatus = positional[1];
  if (!id || !newStatus) {
    throw new NubosPilotError(
      'handoff-status-missing-args',
      'usage: handoff-status <id> <new-status>',
      { got: { id, newStatus } },
    );
  }
  const result = setHandoffStatus(id, newStatus, cwd);
  stdout.write(JSON.stringify({ id, status: result }) + '\n');
  return 0;
}

module.exports = { run };
