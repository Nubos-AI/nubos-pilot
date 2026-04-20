const { NubosPilotError } = require('../../lib/core.cjs');
const { TASK_ID_RE, setTaskStatus } = require('../../lib/tasks.cjs');

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const taskId = list[0];
  if (!taskId) {
    throw new NubosPilotError('unpark-missing-task-id', 'unpark requires a task full-id (e.g. M001-S001-T0001)', {});
  }
  if (!TASK_ID_RE.test(taskId)) {
    throw new NubosPilotError('unpark-invalid-task-id', 'Invalid task id: ' + taskId + ' (expected M<NNN>-S<NNN>-T<NNNN>)', { taskId });
  }
  setTaskStatus(taskId, 'pending', cwd);
  const payload = { ok: true, task_id: taskId, status: 'pending' };
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };
