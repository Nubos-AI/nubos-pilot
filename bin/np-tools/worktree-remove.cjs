'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { removeSliceWorktree } = require('../../lib/worktree.cjs');

function _parseArgs(args) {
  const out = { sliceFullId: null, force: false, keepBranch: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--force') { out.force = true; continue; }
    if (a === '--keep-branch') { out.keepBranch = true; continue; }
    if (!a.startsWith('-') && !out.sliceFullId) out.sliceFullId = a;
  }
  return out;
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(Array.isArray(args) ? args : []);
  if (!parsed.sliceFullId) {
    throw new NubosPilotError(
      'worktree-remove-missing-slice',
      'slice full-id required (e.g. M001-S001)',
      {},
    );
  }
  const result = removeSliceWorktree(
    parsed.sliceFullId,
    cwd,
    { force: parsed.force, deleteBranch: !parsed.keepBranch },
  );
  stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

module.exports = { run, _parseArgs };
