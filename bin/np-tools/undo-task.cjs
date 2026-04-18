const { NubosPilotError } = require('../../lib/core.cjs');
const { TASK_ID_RE } = require('../../lib/tasks.cjs');
const { undoTask } = require('../../lib/undo.cjs');

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const taskId = list[0];
  if (!taskId) {
    throw new NubosPilotError(
      'undo-task-missing-id',
      'undo-task requires a task id (e.g. 06-01-T01)',
      {},
    );
  }
  if (!TASK_ID_RE.test(taskId)) {
    throw new NubosPilotError(
      'undo-task-invalid-id',
      'Invalid task id format: ' + taskId,
      { taskId },
    );
  }
  const result = undoTask(taskId, cwd);
  const payload = { ok: true, task_id: result.task_id, reverted_sha: result.reverted_sha };
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };
