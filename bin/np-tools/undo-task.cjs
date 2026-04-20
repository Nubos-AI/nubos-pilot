'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { TASK_ID_RE, setTaskStatus } = require('../../lib/tasks.cjs');
const { findCommitByTaskId, revertCommit } = require('../../lib/git.cjs');

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const taskId = list[0];

  if (!taskId) {
    throw new NubosPilotError(
      'undo-task-missing-id',
      'undo-task requires a task full-id (e.g. M001-S001-T0001)',
      {},
    );
  }
  if (!TASK_ID_RE.test(taskId)) {
    throw new NubosPilotError(
      'undo-task-invalid-id',
      'Invalid task id: ' + taskId + ' (expected M<NNN>-S<NNN>-T<NNNN>)',
      { taskId },
    );
  }

  let sha;
  try {
    sha = findCommitByTaskId(taskId);
  } catch (err) {
    throw new NubosPilotError(
      'undo-task-commit-not-found',
      'No task commit found for id ' + taskId,
      { taskId, cause: err && err.message },
    );
  }
  if (!sha) {
    throw new NubosPilotError(
      'undo-task-commit-not-found',
      'No task commit found for id ' + taskId,
      { taskId },
    );
  }

  revertCommit(sha);

  try { setTaskStatus(taskId, 'pending', cwd); } catch (err) {
    process.stderr.write('[nubos-pilot warn] setTaskStatus failed for ' + taskId + ': ' + (err && err.message) + '\n');
  }

  const payload = { ok: true, task_id: taskId, reverted_sha: sha, status: 'pending' };
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };
