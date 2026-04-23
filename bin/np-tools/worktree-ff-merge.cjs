'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { ffMergeSliceWorktree } = require('../../lib/worktree.cjs');

function _parseArgs(args) {
  const out = { sliceFullId: null, target: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--target') { out.target = args[++i] || null; continue; }
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
      'worktree-ff-merge-missing-slice',
      'slice full-id required (e.g. M001-S001)',
      {},
    );
  }
  const result = ffMergeSliceWorktree(parsed.sliceFullId, parsed.target, cwd);
  stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

module.exports = { run, _parseArgs };
