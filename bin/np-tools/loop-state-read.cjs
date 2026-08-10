'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const checkpoint = require('../../lib/checkpoint.cjs');
const { TASK_ID_RE } = require('../../lib/ids.cjs');
const args = require('./_args.cjs');

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(argv) ? argv : [];
  const taskId = list[0];
  args.assertMatch(taskId, TASK_ID_RE, 'loop-state-invalid-task-id', 'taskId');
  const strict = list.includes('--strict');
  const cp = checkpoint.readCheckpoint(taskId, cwd);
  const state = cp && cp.nubosloop ? cp.nubosloop : null;
  if (strict && cp == null) {
    throw new NubosPilotError(
      'loop-state-task-not-found',
      'no checkpoint exists for task ' + taskId,
      { taskId, hint: 'startTask must run before loop-state-read --strict' },
    );
  }
  const payload = {
    task_id: taskId,
    nubosloop: state,
    task_exists: cp != null,
  };
  stdout.write(JSON.stringify(payload) + '\n');
  return payload;
}

module.exports = { run };
