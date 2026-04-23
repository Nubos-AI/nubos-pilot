'use strict';

const { listSliceWorktrees } = require('../../lib/worktree.cjs');

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const list = listSliceWorktrees(cwd);
  stdout.write(JSON.stringify(list) + '\n');
  return 0;
}

module.exports = { run };
