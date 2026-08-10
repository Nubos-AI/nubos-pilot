'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { createSliceWorktree } = require('../../lib/worktree.cjs');

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const sliceFullId = list.find((a) => !a.startsWith('-'));
  if (!sliceFullId) {
    throw new NubosPilotError(
      'worktree-create-missing-slice',
      'slice full-id required (e.g. M001-S001)',
      {},
    );
  }
  const result = createSliceWorktree(sliceFullId, cwd);
  stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

module.exports = { run };
